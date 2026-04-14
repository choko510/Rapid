import { utilArrayGroupBy } from '@rapid-sdk/util';

import { actionChangeTags, actionDeleteNode } from '../actions/index.js';
import { KeyOperationBehavior } from '../behaviors/KeyOperationBehavior.js';


export function operationContinue(context, selectedIDs) {
  const editor = context.systems.editor;
  const graph = editor.staging.graph;
  const filters = context.systems.filters;
  const l10n = context.systems.l10n;

  const entities = selectedIDs.map(entityID => graph.hasEntity(entityID)).filter(Boolean);
  const geometries = Object.assign(
    { area: [], line: [], vertex: [] },
    utilArrayGroupBy(entities, entity => entity.geometry(graph))
  );
  const continueFromNode = geometries.vertex.length === 1 && geometries.vertex[0];
  const candidates = candidateWays();


  function candidateWays() {
    if (!continueFromNode) return [];
    const hasSemanticNodeData = (
      continueFromNode.hasInterestingTags() ||
      graph.parentRelations(continueFromNode).length > 0
    );

    return graph.parentWays(continueFromNode).filter(parent => {
      const geometry = parent.geometry(graph);
      const isSupportedGeometry = (geometry === 'line' || geometry === 'area');
      if (!isSupportedGeometry || !parent.contains(continueFromNode.id)) return false;

      // Interior-node continuation replaces that node.
      // Don't allow this when the node has semantic data to preserve.
      const isInteriorNode = !parent.affix(continueFromNode.id);
      if (isInteriorNode && hasSemanticNodeData) return false;

      return (
        (geometries.line.length === 0 || geometries.line[0] === parent) &&
        (geometries.area.length === 0 || geometries.area[0] === parent)
      );
    });
  }

  function candidateGeometry() {
    return candidates[0]?.geometry(editor.staging.graph) ?? 'line';
  }


  let operation = function() {
    if (!candidates.length) return;
    const candidate = candidates[0];
    const geometry = candidateGeometry();
    const originalNodeID = continueFromNode.id;
    const affix = candidate.affix(originalNodeID);
    const continueNodeIndex = (!affix) ? candidate.nodes.indexOf(originalNodeID) : null;
    let continueNodeID = originalNodeID;

    // If continuing from an endpoint tagged as a dead-end marker, clear those
    // tags before entering draw mode because the endpoint is no longer terminal.
    const newTags = { ...continueFromNode.tags };
    let removedDeadEndTags = false;

    if (newTags.fixme === 'continue') {
      delete newTags.fixme;
      removedDeadEndTags = true;
    }
    if (newTags.noexit === 'yes') {
      delete newTags.noexit;
      removedDeadEndTags = true;
    }

    if (removedDeadEndTags) {
      editor.perform(actionChangeTags(continueFromNode.id, newTags));
      editor.commit({ annotation: operation.annotation(), selectedIDs: [continueFromNode.id] });
    }

    // Continuing from a non-endpoint replaces that vertex with newly drawn geometry.
    if (!affix) {
      editor.perform(actionDeleteNode(originalNodeID));
      continueNodeID = null;
    }

    if (geometry === 'area') {
      context.enter('draw-area', {
        continueWayID: candidate.id,
        continueNodeID: continueNodeID,
        continueNodeIndex: continueNodeIndex
      });
    } else {
      context.enter('draw-line', {
        continueWayID: candidate.id,
        continueNodeID: continueNodeID,
        continueNodeIndex: continueNodeIndex,
        continueFromAffix: affix
      });
    }
  };


  operation.relatedEntityIds = function() {
    return candidates.length ? [candidates[0].id] : [];
  };


  operation.available = function() {
    const graph = context.systems.editor.staging.graph;
    const parentSelections = geometries.line.length + geometries.area.length;
    return geometries.vertex.length === 1 && parentSelections <= 1 &&
      !filters.hasHiddenConnections(continueFromNode, graph);
  };


  operation.disabled = function() {
    if (candidates.length === 0) {
      return 'not_eligible';
    } else if (candidates.length > 1) {
      return 'multiple';
    }

    return false;
  };


  operation.tooltip = function() {
    const disabledReason = operation.disabled();
    return disabledReason ?
      l10n.t(`operations.continue.${disabledReason}`) :
      l10n.t(`operations.continue.description.${candidateGeometry()}`);
  };


  operation.annotation = function() {
    return l10n.t(`operations.continue.annotation.${candidateGeometry()}`);
  };


  operation.id = 'continue';
  operation.keys = [ l10n.t('shortcuts.command.continue_line.key') ];
  operation.title = l10n.t('operations.continue.title');
  operation.behavior = new KeyOperationBehavior(context, operation);

  return operation;
}
