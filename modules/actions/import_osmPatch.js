/** @import * as Osm from 'osm-api' */

import { osmNode, osmRelation, osmWay } from '../osm/index.js';
import { actionAddEntity } from './add_entity.js';
import { actionChangeTags } from './change_tags.js';
import { actionDeleteMultiple } from './delete_multiple.js';
import { actionMoveNode } from './move_node.js';
import { actionReplaceRelationMembers } from './replace_relation_members.js';


/**
 * @param {Osm.Tags} originalTags
 * @param {Osm.Tags} diff
 * @returns {Osm.Tags}
 */
function applyTagDiff(originalTags, diff) {
  const newTags = { ...originalTags };
  for (const [key, value] of Object.entries(diff)) {
    if (value === '🗑️') {
      delete newTags[key];
    } else {
      newTags[key] = `${value}`;
    }
  }
  return newTags;
}


/**
 * @typedef {{ id: string; type: Osm.OsmFeatureType; role: string }} RelationMember
 *
 * @param {RelationMember[]} originalMembers
 * @param {Osm.OsmRelation['members']} diff
 * @returns {RelationMember[]}
 */
function applyMemberDiff(originalMembers, diff) {
  let newMembersList = structuredClone(originalMembers);
  for (const item of diff) {
    const firstOldIndex = newMembersList.findIndex(
      member => member.type === item.type && +member.id.slice(1) === item.ref
    );

    if (firstOldIndex !== -1) {
      newMembersList.splice(firstOldIndex, 1);   // only replace/remove one matching occurrence
    }

    if (item.role !== '🗑️') {
      const member = {
        id: item.type[0] + item.ref,
        type: item.type,
        role: item.role
      };
      if (firstOldIndex === -1) {
        newMembersList.push(member);
      } else {
        newMembersList.splice(firstOldIndex, 0, member);
      }
    }
  }
  return newMembersList;
}


/**
 * @param {import('geojson').Geometry} geometry
 * @param {Osm.Tags} tags
 * @param {Osm.OsmRelation['members']} relationMembers
 */
function geojsonToOsmGeometry(geometry, tags, relationMembers) {
  switch (geometry.type) {
    case 'Point': {
      return [osmNode({ tags, loc: geometry.coordinates })];
    }

    case 'MultiPoint': {
      const children = geometry.coordinates.map(loc => osmNode({ loc }));
      const site = osmRelation({
        tags: { type: 'site', ...tags },
        members: children.map(child => ({
          type: child.type,
          id: child.id,
          role: ''
        }))
      });
      return [site, ...children];
    }

    case 'LineString': {
      const children = geometry.coordinates.map(loc => osmNode({ loc }));
      const way = osmWay({
        tags,
        nodes: children.map(child => child.id)
      });
      return [way, ...children];
    }

    case 'MultiLineString': {
      const nodes = [];
      const ways = [];

      for (const segment of geometry.coordinates) {
        const segmentNodes = segment.map(loc => osmNode({ loc }));
        const way = osmWay({ nodes: segmentNodes.map(n => n.id) });
        nodes.push(...segmentNodes);
        ways.push(way);
      }

      const relation = osmRelation({
        tags: { type: 'multilinestring', ...tags },
        members: ways.map(way => ({ role: '', type: 'way', id: way.id }))
      });

      return [relation, ...ways, ...nodes];
    }

    case 'GeometryCollection': {
      return [osmRelation({ tags, members: relationMembers })];
    }

    case 'Polygon':
    case 'MultiPolygon': {
      const nodes = [];
      const ways = [];

      const groups = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

      for (const rings of groups) {
        for (const [index, ring] of rings.entries()) {
          const ringNodes = ring.map(loc => osmNode({ loc }));
          if (ringNodes.length < 3) return [];

          const first = ringNodes[0];
          const last = ringNodes[ringNodes.length - 1];

          if (first.loc.join(',') === last.loc.join(',')) {
            ringNodes.pop();
            ringNodes.push(first);
          } else {
            ringNodes.push(first);
          }

          const way = osmWay({ nodes: ringNodes.map(n => n.id) });
          nodes.push(...ringNodes);
          ways.push({ way, role: index === 0 ? 'outer' : 'inner' });
        }

        if (groups.length === 1 && rings.length === 1) {
          let way = ways[0].way;
          way = way.update({ tags });
          return [way, ...nodes];
        }
      }

      const relation = osmRelation({
        tags: { type: 'multipolygon', ...tags },
        members: ways.map(({ way, role }) => ({
          type: 'way',
          id: way.id,
          role
        }))
      });
      return [relation, ...ways.map(item => item.way), ...nodes];
    }

    default:
      // eslint-disable-next-line no-unused-expressions -- exhaustivity check
      /** @satisfies {never} */ (geometry);
      return [];
  }
}


/** @param {Osm.OsmPatch} osmPatch */
export function actionImportOsmPatch(osmPatch) {
  /** @param {iD.Graph} graph */
  return graph => {
    for (const feature of osmPatch.features) {
      const {
        __action,
        __members: memberDiff,
        ...tagDiff
      } = feature.properties;

      switch (__action) {
        case undefined: {
          const entities = geojsonToOsmGeometry(feature.geometry, tagDiff, memberDiff);
          for (const entity of entities) {
            graph = actionAddEntity(entity)(graph);
          }
          break;
        }

        case 'edit': {
          const entity = graph.entity(feature.id);

          graph = actionChangeTags(feature.id, applyTagDiff(entity.tags, tagDiff))(graph);

          if (entity.type === 'relation' && memberDiff) {
            const newMembers = applyMemberDiff(entity.members, memberDiff);
            graph = actionReplaceRelationMembers(entity.id, newMembers)(graph);
          }
          break;
        }

        case 'move': {
          const nextLoc = feature.geometry?.coordinates?.[1];
          if (feature.id[0] !== 'n' || feature.geometry?.type !== 'LineString' ||
            !Array.isArray(nextLoc) || nextLoc.length < 2) {
            throw new Error('trying to move a non-node');
          }
          graph = actionMoveNode(feature.id, nextLoc)(graph);
          break;
        }

        case 'delete': {
          graph = actionDeleteMultiple([feature.id])(graph);
          break;
        }

        default:
          // eslint-disable-next-line no-unused-expressions -- exhaustivity check
          /** @satisfies {never} */ (__action);
      }
    }

    return graph;
  };
}
