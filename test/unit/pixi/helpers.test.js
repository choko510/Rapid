import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  getFallbackTileZoom,
  getParentTileXYZ,
  isTransformOnlyRedraw,
  normalizeRect
} from '../../../modules/pixi/helpers.js';


describe('pixi/helpers getParentTileXYZ', () => {
  it('returns the containing parent tile', () => {
    assert.deepEqual(getParentTileXYZ([9, 10, 4]), [4, 5, 3]);
  });

  it('moves multiple zoom levels up', () => {
    assert.deepEqual(getParentTileXYZ([9, 10, 4], 2), [2, 2, 2]);
  });

  it('rejects invalid parent coordinates', () => {
    assert.equal(getParentTileXYZ([0, 0, 0]), null);
    assert.equal(getParentTileXYZ([0, 0, 3], 4), null);
  });
});


describe('pixi/helpers getFallbackTileZoom', () => {
  it('returns one lower zoom when available', () => {
    assert.equal(getFallbackTileZoom(12, 1), 11);
  });

  it('does not return a zoom below the configured minimum', () => {
    assert.equal(getFallbackTileZoom(1, 1), null);
  });
});


describe('pixi/helpers isTransformOnlyRedraw', () => {
  it('accepts transform-only redraws', () => {
    assert.equal(isTransformOnlyRedraw(new Set(['transform'])), true);
  });

  it('rejects redraws that also need data or resize work', () => {
    assert.equal(isTransformOnlyRedraw(new Set(['transform', 'data'])), false);
    assert.equal(isTransformOnlyRedraw(new Set(['transform', 'resize'])), false);
    assert.equal(isTransformOnlyRedraw(new Set(['data'])), false);
  });
});


describe('pixi/helpers normalizeRect', () => {
  it('keeps positive dimensions unchanged', () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    const result = normalizeRect(rect);

    assert.equal(result, rect);   // normalized in place
    assert.deepEqual(result, { x: 10, y: 20, width: 30, height: 40 });
  });

  it('normalizes negative width and height', () => {
    const rect = { x: 10, y: 20, width: -30, height: -40 };
    const result = normalizeRect(rect);

    assert.deepEqual(result, { x: -20, y: -20, width: 30, height: 40 });
  });
});
