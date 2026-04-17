import { performance } from 'node:perf_hooks';
import * as Polyclip from 'polyclip-ts';

const ITERATIONS = Number(process.env.RAPID_WASM_POC_ITERATIONS || 250);
const SCALE = 1e7;

function makeCircle(centerX, centerY, radius, points) {
  const ring = [];
  for (let i = 0; i < points; i++) {
    const t = (i / points) * Math.PI * 2;
    ring.push([centerX + Math.cos(t) * radius, centerY + Math.sin(t) * radius]);
  }
  ring.push(ring[0]);
  return ring;
}

function toClipperPath(ring) {
  return ring.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) }));
}

function timed(label, fn) {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { label, durationMs, result };
}

function runPolyclip(subjectPoly, clipPoly) {
  const bench = timed('polyclip-ts', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      Polyclip.union(subjectPoly, clipPoly);
    }
  });

  return {
    engine: bench.label,
    iterations: ITERATIONS,
    totalMs: Number(bench.durationMs.toFixed(2)),
    perOpMs: Number((bench.durationMs / ITERATIONS).toFixed(4))
  };
}

async function runClipperWasm(subjectRing, clipRing) {
  let clipperLib;
  try {
    clipperLib = await import('js-angusj-clipper');
  } catch {
    return null;
  }

  const lib = clipperLib.default ?? clipperLib;
  const loadNative = lib.loadNativeClipperLibInstanceAsync;
  if (typeof loadNative !== 'function') {
    return null;
  }

  const requestedFormat = lib.NativeClipperLibRequestedFormat?.WasmWithAsmJsFallback;
  const clipType = lib.ClipType?.Union;
  const fillType = lib.PolyFillType?.EvenOdd;
  if (requestedFormat === undefined || clipType === undefined || fillType === undefined) {
    return null;
  }

  const clipper = await loadNative(requestedFormat);
  const subjectPath = toClipperPath(subjectRing);
  const clipPath = toClipperPath(clipRing);

  const bench = timed('js-angusj-clipper (wasm/asm fallback)', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      clipper.clipToPaths({
        clipType,
        subjectInputs: [{ data: subjectPath, closed: true }],
        clipInputs: [{ data: clipPath, closed: true }],
        subjectFillType: fillType
      });
    }
  });

  return {
    engine: bench.label,
    iterations: ITERATIONS,
    totalMs: Number(bench.durationMs.toFixed(2)),
    perOpMs: Number((bench.durationMs / ITERATIONS).toFixed(4))
  };
}

async function main() {
  const subjectRing = makeCircle(0, 0, 0.03, 256);
  const clipRing = makeCircle(0.01, 0.005, 0.03, 256);
  const subjectPoly = [subjectRing];
  const clipPoly = [clipRing];

  const polyclip = runPolyclip(subjectPoly, clipPoly);
  const wasm = await runClipperWasm(subjectRing, clipRing);

  const result = {
    scenario: 'polygon-union-two-overlapping-circles',
    iterations: ITERATIONS,
    polyclip,
    wasm: wasm ?? { skipped: true, reason: 'js-angusj-clipper not installed' }
  };

  if (wasm && polyclip.perOpMs > 0) {
    result.wasm.speedupVsPolyclip = Number((polyclip.perOpMs / wasm.perOpMs).toFixed(2));
  }

  console.log(`WASM_GEOMETRY_POC ${JSON.stringify(result)}`);
}

main().catch(err => {
  console.error(err);  // eslint-disable-line no-console
  process.exitCode = 1;
});
