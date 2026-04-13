/* eslint-disable no-console */
const Benchmark = window.Benchmark;
if (!Benchmark) {
  console.log('[Benchmark error] Benchmark.js was not loaded.');
  console.log('Benchmark suite failed.');
  throw new Error('Benchmark.js unavailable');
}
const suite = new Benchmark.Suite();
const PERFORMANCE_BUDGETS = {
  'PixiLayerOsm Renderer Benchmark with zoom 19 Tokyo data': 3000,
  'PixiLayerOsm Renderer Benchmark with zoom 17 Tokyo data': 12,
  'PixiLayerOsm Renderer Benchmark with zoom 15 Tokyo data': 1.8
};
const benchmarkResults = [];
const benchmarkFailures = [];

const values = [];
for (let i = 0; i < 1000000; i++) {
  values.push(i);
}

// Converts a list of json OSM entities to osm objects
function jsonToOSM(renderData) {
  //Entity data is already split into points, vertices, lines, and polygons.
  const points = (renderData.points || []).map(point => Rapid.osmNode(point));
  const vertices = (renderData.vertices || []).map(vertex => Rapid.osmNode(vertex));
  const lines = (renderData.lines || []).map(line => Rapid.osmWay(line));
  const polygons = (renderData.polygons || []).map(polygon => Rapid.osmWay(polygon));

  const nodeIDs = new Set([
    ...points.map(entity => entity.id),
    ...vertices.map(entity => entity.id)
  ]);
  const wayHasAllNodes = way => Array.isArray(way.nodes) && way.nodes.every(nodeID => nodeIDs.has(nodeID));
  const validLines = lines.filter(wayHasAllNodes);
  const validPolygons = polygons.filter(wayHasAllNodes);

  return {
    points: new Map(points.map(entity => [entity.id, entity])),
    vertices: new Map(vertices.map(entity => [entity.id, entity])),
    lines: new Map(validLines.map(entity => [entity.id, entity])),
    polygons: new Map(validPolygons.map(entity => [entity.id, entity]))
  };
}


//This staticData variable looks like it's not declared anywhere, but it is a global var loaded by the <script src='canned_osm_data.js'> declaration in bench.html
let renderData;
let graphEntities;
let viewport;
let zoom;
const timestamp = 1649012524130;
let context;
let editor;

//Now initialize context in a similar fashion to our unit tests.
//Benchmark.js doesn't have the concept of a 'before all' or 'before each', so we just do it all here at a single go.
const content = d3.select('body').append('div');
const makeContext = typeof Rapid.coreContext === 'function'
  ? () => Rapid.coreContext()
  : typeof Rapid.Context === 'function'
    ? () => new Rapid.Context()
    : null;

if (!makeContext) {
  console.log('[Benchmark error] No context factory available on the Rapid namespace.');
  console.log('Benchmark suite failed.');
  throw new Error('Rapid context factory unavailable');
}

async function initContextAsync() {
  if (context) return;

  const ctx = makeContext();
  if (typeof ctx.assetPath === 'function' && typeof ctx.init === 'function') {
    context = ctx.assetPath('../../dist/').init().container(content);
  } else {
    context = ctx;
    context.assetPath = '../../dist/';

    if (typeof context.container === 'function') {
      context.container(content);
    }

    if (typeof context.initAsync === 'function') {
      await context.initAsync();
    } else if (typeof context.init === 'function') {
      context.init();
    }
  }

  editor = context.systems.editor;
  const map = context.systems.map;
  if (typeof map === 'function') {
    content.call(map);
  } else if (typeof map?.render === 'function') {
    map.render(content);
  }

  const osmLayer = context.scene?.().layers?.get?.('osm');
  if (osmLayer && !osmLayer.areaContainer && typeof osmLayer.reset === 'function') {
    osmLayer.reset();
  }
}


function renderTest() {
  const scene = context.scene();
  const layer = scene.layers.get('osm');
  layer.renderPolygons(timestamp, viewport, zoom, renderData);
  layer.renderLines(timestamp, viewport, zoom, renderData);
  layer.renderPoints(timestamp, viewport, zoom, renderData);
  scene.dirtyScene();  // Dirty the scene so that subsequent runs of this same test don't operate at warp speed
}

