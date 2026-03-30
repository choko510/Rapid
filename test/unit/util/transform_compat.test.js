import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('utilPatchTransformCompat', () => {
  it('supports setting transform.props with k and reading k back', () => {
    const viewport = new Rapid.sdk.Viewport();
    viewport.transform.props = { x: 12, y: 34, k: 2048, r: 0 };

    const props = viewport.transform.props;
    assert.equal(props.x, 12);
    assert.equal(props.y, 34);
    assert.ok(Math.abs(props.k - 2048) < 1e-9);
  });

  it('supports reading and writing transform.k directly', () => {
    const t = new Rapid.sdk.Transform();
    t.k = 1024;
    assert.ok(Math.abs(t.k - 1024) < 1e-9);
  });
});
