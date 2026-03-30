import { Extent, geoLatToMeters, geoLonToMeters, geoMetersToLat, geoMetersToLon, geoSphericalDistance, vecProject } from '@rapid-sdk/math';

import { AbstractSystem } from '../core/AbstractSystem.js';
import { FetchError, utilFetchResponse } from '../util/index.js';


const DEFAULT_TILE_TEMPLATE = 'http://localhost:8080/tile/{z}/{x}/{y}.geojson';
const TILE_ZOOM = 16;
const TILE_MARGIN = 1;
const MAX_LATITUDE = 85.05112878;

const SAMPLE_SPACING_METERS = 8;
const MAX_SAMPLES_PER_LINE = 40;
const MAX_SNAP_DISTANCE_METERS = 20;
const OUTLIER_DISTANCE_METERS = 8;
const MIN_MATCH_COUNT = 6;
const MIN_SHIFT_METERS = 0.4;
const MAX_SHIFT_METERS = 20;

const SHAPE_SNAP_DISTANCE_METERS = 35;
const MIN_NODE_MOVE_METERS = 0.2;
const MAX_NODE_MOVE_METERS = 60;
const SHAPE_SAMPLE_SPACING_METERS = 12;
const MAX_INSERTS_PER_SEGMENT = 2;
const MAX_INSERTIONS = 200;
const MAX_REMOVALS = 200;
const ADD_NODE_DEVIATION_METERS = 1.8;
const REMOVE_NODE_DEVIATION_METERS = 0.9;
const MIN_INSERT_ENDPOINT_DISTANCE_METERS = 2;
const MIN_INSERT_SEPARATION_METERS = 3;
const MIN_INSERT_T_SEPARATION = 0.08;
const MIN_SHAPE_MATCH_COUNT = 2;
const MAX_INSERT_DIRECTION_CHANGE_DEGREES = 120;
const MIN_TURN_CHECK_SEGMENT_METERS = 0.5;
const MAX_SANITIZE_ITERATIONS = 4;


/**
 * `RoadAlignmentService`
 * This service fetches reference road geometries from a GeoJSON tile endpoint
 * and estimates translation offsets for selected OSM road ways.
 */