function setup(dataBlob) {
  //This dataBlob variable should be the json blob exported in bench.html from a <script src='canned_osm_data.js'> declaration
  if (!dataBlob?.data) {
    throw new Error('Missing benchmark data payload');
  }

  renderData = jsonToOSM(dataBlob.data);
  graphEntities = [
    ...renderData.points.values(),
    ...renderData.vertices.values(),
    ...renderData.lines.values(),
    ...renderData.polygons.values()
  ];
  viewport = new Rapid.sdk.Viewport({ x: dataBlob.projection._x, y: dataBlob.projection._y, k: dataBlob.projection._k });
  zoom = dataBlob.zoom;
  const graph = editor.staging.graph;
  graph.rebase(graphEntities, [graph], false);
}

// Enable the cycle event if and only if we really need to print stuff every run.
// function cycle(event) {
//     const benchmark = event.target;
//     console.log(benchmark.toString());
// }

function complete(event) {
  const benchmark = event.target;
  const hz = Number(benchmark.hz.toFixed(benchmark.hz < 100 ? 2 : 0));
  const minOpsPerSec = PERFORMANCE_BUDGETS[benchmark.name];
  const passedBudget = typeof minOpsPerSec !== 'number' ? true : benchmark.hz >= minOpsPerSec;

  const result = {
    name: benchmark.name,
    placename: benchmark.placename,
    zoom: benchmark.zoom,
    opsPerSec: hz,
    minOpsPerSec: minOpsPerSec ?? null,
    passedBudget: passedBudget
  };
  benchmarkResults.push(result);

  console.log(`benchmark placename: ${benchmark.placename}`);
  console.log(`benchmark zoom: ${benchmark.zoom}`);
  console.log(`benchmark ops/sec: ${hz}`);
  console.log(`BENCHMARK_RESULT ${JSON.stringify(result)}`);

  if (!passedBudget) {
    const failure = `${benchmark.name} measured ${hz} ops/sec, below budget ${minOpsPerSec} ops/sec`;
    benchmarkFailures.push(failure);
    console.log(`[Benchmark failure] ${failure}`);
  }
}

suite.add({
  'name': 'PixiLayerOsm Renderer Benchmark with zoom 19 Tokyo data',
  'fn': renderTest,
  'placename': 'tokyo',
  'zoom': '19',
  'onStart': () => setup(globalThis.tokyo_19),
  // 'onCycle': event => cycle(event),
  'onComplete': event => complete(event),
});
suite.add({
  'name': 'PixiLayerOsm Renderer Benchmark with zoom 17 Tokyo data',
  'fn': renderTest,
  'placename': 'tokyo',
  'zoom': '17',
  'onStart': () => setup(globalThis.tokyo_17),
  // 'onCycle': event => cycle(event),
  'onComplete': event => complete(event),
});
suite.add({
  'name': 'PixiLayerOsm Renderer Benchmark with zoom 15 Tokyo data',
  'fn': renderTest,
  'placename': 'tokyo',
  'zoom': '15',
  'onStart': () => setup(globalThis.tokyo_15),
  // 'onCycle': event => cycle(event),
  'onComplete': event => complete(event),
});

suite.on('error', event => {
  const error = event?.target?.error || new Error('Unknown benchmark error');
  const message = error?.message || String(error);
  benchmarkFailures.push(message);
  console.log(`[Benchmark error] ${message}`);
});

suite.on('complete', () => {
  console.log(`BENCHMARK_SUMMARY ${JSON.stringify({
    total: benchmarkResults.length,
    failures: benchmarkFailures.length
  })}`);

  if (benchmarkFailures.length) {
    console.log('Benchmark suite failed.');
  } else {
    console.log('Benchmark suite complete.');
  }
});

initContextAsync()
  .then(() => suite.run({ async: true }))
  .catch(error => {
    const message = error?.message || String(error);
    console.log(`[Benchmark error] ${message}`);
    console.log('Benchmark suite failed.');
  });
