import { geoArea as d3_geoArea } from 'd3-geo';
import { geomPointInPolygon } from '@rapid-sdk/math';

import { actionAddEntity } from '../actions/add_entity.js';
import { osmNode, osmRelation, osmWay } from '../osm/index.js';
import { utilFetchResponse } from '../util/index.js';

const WATER_QUERY_ZOOM = 16;
const WATER_TAGS = Object.freeze({ natural: 'water', water: 'pond' });


export function operationCreateWaterFromReference(context) {
  const editor = context.systems.editor;
  const l10n = context.systems.l10n;
  const ui = context.systems.ui;
  const viewport = context.viewport;

  let _point = null;                 // [x,y] map-coordinate where menu opened
  let _loading = false;
  let _disabledReason = 'no_anchor_point';
  let _selectedPolygons = null;      // Array<PolygonRings>, picked feature geometry
  let _requestToken = 0;
  let _controller = null;


  function _redrawEditMenu() {
    ui?.redrawEditMenu?.();
  }


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


  function _selectContainingPolygons(data, pointLoc) {
    const features = [];
    if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
      features.push(...data.features);
    } else if (data?.type === 'Feature') {
      features.push(data);
    }

    let hasPolygonGeometry = false;
    const containing = [];

    for (const feature of features) {
      const polygons = _geometryToPolygons(feature?.geometry);
      if (!polygons.length) continue;
      hasPolygonGeometry = true;

      const containsPoint = polygons.some(polygon => _polygonContainsPoint(polygon, pointLoc));
      if (!containsPoint) continue;

      const featureArea = Math.abs(d3_geoArea({
        type: 'MultiPolygon',
        coordinates: polygons
      }));

      containing.push({
        polygons: polygons,
        area: Number.isFinite(featureArea) ? featureArea : Number.POSITIVE_INFINITY
      });
    }

    if (!hasPolygonGeometry) {
      return { polygons: null, reason: 'no_reference_data' };
    }
    if (!containing.length) {
      return { polygons: null, reason: 'no_containing_water' };
    }

    // If multiple shapes contain the click, use the smallest containing one.
    containing.sort((a, b) => a.area - b.area);
    return { polygons: containing[0].polygons, reason: null };
  }


  function _createWayFromRing(ring, tags = {}) {
    if (!Array.isArray(ring) || ring.length < 4) return null;

    const ringCoords = ring.slice(0, -1);  // omit duplicated closing coordinate
    if (ringCoords.length < 3) return null;

    const nodes = ringCoords.map(loc => osmNode({ loc: loc, tags: {} }));
    const nodeIDs = nodes.map(node => node.id);
    nodeIDs.push(nodeIDs[0]);  // close the way

    const way = osmWay({
      nodes: nodeIDs,
      tags: Object.assign({}, tags)
    });

    return { nodes: nodes, way: way };
  }


  function _buildWaterEntities(polygons) {
    if (!Array.isArray(polygons) || !polygons.length) return null;

    const hasInnerRings = polygons.some(polygon => polygon.length > 1);

    // Single outer ring: create a plain closed way with water tags.
    if (polygons.length === 1 && !hasInnerRings) {
      const built = _createWayFromRing(polygons[0][0], WATER_TAGS);
      if (!built) return null;

      const entities = [...built.nodes, built.way];
      return { entities: entities, selectedIDs: [built.way.id] };
    }

    // MultiPolygon / holes: create ways + a multipolygon relation with water tags.
    const entities = [];
    const members = [];

    for (const polygon of polygons) {
      const outerBuilt = _createWayFromRing(polygon[0], {});
      if (!outerBuilt) continue;

      entities.push(...outerBuilt.nodes, outerBuilt.way);
      members.push({ id: outerBuilt.way.id, type: 'way', role: 'outer' });

      for (const innerRing of polygon.slice(1)) {
        const innerBuilt = _createWayFromRing(innerRing, {});
        if (!innerBuilt) continue;

        entities.push(...innerBuilt.nodes, innerBuilt.way);
        members.push({ id: innerBuilt.way.id, type: 'way', role: 'inner' });
      }
    }

    if (!members.some(member => member.role === 'outer')) return null;

    const relation = osmRelation({
      members: members,
      tags: Object.assign({ type: 'multipolygon' }, WATER_TAGS)
    });
    entities.push(relation);

    return { entities: entities, selectedIDs: [relation.id] };
  }


  function _requestReferenceAtPoint() {
    const token = ++_requestToken;

    if (_controller) {
      _controller.abort();
      _controller = null;
    }

    _selectedPolygons = null;

    if (!_isFiniteCoordinate(_point)) {
      _loading = false;
      _disabledReason = 'no_anchor_point';
      _redrawEditMenu();
      return;
    }

    const clickLoc = viewport.unproject(_point);
    if (!_isFiniteCoordinate(clickLoc)) {
      _loading = false;
      _disabledReason = 'no_anchor_point';
      _redrawEditMenu();
      return;
    }

    _loading = true;
    _disabledReason = null;
    _redrawEditMenu();

    const url = new URL('/geojson', window.location.origin);
    url.searchParams.set('lat', String(clickLoc[1]));
    url.searchParams.set('lon', String(clickLoc[0]));
    url.searchParams.set('z', String(WATER_QUERY_ZOOM));
    url.searchParams.set('layers', 'water');

    _controller = new AbortController();

    fetch(url, { signal: _controller.signal })
      .then(utilFetchResponse)
      .then(data => {
        if (token !== _requestToken) return;

        const selected = _selectContainingPolygons(data, clickLoc);
        _selectedPolygons = selected.polygons;
        _disabledReason = selected.reason;
      })
      .catch(err => {
        if (token !== _requestToken) return;
        if (err.name === 'AbortError') return;

        _selectedPolygons = null;
        _disabledReason = 'reference_fetch_failed';
      })
      .finally(() => {
        if (token !== _requestToken) return;

        _loading = false;
        _controller = null;
        _redrawEditMenu();
      });
  }


  let operation = function() {
    const disabledReason = operation.disabled();
    if (disabledReason) return;

    const buildResult = _buildWaterEntities(_selectedPolygons);
    if (!buildResult) {
      _disabledReason = 'invalid_reference_geometry';
      _redrawEditMenu();
      return;
    }

    const actions = buildResult.entities.map(entity => actionAddEntity(entity));
    if (!actions.length) {
      _disabledReason = 'invalid_reference_geometry';
      _redrawEditMenu();
      return;
    }

    editor.perform(...actions);
    editor.commit({
      annotation: operation.annotation(),
      selectedIDs: buildResult.selectedIDs
    });

    context.enter('select-osm', {
      selection: { osm: buildResult.selectedIDs },
      newFeature: true
    });
  };


  operation.available = function() {
    return context.mode?.id === 'browse';
  };


  operation.disabled = function() {
    if (!_isFiniteCoordinate(_point)) {
      return 'no_anchor_point';
    }
    if (_loading) {
      return 'reference_loading';
    }
    if (_disabledReason) {
      return _disabledReason;
    }
    return false;
  };


  operation.tooltip = function() {
    const disabledReason = operation.disabled();
    return disabledReason ?
      l10n.t(`operations.create_water_from_reference.${disabledReason}`) :
      l10n.t('operations.create_water_from_reference.description');
  };


  operation.annotation = function() {
    return l10n.t('operations.create_water_from_reference.annotation');
  };


  operation.point = function(val) {
    _point = Array.isArray(val) ? [Number(val[0]), Number(val[1])] : null;
    _requestReferenceAtPoint();
    return operation;
  };


  operation.id = 'create_water_from_reference';
  operation.keys = [];
  operation.title = l10n.t('operations.create_water_from_reference.title');

  return operation;
}
