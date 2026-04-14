/** @import * as Osm from 'osm-api' */

import { utilArrayChunk, utilArrayUniq } from '@rapid-sdk/util';
import { parseOsmChangeXml } from 'osm-api';

import { actionImportOsmChange, actionImportOsmPatch } from '../actions/index.js';
import { uploadFile } from '../util/index.js';


/**
 * @param {string[]} entityIDs
 * @returns {number}
 */
function countLoadMultipleRequests(entityIDs) {
  let nodeCount = 0;
  let wayCount = 0;
  let relationCount = 0;

  for (const entityID of entityIDs) {
    switch (entityID[0]) {
      case 'n': nodeCount++; break;
      case 'w': wayCount++; break;
      case 'r': relationCount++; break;
    }
  }

  return (
    Math.ceil(nodeCount / 150) +
    Math.ceil(wayCount / 150) +
    Math.ceil(relationCount / 150)
  );
}


/**
 * @param {string[]} entityIDs
 * @returns {{ nodes: string[], ways: string[], relations: string[] }}
 */
function partitionEntityIDs(entityIDs) {
  const nodes = [];
  const ways = [];
  const relations = [];

  for (const entityID of entityIDs) {
    switch (entityID[0]) {
      case 'n': nodes.push(entityID); break;
      case 'w': ways.push(entityID); break;
      case 'r': relations.push(entityID); break;
    }
  }

  return { nodes, ways, relations };
}


/**
 * @param {{ loadMultiple: (entityIDs: string[], callback: (err?: Error) => void) => void }} osm
 * @param {string[]} entityIDs
 * @returns {Promise<void>}
 */
function loadMultipleAsync(osm, entityIDs) {
  const uniqueIDs = utilArrayUniq(entityIDs);
  const requestCount = countLoadMultipleRequests(uniqueIDs);
  if (!requestCount) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = requestCount;

    osm.loadMultiple(uniqueIDs, err => {
      if (settled) return;

      if (err) {
        settled = true;
        reject(err);
        return;
      }

      remaining -= 1;
      if (remaining <= 0) {
        settled = true;
        resolve();
      }
    });
  });
}


/**
 * @param {iD.Context} context
 * @param {string[]} entityIDs
 * @param {number} [chunkSize]
 * @returns {Promise<void>}
 */
async function loadEntitiesFull(context, entityIDs, chunkSize = 10) {
  const chunks = utilArrayChunk(utilArrayUniq(entityIDs), chunkSize);
  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(entityID => context.loadEntity(entityID).catch(() => undefined))
    );
  }
}


/**
 * Download all entities that will be modified/deleted by the import.
 * Uses batched API calls for nodes and full-entity loading for ways/relations.
 * @param {iD.Context} context
 * @param {string[]} entityIDs
 * @param {string[]} [requiredEntityIDs]
 * @returns {Promise<void>}
 */
async function downloadFeatures(context, entityIDs, requiredEntityIDs = []) {
  const getGraph = () => context.systems.editor.staging.graph;
  const missingIDs = utilArrayUniq(entityIDs).filter(entityID => !getGraph().hasEntity(entityID));
  if (!missingIDs.length && !requiredEntityIDs.length) return;

  const { nodes, ways, relations } = partitionEntityIDs(missingIDs);

  const osm = context.services.osm;
  if (osm && nodes.length) {
    await loadMultipleAsync(osm, nodes);
  }

  // Ways and relations need full payloads so graph connectivity stays valid for edits/validation.
  if (ways.length || relations.length) {
    await loadEntitiesFull(context, [...ways, ...relations], 20);
  }

  // Ensure way child nodes are present (loadMultiple doesn't fetch nested children).
  if (osm && ways.length) {
    const graph = getGraph();
    const wayNodeIDs = [];
    for (const wayID of ways) {
      const way = graph.hasEntity(wayID);
      if (!way?.nodes) continue;
      for (const nodeID of way.nodes) {
        if (!graph.hasEntity(nodeID)) {
          wayNodeIDs.push(nodeID);
        }
      }
    }
    if (wayNodeIDs.length) {
      await loadMultipleAsync(osm, wayNodeIDs);
    }
  }

  // Strictly load IDs needed by modify/move operations and referenced members/nodes.
  const requiredIDs = utilArrayUniq(requiredEntityIDs);
  const missingRequiredIDs = requiredIDs.filter(entityID => !getGraph().hasEntity(entityID));
  if (missingRequiredIDs.length) {
    await loadEntitiesFull(context, missingRequiredIDs, 10);
  }

  const stillMissingRequired = requiredIDs.filter(entityID => !getGraph().hasEntity(entityID));
  if (stillMissingRequired.length) {
    const sample = stillMissingRequired.slice(0, 5).join(', ');
    throw new Error(`Failed to load entities required for import: ${sample}`);
  }
}


