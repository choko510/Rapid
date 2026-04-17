import { geoArea as d3_geoArea } from 'd3-geo';
import { geoSphericalDistance, geomPointInPolygon } from '@rapid-sdk/math';
import { utilArrayUniq } from '@rapid-sdk/util';

import { actionConnect } from '../actions/connect.js';
import { actionMergePolygon } from '../actions/merge_polygon.js';


const DOCK_THRESHOLD_METERS = 0.2;


export function operationDockPondToForest(context, selectedIDs) {
  const editor = context.systems.editor;
  const l10n = context.systems.l10n;


  function _isFiniteCoordinate(coord) {
    return Array.isArray(coord) &&
      coord.length >= 2 &&
      Number.isFinite(coord[0]) &&
      Number.isFinite(coord[1]);
  }


  function _sameCoordinate(a, b) {
    return a?.[0] === b?.[0] && a?.[1] === b?.[1];
  }


  function _normalizeRing(rawCoords) {
    if (!Array.isArray(rawCoords)) return null;

    const ring = [];
    for (const rawCoord of rawCoords) {
      if (!_isFiniteCoordinate(rawCoord)) continue;

      const coord = [Number(rawCoord[0]), Number(rawCoord[1])];
      const prev = ring[ring.length - 1];
      if (prev && _sameCoordinate(prev, coord)) continue;
      ring.push(coord);
    }

    if (ring.length < 3) return null;

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!_sameCoordinate(first, last)) {
      ring.push([first[0], first[1]]);
    }

    const unique = new Set(
      ring.slice(0, -1).map(coord => `${coord[0]},${coord[1]}`)
    );
    if (unique.size < 3) return null;

    return ring;
  }


  function _normalizePolygon(rawRings) {
    if (!Array.isArray(rawRings) || !rawRings.length) return null;

    const outer = _normalizeRing(rawRings[0]);
    if (!outer) return null;

    const inners = rawRings.slice(1)
      .map(_normalizeRing)
      .filter(Boolean);

    return [outer, ...inners];
  }


  function _geometryToPolygons(geometry) {
    const polygons = [];
    if (!geometry || typeof geometry !== 'object') return polygons;

    if (geometry.type === 'Polygon') {
      const polygon = _normalizePolygon(geometry.coordinates);
      if (polygon) polygons.push(polygon);
      return polygons;
    }

    if (geometry.type === 'MultiPolygon') {
      for (const rawPolygon of geometry.coordinates ?? []) {
        const polygon = _normalizePolygon(rawPolygon);
        if (polygon) polygons.push(polygon);
      }
      return polygons;
    }

    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries ?? []) {
        polygons.push(..._geometryToPolygons(child));
      }
    }

    return polygons;
  }


  function _entityToPolygons(entity, graph) {
    if (!entity || !graph) return [];

    if (entity.type === 'way') {
      if (entity.nodes.some(nodeID => !graph.hasEntity(nodeID))) return [];
    } else if (entity.type === 'relation') {
      if (typeof entity.isComplete === 'function' && !entity.isComplete(graph)) return [];
    }

    let geometry = entity.asGeoJSON(graph);
    if (entity.type === 'way' && entity.isClosed() && geometry?.type === 'LineString') {
      geometry = {
        type: 'Polygon',
        coordinates: [geometry.coordinates]
      };
    }

    return _geometryToPolygons(geometry);
  }


  function _isPondEntity(entity) {
    if (!entity || entity.type !== 'way') return false;
    if (!entity.isClosed()) return false;

    const tags = entity.tags ?? {};
    return (
      tags.landuse === 'pond' ||
      tags.landuse === 'reservoir' ||
      (tags.natural === 'water' && (tags.water === 'pond' || tags.water === 'reservoir'))
    );
  }


  function _hasForestTags(tags = {}) {
    return (
      tags.landuse === 'forest' ||
      tags.landuse === 'plantation' ||
      tags.natural === 'wood'
    );
  }


  function _isForestEntity(entity, graph) {
    if (!entity) return false;

    if (entity.type === 'way') {
      return entity.isClosed() && _hasForestTags(entity.tags);
    }

    if (entity.type === 'relation' && entity.isMultipolygon()) {
      if (_hasForestTags(entity.tags)) return true;

      // Support old-style multipolygons where tags may still be on outer members.
      const outerMembers = entity.members.filter(member => member.type === 'way' && member.role !== 'inner');
      return outerMembers.some(member => {
        const way = graph.hasEntity(member.id);
        return way && _hasForestTags(way.tags);
      });
    }

    return false;
  }


  function _polygonContainsPoint(polygon, point) {
    if (!Array.isArray(polygon) || !polygon.length) return false;

    const outer = polygon[0];
    if (!geomPointInPolygon(point, outer)) return false;

    for (const inner of polygon.slice(1)) {
      if (geomPointInPolygon(point, inner)) {
        return false;  // point is in a hole
      }
    }

    return true;
  }


  function _polygonContainsRing(containerPolygon, ring) {
    if (!Array.isArray(ring) || ring.length < 4) return false;

    for (const coord of ring.slice(0, -1)) {
      if (!_polygonContainsPoint(containerPolygon, coord)) {
        return false;
      }
    }
    return true;
  }


  function _forestContainsPond(forestPolygons, pondPolygons) {
    if (!forestPolygons.length || !pondPolygons.length) return false;

    for (const pondPolygon of pondPolygons) {
      const pondOuter = pondPolygon[0];
      const contained = forestPolygons.some(forestPolygon => _polygonContainsRing(forestPolygon, pondOuter));
      if (!contained) return false;
    }

    return true;
  }


  function _polygonsArea(polygons) {
    const area = d3_geoArea({
      type: 'MultiPolygon',
      coordinates: polygons
    });
    return Number.isFinite(area) ? Math.abs(area) : Number.POSITIVE_INFINITY;
  }


  function _outerWayIDs(entity, graph) {
    if (!entity) return [];

    if (entity.type === 'way') {
      return [entity.id];
    }

    if (entity.type === 'relation' && entity.isMultipolygon()) {
      return utilArrayUniq(
        entity.members
          .filter(member => member.type === 'way' && member.role !== 'inner')
          .map(member => member.id)
          .filter(wayID => !!graph.hasEntity(wayID))
      );
    }

    return [];
  }


  function _nodeIDsForWays(graph, wayIDs) {
    const nodeIDs = [];
    for (const wayID of wayIDs) {
      const way = graph.hasEntity(wayID);
      if (!way || way.type !== 'way') continue;
      nodeIDs.push(...way.nodes);
    }
    return utilArrayUniq(nodeIDs);
  }


  function _findDockPairs(graph, pondWayIDs, forestWayIDs) {
    const pondNodeIDs = _nodeIDsForWays(graph, pondWayIDs)
      .filter(nodeID => !!graph.hasEntity(nodeID));

    const forestNodeIDs = _nodeIDsForWays(graph, forestWayIDs)
      .filter(nodeID => !!graph.hasEntity(nodeID));

    const candidates = [];

    for (const pondNodeID of pondNodeIDs) {
      const pondNode = graph.hasEntity(pondNodeID);
      if (!pondNode?.loc) continue;

      for (const forestNodeID of forestNodeIDs) {
        if (pondNodeID === forestNodeID) continue;

        const forestNode = graph.hasEntity(forestNodeID);
        if (!forestNode?.loc) continue;

        const distance = geoSphericalDistance(pondNode.loc, forestNode.loc);
        if (!Number.isFinite(distance) || distance > DOCK_THRESHOLD_METERS) continue;

        candidates.push({
          pondNodeID: pondNodeID,
          forestNodeID: forestNodeID,
          distance: distance
        });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    const usedPondNodes = new Set();
    const usedForestNodes = new Set();
    const pairs = [];

    for (const candidate of candidates) {
      if (usedPondNodes.has(candidate.pondNodeID)) continue;
      if (usedForestNodes.has(candidate.forestNodeID)) continue;

      pairs.push(candidate);
      usedPondNodes.add(candidate.pondNodeID);
      usedForestNodes.add(candidate.forestNodeID);
    }

    return pairs;
  }


  function _computeState(graph) {
    if (!Array.isArray(selectedIDs) || selectedIDs.length !== 1) {
      return { reason: 'no_single_pond' };
    }

    const pondID = selectedIDs[0];
    const pondEntity = graph.hasEntity(pondID);
    if (!pondEntity) {
      return { reason: 'selection_missing' };
    }
    if (!_isPondEntity(pondEntity)) {
      return { reason: 'selected_not_pond' };
    }

    const pondPolygons = _entityToPolygons(pondEntity, graph);
    if (!pondPolygons.length) {
      return { reason: 'invalid_pond_geometry' };
    }

    const searchExtent = pondEntity.extent(graph);
    const containingForests = [];
    for (const candidate of editor.intersects(searchExtent)) {
      if (!candidate || candidate.id === pondEntity.id) continue;
      if (!_isForestEntity(candidate, graph)) continue;

      const forestPolygons = _entityToPolygons(candidate, graph);
      if (!forestPolygons.length) continue;
      if (!_forestContainsPond(forestPolygons, pondPolygons)) continue;

      containingForests.push({
        entity: candidate,
        polygons: forestPolygons,
        area: _polygonsArea(forestPolygons)
      });
    }

    if (!containingForests.length) {
      return { reason: 'no_containing_forest' };
    }

    containingForests.sort((a, b) => a.area - b.area);
    const forest = containingForests[0];
    const forestEntity = forest.entity;

    const mergeAction = actionMergePolygon([forestEntity.id, pondEntity.id]);
    const mergeReason = mergeAction.disabled(graph);
    if (mergeReason) {
      return { reason: `merge_${mergeReason}` };
    }

    const pondWayIDs = _outerWayIDs(pondEntity, graph);
    const forestWayIDs = _outerWayIDs(forestEntity, graph);

    const dockPairs = _findDockPairs(graph, pondWayIDs, forestWayIDs);
    for (const dockPair of dockPairs) {
      const connect = actionConnect([dockPair.pondNodeID, dockPair.forestNodeID]);
      if (connect.disabled(graph)) {
        return { reason: 'docking_conflict' };
      }
    }

    return {
      reason: null,
      pondID: pondEntity.id,
      forestID: forestEntity.id,
      pondWayIDs: pondWayIDs,
      mergeAction: mergeAction,
      dockPairs: dockPairs
    };
  }


  let operation = function() {
    const graph = editor.staging.graph;
    const state = _computeState(graph);
    if (state.reason) return;

    editor.beginTransaction();

    editor.perform(state.mergeAction);

    for (const dockPair of state.dockPairs) {
      const connect = actionConnect([dockPair.pondNodeID, dockPair.forestNodeID]);
      if (!connect.disabled(editor.staging.graph)) {
        editor.perform(connect);
      }
    }

    const graph2 = editor.staging.graph;
    let nextSelectedIDs = [];

    if (graph2.hasEntity(state.pondID)) {
      nextSelectedIDs = [state.pondID];
    } else if (graph2.hasEntity(state.forestID)) {
      nextSelectedIDs = [state.forestID];
    } else {
      const survivingPondWayID = state.pondWayIDs.find(wayID => !!graph2.hasEntity(wayID));
      if (survivingPondWayID) {
        nextSelectedIDs = [survivingPondWayID];
      }
    }

    if (!nextSelectedIDs.length) {
      nextSelectedIDs = selectedIDs.filter(entityID => !!graph2.hasEntity(entityID));
    }

    editor.commit({
      annotation: operation.annotation(),
      selectedIDs: nextSelectedIDs
    });
    editor.endTransaction();

    if (nextSelectedIDs.length) {
      context.enter('select-osm', { selection: { osm: nextSelectedIDs } });
    }
  };


  operation.available = function() {
    const graph = editor.staging.graph;
    if (!Array.isArray(selectedIDs) || selectedIDs.length !== 1) return false;

    const entity = graph.hasEntity(selectedIDs[0]);
    return _isPondEntity(entity);
  };


  operation.disabled = function() {
    const state = _computeState(editor.staging.graph);
    return state.reason || false;
  };


  operation.tooltip = function() {
    const disabledReason = operation.disabled();
    return disabledReason ?
      l10n.t(`operations.dock_pond_to_forest.${disabledReason}`) :
      l10n.t('operations.dock_pond_to_forest.description');
  };


  operation.annotation = function() {
    return l10n.t('operations.dock_pond_to_forest.annotation');
  };


  operation.id = 'dock_pond_to_forest';
  operation.keys = [];
  operation.title = l10n.t('operations.dock_pond_to_forest.title');

  return operation;
}