export class RoadAlignmentService extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'roadAlignment';

    this._tileTemplate = DEFAULT_TILE_TEMPLATE;
    this._cache = {
      inflight: new Map(),  // Map(tileID -> AbortController)
      loaded: new Map(),    // Map(tileID -> { tile, lines })
      failed: new Map()     // Map(tileID -> Error)
    };
  }


  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    return this.resetAsync();
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    this._started = true;
    return Promise.resolve();
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state.
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    for (const controller of this._cache.inflight.values()) {
      controller.abort();
    }

    this._cache.inflight.clear();
    this._cache.loaded.clear();
    this._cache.failed.clear();

    return Promise.resolve();
  }


  /**
   * setTileTemplate
   * @param   {string} template
   * @return  {RoadAlignmentService}
   */
  setTileTemplate(template) {
    if (typeof template !== 'string' || !template.trim()) return this;

    const trimmed = template.trim();
    if (trimmed !== this._tileTemplate) {
      this._tileTemplate = trimmed;
      this._cache.loaded.clear();
      this._cache.failed.clear();
    }
    return this;
  }


  /**
   * getTileTemplate
   * @return  {string}
   */
  getTileTemplate() {
    return this._tileTemplate;
  }


  /**
   * loadTilesForExtent
   * Ensure all reference tiles covering this extent are loaded (or loading).
   * @param   {Extent} extent
   * @return  {Object} status object
   */
  loadTilesForExtent(extent) {
    if (!(extent instanceof Extent)) {
      return { status: 'error', reason: 'reference_fetch_failed' };
    }

    const tiles = this._tilesForExtent(extent);
    if (!tiles.length) {
      return { status: 'error', reason: 'reference_fetch_failed' };
    }

    let isLoading = false;
    let hasError = false;

    for (const tile of tiles) {
      if (this._cache.loaded.has(tile.id)) continue;

      if (this._cache.failed.has(tile.id)) {
        hasError = true;
        continue;
      }

      if (this._cache.inflight.has(tile.id)) {
        isLoading = true;
        continue;
      }

      this._loadTileAsync(tile);
      isLoading = true;
    }

    if (hasError) {
      return { status: 'error', reason: 'reference_fetch_failed' };
    }
    if (isLoading) {
      return { status: 'loading', reason: 'reference_loading' };
    }
    return { status: 'ready', reason: null };
  }


  /**
   * getReferenceLines
   * @param   {Extent} extent
   * @return  {Array<Object>} Array of normalized reference lines
   */
  getReferenceLines(extent) {
    if (!(extent instanceof Extent)) return [];

    const lines = [];
    for (const tileData of this._cache.loaded.values()) {
      if (!tileData.tile.extent.intersects(extent)) continue;

      for (const line of tileData.lines) {
        if (line.extent.intersects(extent)) {
          lines.push(line);
        }
      }
    }
    return lines;
  }


  /**
   * prepareForWays
   * @param   {Array<osmWay>} ways
   * @param   {Graph} graph
   * @return  {Object} status object with `lines` and `extent`
   */
  prepareForWays(ways, graph) {
    const wayExtent = this._extentForWays(ways, graph);
    if (!wayExtent) {
      return { status: 'error', reason: 'not_eligible', extent: null, lines: [] };
    }

    const queryExtent = wayExtent.padByMeters(MAX_SNAP_DISTANCE_METERS * 3);
    const tileState = this.loadTilesForExtent(queryExtent);
    if (tileState.status !== 'ready') {
      return { ...tileState, extent: queryExtent, lines: [] };
    }

    const lines = this.getReferenceLines(queryExtent);
    if (!lines.length) {
      return { status: 'error', reason: 'no_reference_data', extent: queryExtent, lines: [] };
    }

    return { status: 'ready', reason: null, extent: queryExtent, lines: lines };
  }


  /**
   * estimateForWays
   * @param   {Array<osmWay>} ways
   * @param   {Graph} graph
   * @param   {Array<Object>} [referenceLines]
   * @return  {Object} estimate result
   */
  estimateForWays(ways, graph, referenceLines) {
    const selectedLines = this._linesFromWays(ways, graph);
    if (!selectedLines.length) {
      return { ok: false, reason: 'not_eligible' };
    }

    let lines = referenceLines;
    if (!Array.isArray(lines)) {
      const prep = this.prepareForWays(ways, graph);
      if (prep.status !== 'ready') {
        return { ok: false, reason: prep.reason || 'reference_loading' };
      }
      lines = prep.lines;
    }

    return this._estimateOffset(selectedLines, lines);
  }


  /**
   * reshapeForWays
   * Compute per-node edits (move/insert/remove) to better match reference roads.
   * @param   {Array<osmWay>} ways
   * @param   {Graph} graph
   * @param   {Array<Object>} [referenceLines]
   * @return  {Object}
   */
  reshapeForWays(ways, graph, referenceLines) {
    const selectedWays = Array.isArray(ways) ? ways.filter(way => way?.type === 'way') : [];
    if (!selectedWays.length) {
      return { ok: false, reason: 'not_eligible' };
    }

    let lines = referenceLines;
    if (!Array.isArray(lines)) {
      const prep = this.prepareForWays(selectedWays, graph);
      if (prep.status !== 'ready') {
        return { ok: false, reason: prep.reason || 'reference_loading' };
      }
      lines = prep.lines;
    }
    if (!lines.length) {
      return { ok: false, reason: 'no_reference_data' };
    }

    const moveNodeLocs = new Map();   // Map(nodeID -> [lon,lat])
    const insertions = [];            // Array<{wayID,index,loc}>
    const removals = [];              // Array<nodeID>
    let matchedNodeCount = 0;

    for (const way of selectedWays) {
      const nodeIDs = way.nodes?.slice() ?? [];
      if (nodeIDs.length < 2) continue;

      const wayNodes = nodeIDs.map(nodeID => graph.hasEntity(nodeID)).filter(node => node?.loc);
      if (wayNodes.length < 2) continue;

      const segmentPlans = this._planInsertionsForWay(wayNodes, lines, SHAPE_SAMPLE_SPACING_METERS);
      for (const plan of segmentPlans) {
        if (insertions.length >= MAX_INSERTIONS) break;
        insertions.push({ wayID: way.id, index: plan.index, loc: plan.loc, t: plan.t });
      }

      for (const node of wayNodes) {
        const target = this._nearestReferencePoint(node.loc, lines, SHAPE_SNAP_DISTANCE_METERS);
        if (!target) continue;

        matchedNodeCount++;
        const moveMeters = geoSphericalDistance(node.loc, target);
        if (moveMeters < MIN_NODE_MOVE_METERS) continue;
        if (moveMeters > MAX_NODE_MOVE_METERS) continue;

        const existing = moveNodeLocs.get(node.id);
        if (!existing) {
          moveNodeLocs.set(node.id, target);
        } else {
          moveNodeLocs.set(node.id, [
            (existing[0] + target[0]) / 2,
            (existing[1] + target[1]) / 2
          ]);
        }
      }

      const interiorNodes = wayNodes.slice(1, -1);
      for (const node of interiorNodes) {
        if (removals.length >= MAX_REMOVALS) break;
        if (moveNodeLocs.has(node.id)) continue;
        if (!this._nodeRemovable(node, graph)) continue;

        const nearest = this._nearestReferencePoint(node.loc, lines, SHAPE_SNAP_DISTANCE_METERS);
        if (!nearest) continue;

        const deviationMeters = geoSphericalDistance(node.loc, nearest);
        if (deviationMeters <= REMOVE_NODE_DEVIATION_METERS) {
          removals.push(node.id);
        }
      }
    }

    const sanitized = this._sanitizeShapePlanForWays(selectedWays, graph, moveNodeLocs, insertions, removals);
    const safeInsertions = sanitized.insertions;
    const safeRemovals = sanitized.removals;

    if (matchedNodeCount < MIN_SHAPE_MATCH_COUNT) {
      return { ok: false, reason: 'not_enough_matches', matchCount: matchedNodeCount };
    }

    if (!moveNodeLocs.size && !safeInsertions.length && !safeRemovals.length) {
      return { ok: false, reason: 'already_aligned' };
    }

    return {
      ok: true,
      reason: null,
      mode: 'shape',
      moveNodeLocs: moveNodeLocs,
      insertions: safeInsertions,
      removals: safeRemovals,
      matchedNodeCount: matchedNodeCount
    };
  }


  /**
   * _estimateOffset
   * Compute robust median translation from selected lines to reference lines.
   * @param   {Array<Object>} selectedLines
   * @param   {Array<Object>} referenceLines
   * @return  {Object} estimate result
   */
  _estimateOffset(selectedLines, referenceLines) {
    if (!selectedLines?.length || !referenceLines?.length) {
      return { ok: false, reason: 'no_reference_data' };
    }

    const offsets = [];
    for (const line of selectedLines) {
      const samples = this._sampleLinePoints(line.coords, SAMPLE_SPACING_METERS, MAX_SAMPLES_PER_LINE);
      for (const sample of samples) {
        const nearest = this._nearestReferencePoint(sample, referenceLines, MAX_SNAP_DISTANCE_METERS);
        if (!nearest) continue;
        offsets.push({
          lon: nearest[0] - sample[0],
          lat: nearest[1] - sample[1],
          atLat: sample[1]
        });
      }
    }

    if (offsets.length < MIN_MATCH_COUNT) {
      return { ok: false, reason: 'not_enough_matches', matchCount: offsets.length };
    }

    const medianLon = this._median(offsets.map(d => d.lon));
    const medianLat = this._median(offsets.map(d => d.lat));

    const filtered = offsets.filter(d => {
      const dLon = d.lon - medianLon;
      const dLat = d.lat - medianLat;
      return this._offsetDistanceMeters(dLon, dLat, d.atLat) <= OUTLIER_DISTANCE_METERS;
    });

    if (filtered.length < MIN_MATCH_COUNT) {
      return { ok: false, reason: 'not_enough_matches', matchCount: filtered.length };
    }

    const deltaLon = this._median(filtered.map(d => d.lon));
    const deltaLat = this._median(filtered.map(d => d.lat));
    const centerLat = this._median(filtered.map(d => d.atLat));
    const shiftMeters = this._offsetDistanceMeters(deltaLon, deltaLat, centerLat);

    if (shiftMeters < MIN_SHIFT_METERS) {
      return { ok: false, reason: 'already_aligned', shiftMeters: shiftMeters };
    }
    if (shiftMeters > MAX_SHIFT_METERS) {
      return { ok: false, reason: 'shift_too_large', shiftMeters: shiftMeters };
    }

    return {
      ok: true,
      reason: null,
      delta: [deltaLon, deltaLat],
      shiftMeters: shiftMeters,
      matchCount: filtered.length
    };
  }


  /**
   * _planInsertionsForWay
   * @param   {Array<osmNode>} wayNodes
   * @param   {Array<Object>} referenceLines
   * @param   {number} spacingMeters
   * @return  {Array<Object>}
   */
  _planInsertionsForWay(wayNodes, referenceLines, spacingMeters) {
    const plans = [];
    if (!Array.isArray(wayNodes) || wayNodes.length < 2) return plans;

    for (let i = 0; i < wayNodes.length - 1; i++) {
      const a = wayNodes[i]?.loc;
      const b = wayNodes[i + 1]?.loc;
      if (!this._isValidCoordinate(a) || !this._isValidCoordinate(b)) continue;

      const segLengthMeters = geoSphericalDistance(a, b);
      if (segLengthMeters < (MIN_INSERT_ENDPOINT_DISTANCE_METERS * 2)) continue;

      const candidateCount = Math.max(1, Math.min(MAX_INSERTS_PER_SEGMENT * 4, Math.floor(segLengthMeters / spacingMeters)));
      const candidates = [];

      for (let j = 1; j <= candidateCount; j++) {
        const t = j / (candidateCount + 1);
        const sample = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t
        ];

        const target = this._nearestReferencePoint(sample, referenceLines, SHAPE_SNAP_DISTANCE_METERS);
        if (!target) continue;
        const targetT = this._fractionAlongSegment(a, b, target);
        if (!Number.isFinite(targetT)) continue;

        const deviationMeters = geoSphericalDistance(sample, target);
        if (deviationMeters < ADD_NODE_DEVIATION_METERS) continue;

        const distanceToA = geoSphericalDistance(target, a);
        const distanceToB = geoSphericalDistance(target, b);
        if (Math.min(distanceToA, distanceToB) < MIN_INSERT_ENDPOINT_DISTANCE_METERS) continue;
        if (this._directionChangeDegrees(a, target, b) > MAX_INSERT_DIRECTION_CHANGE_DEGREES) continue;

        if (candidates.some(other => geoSphericalDistance(other.loc, target) < MIN_INSERT_SEPARATION_METERS)) {
          continue;
        }

        candidates.push({ index: i + 1, loc: target, score: deviationMeters, t: targetT });
      }

      const selected = candidates
        .sort((d1, d2) => d2.score - d1.score)
        .slice(0, MAX_INSERTS_PER_SEGMENT);

      let previousT = -Infinity;
      selected
        .sort((d1, d2) => d1.t - d2.t)
        .forEach(candidate => {
          if ((candidate.t - previousT) < MIN_INSERT_T_SEPARATION) return;
          previousT = candidate.t;
          plans.push({ index: candidate.index, loc: candidate.loc, score: candidate.score, t: candidate.t });
        });
    }

    return plans;
  }


  _sanitizeShapePlanForWays(ways, graph, moveNodeLocs, insertions, removals) {
    const safeInsertions = [];
    const insertionsByWay = new Map();
    const removalsSet = new Set(removals);

    for (const insertion of insertions) {
      if (!insertion?.wayID || !this._isValidCoordinate(insertion.loc)) continue;
      if (!insertionsByWay.has(insertion.wayID)) {
        insertionsByWay.set(insertion.wayID, []);
      }
      insertionsByWay.get(insertion.wayID).push(insertion);
    }

    for (const way of ways) {
      const candidates = (insertionsByWay.get(way.id) ?? [])
        .slice()
        .sort((a, b) => (a.index - b.index) || ((a.t ?? 0) - (b.t ?? 0)));

      let accepted = candidates;
      let iteration = 0;
      while (iteration < MAX_SANITIZE_ITERATIONS && accepted.length) {
        iteration++;
        const simulated = this._simulateWayShape(way, graph, moveNodeLocs, accepted, removalsSet);
        const unsafeKeys = this._findUnsafeInsertionKeys(simulated);
        if (!unsafeKeys.size) break;

        const filtered = accepted.filter(insertion => !unsafeKeys.has(this._insertionKey(insertion)));
        if (filtered.length === accepted.length) break;
        accepted = filtered;
      }

      safeInsertions.push(...accepted);
    }

    return { insertions: safeInsertions, removals: removals };
  }


  _simulateWayShape(way, graph, moveNodeLocs, insertions, removalsSet) {
    const items = [];

    for (const nodeID of way.nodes ?? []) {
      const node = graph.hasEntity(nodeID);
      if (!node?.loc) continue;
      const loc = moveNodeLocs.get(nodeID) ?? node.loc;
      items.push({ nodeID: nodeID, loc: loc });
    }

    const sortedInsertions = insertions
      .slice()
      .sort((a, b) => (a.index - b.index) || ((a.t ?? 0) - (b.t ?? 0)));

    let insertedCount = 0;
    for (const insertion of sortedInsertions) {
      if (!this._isValidCoordinate(insertion.loc)) continue;
      const index = Math.max(0, Math.min(items.length, insertion.index + insertedCount));
      items.splice(index, 0, {
        nodeID: null,
        loc: insertion.loc,
        insertionKey: this._insertionKey(insertion)
      });
      insertedCount++;
    }

    return items.filter(item => {
      if (!item.nodeID) return true;
      return !removalsSet.has(item.nodeID);
    });
  }


  _findUnsafeInsertionKeys(items) {
    const unsafe = new Set();
    if (!Array.isArray(items) || items.length < 3) return unsafe;

    for (let i = 1; i < items.length - 1; i++) {
      const curr = items[i];
      if (!curr?.insertionKey) continue;

      const prevLoc = items[i - 1]?.loc;
      const currLoc = curr.loc;
      const nextLoc = items[i + 1]?.loc;
      if (!this._isValidCoordinate(prevLoc) || !this._isValidCoordinate(currLoc) || !this._isValidCoordinate(nextLoc)) {
        continue;
      }

      const directionChange = this._directionChangeDegrees(prevLoc, currLoc, nextLoc);
      if (!Number.isFinite(directionChange)) continue;
      if (directionChange > MAX_INSERT_DIRECTION_CHANGE_DEGREES) {
        unsafe.add(curr.insertionKey);
      }
    }

    return unsafe;
  }


  _insertionKey(insertion) {
    return `${insertion.wayID}:${insertion.index}:${insertion.loc[0]},${insertion.loc[1]}`;
  }


  _directionChangeDegrees(a, b, c) {
    if (!this._isValidCoordinate(a) || !this._isValidCoordinate(b) || !this._isValidCoordinate(c)) {
      return 0;
    }

    const latAB = (a[1] + b[1]) / 2;
    const latBC = (b[1] + c[1]) / 2;
    const abX = geoLonToMeters(b[0] - a[0], latAB);
    const abY = geoLatToMeters(b[1] - a[1]);
    const bcX = geoLonToMeters(c[0] - b[0], latBC);
    const bcY = geoLatToMeters(c[1] - b[1]);

    const lenAB = Math.sqrt(abX * abX + abY * abY);
    const lenBC = Math.sqrt(bcX * bcX + bcY * bcY);
    if (lenAB < MIN_TURN_CHECK_SEGMENT_METERS || lenBC < MIN_TURN_CHECK_SEGMENT_METERS) {
      return 0;
    }

    const dot = (abX * bcX + abY * bcY) / (lenAB * lenBC);
    const clamped = Math.max(-1, Math.min(1, dot));
    return Math.acos(clamped) * 180 / Math.PI;
  }


  _fractionAlongSegment(a, b, p) {
    if (!this._isValidCoordinate(a) || !this._isValidCoordinate(b) || !this._isValidCoordinate(p)) {
      return 0;
    }

    const atLat = (a[1] + b[1] + p[1]) / 3;
    const abX = geoLonToMeters(b[0] - a[0], atLat);
    const abY = geoLatToMeters(b[1] - a[1]);
    const apX = geoLonToMeters(p[0] - a[0], atLat);
    const apY = geoLatToMeters(p[1] - a[1]);
    const denominator = (abX * abX) + (abY * abY);
    if (denominator === 0) return 0;

    const t = ((apX * abX) + (apY * abY)) / denominator;
    return Math.max(0, Math.min(1, t));
  }


  /**
   * _nodeRemovable
   * @param   {osmNode} node
   * @param   {Graph} graph
   * @return  {boolean}
   */
  _nodeRemovable(node, graph) {
    return graph.parentWays(node).length === 1 &&
      graph.parentRelations(node).length === 0 &&
      !node.hasInterestingTags();
  }


  /**
   * _extentForWays
   * @param   {Array<osmWay>} ways
   * @param   {Graph} graph
   * @return  {Extent|null}
   */
  _extentForWays(ways, graph) {
    const extent = new Extent();
    let hasCoordinate = false;

    for (const way of ways) {
      if (!way || way.type !== 'way') continue;
      for (const nodeID of way.nodes) {
        const node = graph.hasEntity(nodeID);
        if (!node?.loc) continue;
        extent.extendSelf(node.loc);
        hasCoordinate = true;
      }
    }

    return hasCoordinate ? extent : null;
  }


  /**
   * _linesFromWays
   * @param   {Array<osmWay>} ways
   * @param   {Graph} graph
   * @return  {Array<Object>}
   */
  _linesFromWays(ways, graph) {
    const lines = [];
    for (const way of ways) {
      if (!way || way.type !== 'way') continue;

      const coords = way.nodes
        .map(nodeID => graph.hasEntity(nodeID))
        .filter(Boolean)
        .map(node => node.loc)
        .filter(loc => this._isValidCoordinate(loc));

      if (coords.length < 2) continue;
      const line = this._lineFromCoords(coords);
      if (line) lines.push(line);
    }
    return lines;
  }


  /**
   * _loadTileAsync
   * @param   {Object} tile
   * @return  {Promise}
   */
  _loadTileAsync(tile) {
    if (this._cache.loaded.has(tile.id) || this._cache.inflight.has(tile.id)) return;

    const url = this._tileURL(tile);
    const controller = new AbortController();
    this._cache.inflight.set(tile.id, controller);

    return fetch(url, { signal: controller.signal })
      .then(utilFetchResponse)
      .then(data => this._normalizeReferenceLines(data))
      .catch(err => {
        if (err.name === 'AbortError') throw err;
        if (err instanceof FetchError && err.status === 404) {
          return [];
        }
        throw err;
      })
      .then(lines => {
        this._cache.loaded.set(tile.id, { tile: tile, lines: lines });
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        this._cache.failed.set(tile.id, err);
      })
      .finally(() => {
        this._cache.inflight.delete(tile.id);
        this.emit('loadedData');
      });
  }


  /**
   * _normalizeReferenceLines
   * @param   {*} data
   * @return  {Array<Object>}
   */
  _normalizeReferenceLines(data) {
    const features = [];
    const lines = [];

    if (!data) return lines;

    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      features.push(...data.features);
    } else if (data.type === 'Feature') {
      features.push(data);
    } else if (data.type && data.coordinates) {
      features.push({ type: 'Feature', geometry: data, properties: {} });
    }

    for (const feature of features) {
      this._extractLineGeometries(feature?.geometry, lines);
    }

    return lines;
  }


  /**
   * _extractLineGeometries
   * @param   {Object} geometry
   * @param   {Array<Object>} output
   */
  _extractLineGeometries(geometry, output) {
    if (!geometry) return;

    if (geometry.type === 'LineString') {
      const line = this._lineFromCoords(geometry.coordinates);
      if (line) output.push(line);
      return;
    }

    if (geometry.type === 'MultiLineString') {
      for (const coords of geometry.coordinates ?? []) {
        const line = this._lineFromCoords(coords);
        if (line) output.push(line);
      }
      return;
    }

    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries ?? []) {
        this._extractLineGeometries(child, output);
      }
    }
  }


  /**
   * _lineFromCoords
   * @param   {Array} coords
   * @return  {Object|null}
   */
  _lineFromCoords(coords) {
    if (!Array.isArray(coords)) return null;

    const clean = coords.filter(coord => this._isValidCoordinate(coord));
    if (clean.length < 2) return null;

    const extent = new Extent();
    for (const coord of clean) {
      extent.extendSelf(coord);
    }

    return {
      coords: clean,
      extent: extent,
      bbox: extent.bbox()
    };
  }


  /**
   * _nearestReferencePoint
   * @param   {Array<number>} sample
   * @param   {Array<Object>} referenceLines
   * @param   {number} maxDistanceMeters
   * @return  {Array<number>|null}
   */
  _nearestReferencePoint(sample, referenceLines, maxDistanceMeters) {
    const lonPad = geoMetersToLon(maxDistanceMeters, sample[1]);
    const latPad = geoMetersToLat(maxDistanceMeters);

    let nearestPoint = null;
    let minDistance = Infinity;

    for (const line of referenceLines) {
      if (!line?.coords?.length) continue;
      const bbox = line.bbox;

      if (sample[0] < (bbox.minX - lonPad) || sample[0] > (bbox.maxX + lonPad) ||
          sample[1] < (bbox.minY - latPad) || sample[1] > (bbox.maxY + latPad)) {
        continue;
      }

      const edge = vecProject(sample, line.coords);
      if (!edge) continue;

      const distance = geoSphericalDistance(sample, edge.target);
      if (distance < minDistance) {
        minDistance = distance;
        nearestPoint = edge.target;
      }
    }

    return minDistance <= maxDistanceMeters ? nearestPoint : null;
  }


  /**
   * _sampleLinePoints
   * @param   {Array<Array<number>>} coords
   * @param   {number} spacingMeters
   * @param   {number} maxSamples
   * @return  {Array<Array<number>>}
   */
  _sampleLinePoints(coords, spacingMeters, maxSamples) {
    if (!Array.isArray(coords) || coords.length < 2) return [];

    let totalLength = 0;
    for (let i = 1; i < coords.length; i++) {
      totalLength += geoSphericalDistance(coords[i - 1], coords[i]);
    }

    if (totalLength === 0) return [coords[0]];

    const maxBySpacing = Math.floor(totalLength / spacingMeters) + 1;
    const sampleCount = Math.max(2, Math.min(maxSamples, maxBySpacing));
    const interval = totalLength / (sampleCount - 1);

    const samples = [coords[0]];
    let accumulated = 0;
    let nextDist = interval;

    for (let i = 1; i < coords.length && samples.length < sampleCount; i++) {
      const segLen = geoSphericalDistance(coords[i - 1], coords[i]);
      const prevAccum = accumulated;
      accumulated += segLen;

      while (nextDist <= accumulated && samples.length < sampleCount) {
        const t = segLen > 0 ? (nextDist - prevAccum) / segLen : 0;
        const lon = coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]);
        const lat = coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]);
        samples.push([lon, lat]);
        nextDist += interval;
      }
    }

    if (samples.length < sampleCount) {
      samples.push(coords[coords.length - 1]);
    }

    return samples;
  }


  /**
   * _tilesForExtent
   * @param   {Extent} extent
   * @return  {Array<Object>}
   */
  _tilesForExtent(extent) {
    const z = TILE_ZOOM;
    const maxIndex = Math.pow(2, z) - 1;

    const minLon = this._clampLon(extent.min[0]);
    const maxLon = this._clampLon(extent.max[0]);
    const minLat = this._clampLat(extent.min[1]);
    const maxLat = this._clampLat(extent.max[1]);

    let minX = this._lonToTileX(minLon, z) - TILE_MARGIN;
    let maxX = this._lonToTileX(maxLon, z) + TILE_MARGIN;
    let minY = this._latToTileY(maxLat, z) - TILE_MARGIN;
    let maxY = this._latToTileY(minLat, z) + TILE_MARGIN;

    minX = Math.max(0, minX);
    maxX = Math.min(maxIndex, maxX);
    minY = Math.max(0, minY);
    maxY = Math.min(maxIndex, maxY);

    const tiles = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const tile = {
          x: x,
          y: y,
          z: z,
          id: `${x},${y},${z}`,
          extent: this._tileExtent(x, y, z)
        };
        tiles.push(tile);
      }
    }
    return tiles;
  }


  /**
   * _tileURL
   * @param   {Object} tile
   * @return  {string}
   */
  _tileURL(tile) {
    return this._tileTemplate
      .replace('{x}', tile.x)
      .replace('{y}', tile.y)
      .replace(/\{[t-]y\}/, Math.pow(2, tile.z) - tile.y - 1)
      .replace(/\{z(oom)?\}/, tile.z);
  }


  /**
   * _tileExtent
   * @param   {number} x
   * @param   {number} y
   * @param   {number} z
   * @return  {Extent}
   */
  _tileExtent(x, y, z) {
    const minLon = this._tileXToLon(x, z);
    const maxLon = this._tileXToLon(x + 1, z);
    const maxLat = this._tileYToLat(y, z);
    const minLat = this._tileYToLat(y + 1, z);
    return new Extent([minLon, minLat], [maxLon, maxLat]);
  }


  _lonToTileX(lon, z) {
    const n = Math.pow(2, z);
    const x = (this._clampLon(lon) + 180) / 360 * n;
    return Math.min(n - 1, Math.max(0, Math.floor(x)));
  }


  _latToTileY(lat, z) {
    const n = Math.pow(2, z);
    const clampedLat = this._clampLat(lat);
    const rad = clampedLat * Math.PI / 180;
    const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2));
    const y = (1 - merc / Math.PI) / 2 * n;
    return Math.min(n - 1, Math.max(0, Math.floor(y)));
  }


  _tileXToLon(x, z) {
    return x / Math.pow(2, z) * 360 - 180;
  }


  _tileYToLat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }


  _offsetDistanceMeters(deltaLon, deltaLat, atLat) {
    const x = geoLonToMeters(deltaLon, atLat);
    const y = geoLatToMeters(deltaLat);
    return Math.sqrt(x * x + y * y);
  }


  _median(values) {
    if (!values?.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return (sorted.length % 2)
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }


  _isValidCoordinate(coord) {
    return Array.isArray(coord) &&
      coord.length >= 2 &&
      Number.isFinite(coord[0]) &&
      Number.isFinite(coord[1]);
  }


  _clampLon(lon) {
    return Math.max(-180, Math.min(180, lon));
  }


  _clampLat(lat) {
    return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  }

}
