import { osmFlowingWaterwayTagValues } from '../osm/index.js';


const ROAD_HINTS = ['road', 'street', 'highway', 'motorway', 'carriageway', 'expressway'];
const WATERWAY_HINTS = ['waterway', 'water', 'river', 'stream', 'canal', 'ditch', 'drain', 'flowline', 'tidal'];


export function filterRoadReferenceLines(lines) {
  return _filterReferenceLines(lines, properties => {
    if (!_isObject(properties)) return true;

    if (_hasWaterwayMarkers(properties) && !_hasRoadMarkers(properties)) {
      return false;
    }

    return true;
  });
}


export function filterWaterwayReferenceLines(lines) {
  return _filterReferenceLines(lines, properties => {
    if (!_isObject(properties)) return true;

    if (_hasWaterwayMarkers(properties)) {
      return true;
    }
    if (_hasRoadMarkers(properties)) {
      return false;
    }

    return true;
  });
}


function _filterReferenceLines(lines, predicate) {
  if (!Array.isArray(lines)) return [];

  return lines.filter(line => {
    if (!line?.coords || line.coords.length < 2) return false;
    return predicate(line.properties);
  });
}


function _hasRoadMarkers(properties) {
  const highway = _normalized(properties.highway);
  if (highway && highway !== 'no') return true;

  if (properties.rdCtg !== undefined || properties.motorway !== undefined) return true;

  const layer = _normalized(properties.layer);
  if (_containsHint(layer, ROAD_HINTS)) return true;

  const kind = _normalized(properties.kind ?? properties.class ?? properties.feature);
  if (_containsHint(kind, ROAD_HINTS)) return true;

  return false;
}


function _hasWaterwayMarkers(properties) {
  const waterway = _normalized(properties.waterway);
  if (waterway && (osmFlowingWaterwayTagValues[waterway] || _containsHint(waterway, WATERWAY_HINTS))) {
    return true;
  }

  const natural = _normalized(properties.natural);
  if (_containsHint(natural, WATERWAY_HINTS)) return true;

  const layer = _normalized(properties.layer);
  if (_containsHint(layer, WATERWAY_HINTS)) return true;

  const kind = _normalized(properties.kind ?? properties.class ?? properties.feature);
  if (_containsHint(kind, WATERWAY_HINTS)) return true;

  return false;
}


function _containsHint(value, hints) {
  if (!value) return false;
  return hints.some(hint => value.includes(hint));
}


function _normalized(value) {
  return (typeof value === 'string' || typeof value === 'number') ? String(value).toLowerCase() : '';
}


function _isObject(value) {
  return value && typeof value === 'object';
}
