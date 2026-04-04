import { utilGetAllNodes } from '@rapid-sdk/util';

import { actionSimplify } from '../actions/simplify.js';
import { utilTotalExtent } from '../util/index.js';


export function operationSimplify(context, selectedIDs) {
  const editor = context.systems.editor;
  const graph = editor.staging.graph;
  const l10n = context.systems.l10n;
  const storage = context.systems.storage;
  const viewport = context.viewport;

  const entities = selectedIDs.map(entityID => graph.hasEntity(entityID)).filter(Boolean);
  const isNew = entities.every(entity => entity.isNew());
  const extent = utilTotalExtent(entities, graph);
  const actions = entities.map(getAction).filter(Boolean);
  const coords = utilGetAllNodes(selectedIDs, graph).map(node => node.loc);


  function getAction(entity) {
    if (entity.type !== 'way') return null;

    const geometry = entity.geometry(graph);
    if (geometry !== 'line' && geometry !== 'area') return null;

    const minNodes = entity.isClosed() ? 3 : 2;
    if (new Set(entity.nodes).size <= minNodes) return null;

    return actionSimplify(entity.id, context.viewport);
  }


  let operation = function() {
    if (!actions.length) return;

    const combinedAction = graph => {
      for (const action of actions) {
        if (!action.disabled(graph)) {
          graph = action(graph);
        }
      }
      return graph;
    };

    const annotation = operation.annotation();
    editor.perform(combinedAction);
    editor.commit({ annotation: annotation, selectedIDs: selectedIDs });
  };


  operation.available = function() {
    return actions.length && selectedIDs.length === actions.length;
  };


  operation.disabled = function() {
    if (!actions.length) return '';

    const graph = editor.staging.graph;
    const disabledReasons = actions.map(action => action.disabled(graph)).filter(Boolean);
    if (disabledReasons.length === actions.length) {
      if (new Set(disabledReasons).size > 1) {
        return 'multiple_blockers';
      }
      return disabledReasons[0];
    } else if (!isNew && tooLarge()) {
      return 'too_large';
    } else if (!isNew && notDownloaded()) {
      return 'not_downloaded';
    } else if (selectedIDs.some(context.hasHiddenConnections)) {
      return 'connected_to_hidden';
    }

    return false;

    // If the selection is not 80% contained in view
    function tooLarge() {
      const allowLargeEdits = storage.getItem('rapid-internal-feature.allowLargeEdits') === 'true';
      return !allowLargeEdits && extent.percentContainedIn(viewport.visibleExtent()) < 0.8;
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
      l10n.t(`operations.simplify.${disabledReason}`, { n: selectedIDs.length }) :
      l10n.t('operations.simplify.description', { n: selectedIDs.length });
  };


  operation.annotation = function() {
    return l10n.t('operations.simplify.annotation', { n: actions.length });
  };


  operation.id = 'simplify';
  operation.keys = [];
  operation.title = l10n.t('operations.simplify.title');

  return operation;
}
