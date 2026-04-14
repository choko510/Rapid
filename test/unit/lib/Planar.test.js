import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


function nearlyEqual(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}


describe('Planar helpers', () => {
  describe('parseDistanceWithUnit', () => {
    it('parses known units and converts to meters', () => {
      assert.equal(Rapid.parseDistanceWithUnit('5m'), 5);
      assert.equal(Rapid.parseDistanceWithUnit('1 km'), 1000);
      nearlyEqual(Rapid.parseDistanceWithUnit('3ft'), 0.9144, 1e-4);
      assert.equal(Rapid.parseDistanceWithUnit('2 nmi'), 3704);
      assert.equal(Rapid.parseDistanceWithUnit('1 mi'), 1609);
    });

    it('parses plain numbers as meters', () => {
      assert.equal(Rapid.parseDistanceWithUnit('12.5'), 12.5);
      assert.equal(Rapid.parseDistanceWithUnit(4), 4);
    });

    it('returns undefined for invalid values', () => {
      assert.equal(Rapid.parseDistanceWithUnit('abc'), undefined);
      assert.equal(Rapid.parseDistanceWithUnit(''), undefined);
      assert.equal(Rapid.parseDistanceWithUnit(null), undefined);
    });
  });

  describe('getRadiusTag', () => {
    it('prefers diameter/2 over radius when both exist', () => {
      const tags = { diameter: '10m', radius: '2m' };
      assert.equal(Rapid.getRadiusTag(tags), 5);
    });

    it('falls back to radius', () => {
      const tags = { radius: '3m' };
      assert.equal(Rapid.getRadiusTag(tags), 3);
    });
  });

  describe('getRadiusInPixels', () => {
    it('calculates a positive pixel radius from either diameter or radius', () => {
      const viewport = {
        dimensions: [1024, 768],
        project: point => point
      };
      const fromDiameter = Rapid.osmNode({ loc: [0, 0], tags: { diameter: '10m' } });
      const fromRadius = Rapid.osmNode({ loc: [0, 0], tags: { radius: '5m' } });

      const diameterPixels = Rapid.getRadiusInPixels(fromDiameter, viewport);
      const radiusPixels = Rapid.getRadiusInPixels(fromRadius, viewport);

      assert.ok(diameterPixels > 0);
      assert.ok(radiusPixels > 0);
      assert.ok(Math.abs(diameterPixels - radiusPixels) < 1e-6);
    });
  });
});
