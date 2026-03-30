import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { normalizeRect } from '../../../modules/pixi/helpers.js';


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
