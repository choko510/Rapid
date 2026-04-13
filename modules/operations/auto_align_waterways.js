import { actionAddVertex } from '../actions/add_vertex.js';
import { actionAddEntity } from '../actions/add_entity.js';
import { actionDeleteNode } from '../actions/delete_node.js';
import { actionMoveNode } from '../actions/move_node.js';
import { osmFlowingWaterwayTagValues, osmNode } from '../osm/index.js';
import { operationIsTooLarge } from './helpers/large_edit.js';
import { utilTotalExtent } from '../util/index.js';
import { filterWaterwayReferenceLines } from './auto_align_reference_lines.js';


export function operationAutoAlignWaterways(context, selectedIDs) {
  const editor = context.systems.editor;
  const graph = editor.staging.graph;
  const l10n = context.systems.l10n;
  const roadAlignment = context.services.roadAlignment;

  const entities = selectedIDs.map(entityID => graph.hasEntity(entityID)).filter(Boolean);
  const ways = entities.filter(entity => {
    const waterway = entity.tags.waterway?.toLowerCase();
    return entity.type === 'way' &&
      waterway &&
      osmFlowingWaterwayTagValues[waterway] &&
      entity.geometry(graph) === 'line';
  });
  const nodes = ways.flatMap(way => way.nodes.map(nodeID => graph.hasEntity(nodeID)).filter(Boolean));
  const coords = nodes.map(node => node.loc);
  const isNew = entities.every(entity => entity.isNew());
  const extent = utilTotalExtent(entities, graph);


  let operation = function() {
    if (!roadAlignment) return;

    const prep = roadAlignment.prepareForWays(ways, editor.staging.graph);
    if (prep.status !== 'ready') return;
    const referenceLines = filterWaterwayReferenceLines(prep.lines);
    if (!referenceLines.length) return;

    const shapePlan = roadAlignment.reshapeForWays(ways, editor.staging.graph, referenceLines);
    if (!shapePlan.ok) return;

    const annotation = operation.annotation();
    editor.beginTransaction();

    const moveNodeLocs = shapePlan.moveNodeLocs ?? new Map();
    for (const [nodeID, toLoc] of moveNodeLocs) {
      editor.perform(actionMoveNode(nodeID, toLoc));
    }

    const insertionBuckets = new Map();  // Map(wayID -> Array<{index,loc}>)
    for (const insertion of shapePlan.insertions ?? []) {
      if (!insertionBuckets.has(insertion.wayID)) {
        insertionBuckets.set(insertion.wayID, []);
      }
      insertionBuckets.get(insertion.wayID).push({ index: insertion.index, loc: insertion.loc });
    }

    for (const [wayID, insertions] of insertionBuckets) {
      let insertedCount = 0;
      insertions
        .sort((a, b) => a.index - b.index)
        .forEach(insertion => {
          const graph2 = editor.staging.graph;
          const way = graph2.hasEntity(wayID);
          if (!way) return;
          const node = osmNode({ loc: insertion.loc, tags: {} });
          const index = Math.max(0, Math.min(way.nodes.length, insertion.index + insertedCount));
          editor.perform(actionAddEntity(node));
          editor.perform(actionAddVertex(wayID, node.id, index));
          editor.perform(actionMoveNode(node.id, insertion.loc));
          insertedCount++;
        });
    }

    for (const nodeID of shapePlan.removals ?? []) {
      const graph2 = editor.staging.graph;
      if (!graph2.hasEntity(nodeID)) continue;
      editor.perform(actionDeleteNode(nodeID));
    }

    if (!moveNodeLocs.size && !(shapePlan.insertions?.length) && !(shapePlan.removals?.length)) {
      editor.endTransaction();
      return;
    }

    editor.commit({ annotation: annotation, selectedIDs: selectedIDs });
    editor.endTransaction();
    context.enter('select-osm', { selection: { osm: selectedIDs } });
  };


  operation.available = function() {
    return ways.length > 0 && ways.length === selectedIDs.length;
  };


  operation.disabled = function() {
    if (!isNew && tooLarge()) {
      return 'too_large';
    } else if (!isNew && notDownloaded()) {
      return 'not_downloaded';
    } else if (selectedIDs.some(context.hasHiddenConnections)) {
      return 'connected_to_hidden';
    }

    if (!roadAlignment) return 'reference_service_unavailable';
    const prep = roadAlignment.prepareForWays(ways, editor.staging.graph);
    if (prep.status !== 'ready') return prep.reason || 'reference_loading';
    const referenceLines = filterWaterwayReferenceLines(prep.lines);
    if (!referenceLines.length) return 'no_reference_data';
    const shapePlan = roadAlignment.reshapeForWays(ways, editor.staging.graph, referenceLines);
    return shapePlan.ok ? false : shapePlan.reason;

    // If the selection is not 80% contained in view
    function tooLarge() {
      return operationIsTooLarge(context, extent);
    }

    // If the selection spans tiles that haven't been downloaded yet
    function notDownloaded() {
      if (context.inIntro) return false;
      const osm = context.services.osm;
      if (osm) {
        const missing = coords.filter(loc => !osm.isDataLoaded(loc));
        if (missing.length) {
          missing.forEach(loc => context.loadTileAtLoc(loc));
          return true;
        }
      }
      return false;
    }
  };


  operation.tooltip = function() {
    const disabledReason = operation.disabled();
    return disabledReason ?
      l10n.t(`operations.auto_align_waterways.${disabledReason}`, { n: selectedIDs.length }) :
      l10n.t('operations.auto_align_waterways.description', { n: selectedIDs.length });
  };


  operation.annotation = function() {
    return l10n.t('operations.auto_align_waterways.annotation', { n: selectedIDs.length });
  };


  operation.id = 'auto_align_waterways';
  operation.keys = [];
  operation.title = l10n.t('operations.auto_align_waterways.title');

  return operation;
}
