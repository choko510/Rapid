import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


const subject = [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]];
const overlapA = [[[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]];
const overlapB = [[[1, 1], [1.5, 1], [1.5, 1.5], [1, 1.5], [1, 1]]];
const disjoint = [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]];


describe('WasmGeometryEngine', () => {
  it('memoizes clipper path conversion for the same polygon object', () => {
    const engine = new Rapid.WasmGeometryEngine();
    const first = engine.toClipperPaths(subject);
    const second = engine.toClipperPaths(subject);

    assert.strictEqual(first, second);
  });

  it('intersectsAny reports overlap when any candidate overlaps', () => {
    const engine = new Rapid.WasmGeometryEngine();
    const result = engine.intersectsAny(subject, [disjoint, overlapA]);
    assert.equal(result, true);
  });

  it('intersectsAny reports no overlap when all candidates are disjoint', () => {
    const engine = new Rapid.WasmGeometryEngine();
    const result = engine.intersectsAny(subject, [disjoint]);
    assert.equal(result, false);
  });

  it('falls back to wasm path for heavy intersection workloads when wasm is available', () => {
    const engine = new Rapid.WasmGeometryEngine({ intersectionVertexThreshold: 1_000_000 });

    let wasmCalls = 0;
    engine._clipper = {};
    engine._modes.intersection = 'wasm';
    engine._wasmIntersectsAny = () => {
      wasmCalls++;
      return true;
    };

    const result = engine.intersectsAny(subject, [overlapA, overlapB, disjoint]);
    assert.equal(result, true);
    assert.equal(wasmCalls, 1);
  });

  it('falls back to wasm path for complex unions when wasm is available', () => {
    const engine = new Rapid.WasmGeometryEngine({ unionPolygonThreshold: 3 });

    let wasmCalls = 0;
    const sentinel = [subject];
    engine._clipper = {};
    engine._modes.union = 'polyclip';
    engine._wasmUnionPolygons = () => {
      wasmCalls++;
      return sentinel;
    };

    const result = engine.unionPolygons([subject, overlapA, disjoint]);
    assert.equal(wasmCalls, 1);
    assert.strictEqual(result, sentinel);
  });
});
