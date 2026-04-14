import { geoMetersToLat } from '@rapid-sdk/math';


/**
 * Parse a distance value from an OSM tag.
 * The value may include an optional unit suffix.
 * @param   {string}  tagValue
 * @param   {string}  defaultUnit
 * @returns {number|undefined} distance in meters
 */
export function parseDistanceWithUnit(tagValue, defaultUnit = 'm') {
  if (!tagValue) return undefined;
  const valueText = (typeof tagValue === 'number') ? String(tagValue) : tagValue;

  const imperialCombo = valueText.match(/([\d.]+)\s*(?:'|ft|foot|feet)\s*([\d.]+)\s*(?:"|in|inch|inches)/i);
  if (imperialCombo) {
    const feet = Number(imperialCombo[1]);
    const inches = Number(imperialCombo[2]);
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return undefined;
    return feet / 3.281 + inches / 39.37;
  }

  const value = Number.parseFloat(valueText);
  if (!Number.isFinite(value)) return undefined;

  const parsedUnit = valueText.match(/[^\d.\s]+(?:\s*[^\d.\s]+)*/)?.[0]?.trim().toLowerCase();
  const unit = parsedUnit || defaultUnit;

  switch (unit) {
    case 'mm':
      return value / 1e3;
    case 'cm':
      return value / 1e2;
    case 'm':
    case 'metre':
    case 'metres':
    case 'meter':
    case 'meters':
      return value;
    case 'hm':
    case 'hectometre':
    case 'hectometres':
    case 'hectometer':
    case 'hectometers':
      return value * 1e2;
    case 'km':
    case 'kilometre':
    case 'kilometres':
    case 'kilometer':
    case 'kilometers':
      return value * 1e3;
    case 'mi':
    case 'mile':
    case 'miles':
    case 'statute_miles':
      return value * 1609;
    case 'nmi':
    case 'nauticalmile':
    case 'nauticalmiles':
    case 'nm':
      return value * 1852;
    case 'yd':
    case 'yard':
    case 'yards':
      return value / 1.094;
    case '\'':
    case 'ft':
    case 'foot':
    case 'feet':
      return value / 3.281;
    case '"':
    case 'in':
    case 'inch':
    case 'inches':
      return value / 39.37;
    default:
      return undefined;
  }
}


/**
 * Returns a radius value in meters based on tags.
 * @param   {Object}  tags
 * @returns {number|undefined}
 */
export function getRadiusTag(tags = {}) {
  const diameter =
    parseDistanceWithUnit(tags.diameter, 'mm') ||
    parseDistanceWithUnit(tags.diameter_crown, 'm') ||
    parseDistanceWithUnit(tags['hole:diameter'], 'm');
  if (diameter) return diameter / 2;

  const radius =
    parseDistanceWithUnit(tags.radius, 'm') ||
    parseDistanceWithUnit(tags.crown_radius, 'm') ||
    parseDistanceWithUnit(tags['seamark:anchor_berth:radius'], tags['seamark:anchor_berth:units'] || 'm');
  if (radius) return radius;

  return undefined;
}


/**
 * Returns radius in screen pixels for the given node.
 * @param   {Object}  node
 * @param   {Object}  viewport
 * @returns {number}
 */
export function getRadiusInPixels(node, viewport) {
  const radius = getRadiusTag(node?.tags);
  if (!radius) return 0;

  const center = viewport.project(node.loc);
  const edge = viewport.project([node.loc[0], node.loc[1] + geoMetersToLat(radius)]);
  const pixels = Math.abs(center[1] - edge[1]);
  if (!Number.isFinite(pixels)) return 0;

  const [w, h] = viewport.dimensions;
  if (pixels > w || pixels > h) return 0;

  return Math.max(0, pixels);
}