/**
 * @param {Osm.OsmChange} osmChange
 * @returns {{ entityIDs: string[], requiredIDs: string[] }}
 */
function collectOsmChangePrefetchIDs(osmChange) {
  const targetIDs = [...osmChange.modify, ...osmChange.delete]
    .map(feature => feature.type[0] + feature.id);

  const referencedIDs = [];
  for (const feature of [...osmChange.create, ...osmChange.modify]) {
    if (feature.type === 'way') {
      for (const nodeID of feature.nodes ?? []) {
        if (nodeID > 0) {
          referencedIDs.push(`n${nodeID}`);
        }
      }

    } else if (feature.type === 'relation') {
      for (const member of feature.members ?? []) {
        if (member.ref > 0) {
          referencedIDs.push(member.type[0] + member.ref);
        }
      }
    }
  }

  return {
    entityIDs: [...targetIDs, ...referencedIDs],
    requiredIDs: [...osmChange.modify.map(feature => feature.type[0] + feature.id), ...referencedIDs]
  };
}


/**
 * @param {Osm.OsmPatch} osmPatch
 * @returns {{ entityIDs: string[], requiredIDs: string[] }}
 */
function collectOsmPatchPrefetchIDs(osmPatch) {
  const actionEntityIDs = [];
  const requiredActionIDs = [];
  const referencedIDs = [];

  for (const feature of osmPatch.features) {
    const action = feature.properties.__action;
    if (action) {
      actionEntityIDs.push(/** @type {string} */ (feature.id));
      if (action !== 'delete') {
        requiredActionIDs.push(/** @type {string} */ (feature.id));
      }
    }

    const members = feature.properties.__members;
    if (!Array.isArray(members)) continue;

    for (const member of members) {
      if (member?.role === '🗑️') continue;
      if (member?.ref > 0 && member?.type) {
        referencedIDs.push(member.type[0] + member.ref);
      }
    }
  }

  return {
    entityIDs: [...actionEntityIDs, ...referencedIDs],
    requiredIDs: [...requiredActionIDs, ...referencedIDs]
  };
}


/**
 * @param {iD.Context} context
 * @param {File} file
 * @param {boolean} allowConflicts
 * @returns {Promise<void>}
 */
async function processFile(context, file, allowConflicts) {
  const editor = context.systems.editor;
  const l10n = context.systems.l10n;
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.osc')) {
    const osmChange = parseOsmChangeXml(await file.text());
    context.defaultChangesetTags(osmChange.changeset?.tags ?? {});
    const { entityIDs, requiredIDs } = collectOsmChangePrefetchIDs(osmChange);

    await downloadFeatures(context, entityIDs, requiredIDs);

    const annotation = {
      type: 'import_from_file',
      description: l10n.t('operations.import_from_file.annotation.osmChange'),
      dataUsed: ['.osmChange data file']
    };

    editor.perform(actionImportOsmChange(osmChange, allowConflicts));
    editor.commit({ annotation });
    return;
  }

  if (lowerName.endsWith('.osmpatch.geo.json')) {
    /** @type {Osm.OsmPatch} */
    const osmPatch = JSON.parse(await file.text());
    context.defaultChangesetTags(osmPatch.changesetTags ?? {});
    const { entityIDs, requiredIDs } = collectOsmPatchPrefetchIDs(osmPatch);

    await downloadFeatures(context, entityIDs, requiredIDs);

    const annotation = {
      type: 'import_from_file',
      description: l10n.t('operations.import_from_file.annotation.osmPatch'),
      dataUsed: ['.osmPatch data file']
    };

    editor.perform(actionImportOsmPatch(osmPatch));
    editor.commit({ annotation });
  }
}


/**
 * @param {iD.Context} context
 * @param {boolean} allowConflicts
 * @param {() => void} [onLoadingStart]
 */
export async function operationImportFile(context, allowConflicts, onLoadingStart) {
  const files = await uploadFile({
    accept: '.osc,.osmPatch.geo.json',
    multiple: true
  });
  if (!files.length) return;

  onLoadingStart?.();

  for (const file of files) {
    await processFile(context, file, allowConflicts);
  }
}
