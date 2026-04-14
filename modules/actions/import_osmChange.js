/** @import * as Osm from 'osm-api' */

import { osmNode, osmRelation, osmWay } from '../osm/index.js';
import { actionAddEntity } from './add_entity.js';
import { actionChangeTags } from './change_tags.js';
import { actionDeleteMultiple } from './delete_multiple.js';
import { actionMoveNode } from './move_node.js';
import { actionReplaceRelationMembers } from './replace_relation_members.js';
import { actionReplaceWayNodes } from './replace_way_nodes.js';


/**
 * A map of IDs from imported files to IDs in the current graph.
 * @typedef {Record<Osm.OsmFeatureType, Record<number, string>>} IDMap
 */


/**
 * @param {Osm.OsmFeatureType} type
 * @param {number} id
 * @param {IDMap} idMap
 * @returns {string}
 */
function getID(type, id, idMap) {
  const mappedID = id > 0 ? type[0] + id : idMap[type][id];
  if (mappedID === undefined) {
    throw new Error(`No entry in idMap for ${type} ${id}`);
  }
  return mappedID;
}


/**
 * @param {Osm.OsmChange} osmChange
 * @param {boolean} allowConflicts
 */
export function actionImportOsmChange(osmChange, allowConflicts) {
  /** @param {iD.Graph} graph */
  return graph => {
    /** @type {IDMap} */
    const idMap = { node: {}, way: {}, relation: {} };

    // Check version mismatches for modify/delete before applying changes.
    if (!allowConflicts) {
      for (const feature of [...osmChange.modify, ...osmChange.delete]) {
        const entityID = getID(feature.type, feature.id, idMap);
        const entity = graph.hasEntity(entityID);
        if (!entity) {
          throw new Error(`Conflicts on ${entityID}, entity not found locally`);
        }
        if (+entity.version !== feature.version) {
          throw new Error(
            `Conflicts on ${entityID}, expected v${feature.version}, got v${entity.version}`
          );
        }
      }
    }

    // Create placeholders first so every new entity has an allocated ID.
    for (const feature of osmChange.create) {
      switch (feature.type) {
        case 'node': {
          const entity = osmNode({
            tags: feature.tags,
            loc: [feature.lon, feature.lat]
          });
          idMap[feature.type][feature.id] = entity.id;
          graph = actionAddEntity(entity)(graph);
          break;
        }

        case 'way': {
          const entity = osmWay({
            tags: feature.tags,
            nodes: []
          });
          idMap[feature.type][feature.id] = entity.id;
          graph = actionAddEntity(entity)(graph);
          break;
        }

        case 'relation': {
          const entity = osmRelation({
            tags: feature.tags,
            members: []
          });
          idMap[feature.type][feature.id] = entity.id;
          graph = actionAddEntity(entity)(graph);
          break;
        }

        default:
          // eslint-disable-next-line no-unused-expressions -- exhaustivity check
          /** @satisfies {never} */ (feature);
      }
    }

    // Apply tags and geometry/member updates to create+modify sets.
    for (const feature of [...osmChange.create, ...osmChange.modify]) {
      const entityID = getID(feature.type, feature.id, idMap);

      graph = actionChangeTags(entityID, feature.tags)(graph);

      switch (feature.type) {
        case 'node':
          graph = actionMoveNode(entityID, [feature.lon, feature.lat])(graph);
          break;

        case 'way': {
          const newNodeIDs = feature.nodes.map(nodeID => getID('node', nodeID, idMap));
          graph = actionReplaceWayNodes(entityID, newNodeIDs)(graph);
          break;
        }

        case 'relation': {
          const newMembers = feature.members.map(member => ({
            id: getID(member.type, member.ref, idMap),
            role: member.role,
            type: member.type
          }));
          graph = actionReplaceRelationMembers(entityID, newMembers)(graph);
          break;
        }

        default:
          // eslint-disable-next-line no-unused-expressions -- exhaustivity check
          /** @satisfies {never} */ (feature);
      }
    }

    const deleteIDs = osmChange.delete.map(feature => getID(feature.type, feature.id, idMap));
    graph = actionDeleteMultiple(deleteIDs)(graph);

    return graph;
  };
}
