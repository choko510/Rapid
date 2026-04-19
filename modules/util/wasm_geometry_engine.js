import * as Polyclip from 'polyclip-ts';
import * as ClipperLib from 'js-angusj-clipper/web/index.js';

const CLIPPER_SCALE = 1e7;
const DEFAULT_INTERSECTION_VERTEX_THRESHOLD = 1200;
const DEFAULT_UNION_VERTEX_THRESHOLD = 1800;
const DEFAULT_UNION_POLYGON_THRESHOLD = 4;

let SHARED_CLIPPER_PROMISE = null;
let SHARED_CLIPPER_INSTANCE = null;


export class WasmGeometryEngine {

  constructor(options = {}) {
    this._hashParam = options.hashParam ?? 'wasm_geometry';
    this._benchmarkIterations = options.benchmarkIterations ?? 20;
    this._minWasmRatio = options.minWasmRatio ?? 0.9;
    this._intersectionVertexThreshold = options.intersectionVertexThreshold ?? DEFAULT_INTERSECTION_VERTEX_THRESHOLD;
    this._unionVertexThreshold = options.unionVertexThreshold ?? DEFAULT_UNION_VERTEX_THRESHOLD;
    this._unionPolygonThreshold = options.unionPolygonThreshold ?? DEFAULT_UNION_POLYGON_THRESHOLD;

    this._clipper = null;
    this._clipTypeIntersection = null;
    this._clipTypeUnion = null;
    this._fillTypeEvenOdd = null;

    this._modes = {
      intersection: 'polyclip',
      union: 'polyclip'
    };

    this._ringPathCache = new WeakMap();
    this._polygonPathCache = new WeakMap();
    this._initPromise = null;
  }


  canUseWasm(operation) {
    return !!this._clipper && (operation === 'intersection' || operation === 'union');
  }


  usesWasm(operation) {
    return (this._modes[operation] === 'wasm' && !!this._clipper);
  }


  toClipperPaths(polyCoords) {
    if (!Array.isArray(polyCoords)) return [];

    if (this._polygonPathCache.has(polyCoords)) {
      return this._polygonPathCache.get(polyCoords);
    }

    const paths = polyCoords.map(ring => this._toClipperPath(ring)).filter(Boolean);
    this._polygonPathCache.set(polyCoords, paths);
    return paths;
  }


  initAsync(ops = {}) {
    if (this._initPromise) return this._initPromise;
    if (!this._isEnabledByHash()) return Promise.resolve();

    const wantsIntersection = !!ops.intersection;
    const wantsUnion = !!ops.union;
    if (!wantsIntersection && !wantsUnion) return Promise.resolve();

    this._initPromise = Promise.resolve()
      .then(() => {
        this._clipTypeIntersection = ClipperLib?.ClipType?.Intersection;
        this._clipTypeUnion = ClipperLib?.ClipType?.Union;
        this._fillTypeEvenOdd = ClipperLib?.PolyFillType?.EvenOdd;
        const requestedFormat = ClipperLib?.NativeClipperLibRequestedFormat?.WasmWithAsmJsFallback;

        if (!requestedFormat || !this._clipTypeIntersection || !this._clipTypeUnion || !this._fillTypeEvenOdd) {
          return;
        }

        return this._loadSharedClipperAsync(requestedFormat)
          .then(clipper => {
            if (!clipper) return;
            this._clipper = clipper;

            if (wantsIntersection && this._shouldUseWasmForIntersection()) {
              this._modes.intersection = 'wasm';
            }
            if (wantsUnion && this._shouldUseWasmForUnion()) {
              this._modes.union = 'wasm';
            }
          });
      })
      .catch(() => {
        // Keep polyclip modes.
      });

    return this._initPromise;
  }


  intersects(subjectCoords, clipCoords, subjectClipperPaths = null, clipClipperPaths = null) {
    if (this._shouldUseWasmIntersection(subjectCoords, clipCoords)) {
      try {
        const s = subjectClipperPaths ?? this.toClipperPaths(subjectCoords);
        const c = clipClipperPaths ?? this.toClipperPaths(clipCoords);
        return this._wasmIntersects(s, c);
      } catch (err) {
        // Fall through to polyclip on any WASM error.
      }
    }

    const intersection = Polyclip.intersection(subjectCoords, clipCoords);
    return !!(intersection && intersection.length > 0);
  }


  intersectsAny(subjectCoords, clipCoordsList, subjectClipperPaths = null, clipClipperPathsList = null) {
    if (!Array.isArray(clipCoordsList) || !clipCoordsList.length) return false;

    if (this._shouldUseWasmIntersectionAny(subjectCoords, clipCoordsList)) {
      try {
        const subjectPaths = subjectClipperPaths ?? this.toClipperPaths(subjectCoords);
        const clipInputs = this._toClipInputs(clipCoordsList, clipClipperPathsList);
        if (subjectPaths.length && clipInputs.length) {
          return this._wasmIntersectsAny(subjectPaths, clipInputs);
        }
      } catch (err) {
        // Fall through to polyclip on any WASM error.
      }
    }

    for (const clipCoords of clipCoordsList) {
      try {
        const intersection = Polyclip.intersection(subjectCoords, clipCoords);
        if (intersection?.length) return true;
      } catch (err) {
        continue;
      }
    }

    return false;
  }


  unionPolygons(polygons) {
    if (this._shouldUseWasmUnion(polygons)) {
      try {
        const merged = this._wasmUnionPolygons(polygons);
        if (merged?.length) return merged;
      } catch (err) {
        // Fall through to polyclip on any WASM error.
      }
    }
    return Polyclip.union(...polygons);
  }


  _isEnabledByHash() {
    if (typeof window === 'undefined') return true;

    const hash = window.location?.hash ?? '';
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const raw = params.get(this._hashParam);
    if (!raw) return true;

    const val = raw.toLowerCase();
    if (val === '0' || val === 'false' || val === 'off') return false;
    if (val === '1' || val === 'true' || val === 'on') return true;
    return true;
  }


  _toClipperPath(ring) {
    if (!this._isRing(ring)) return null;

    if (this._ringPathCache.has(ring)) {
      return this._ringPathCache.get(ring);
    }

    const path = ring.map(([x, y]) => ({
      x: Math.round(x * CLIPPER_SCALE),
      y: Math.round(y * CLIPPER_SCALE)
    }));
    this._ringPathCache.set(ring, path);
    return path;
  }


  _isRing(coords) {
    return Array.isArray(coords) &&
      coords.length > 0 &&
      Array.isArray(coords[0]) &&
      Number.isFinite(coords[0][0]) &&
      Number.isFinite(coords[0][1]);
  }


  _loadSharedClipperAsync(requestedFormat) {
    if (SHARED_CLIPPER_INSTANCE) {
      return Promise.resolve(SHARED_CLIPPER_INSTANCE);
    }

    const loadNative = ClipperLib?.loadNativeClipperLibInstanceAsync;
    if (typeof loadNative !== 'function') {
      return Promise.resolve(null);
    }

    if (!SHARED_CLIPPER_PROMISE) {
      SHARED_CLIPPER_PROMISE = loadNative(requestedFormat)
        .then(clipper => {
          SHARED_CLIPPER_INSTANCE = clipper ?? null;
          return SHARED_CLIPPER_INSTANCE;
        })
        .catch(() => {
          SHARED_CLIPPER_PROMISE = null;
          return null;
        });
    }

    return SHARED_CLIPPER_PROMISE;
  }


  _toClipInputs(clipCoordsList, clipClipperPathsList = null) {
    const clipInputs = [];

    for (let i = 0; i < clipCoordsList.length; i++) {
      const coords = clipCoordsList[i];
      const paths = clipClipperPathsList?.[i] ?? this.toClipperPaths(coords);
      if (paths?.length) {
        clipInputs.push({ data: paths });
      }
    }

    return clipInputs;
  }


  _wasmIntersectsAny(subjectClipperPaths, clipInputs) {
    if (!this._clipper || !subjectClipperPaths?.length || !clipInputs?.length) {
      return false;
    }

    const result = this._clipper.clipToPaths({
      clipType: this._clipTypeIntersection,
      subjectFillType: this._fillTypeEvenOdd,
      clipFillType: this._fillTypeEvenOdd,
      subjectInputs: [{ data: subjectClipperPaths, closed: true }],
      clipInputs: clipInputs
    });

    return !!(result && result.length > 0);
  }


  _wasmIntersects(subjectClipperPaths, clipClipperPaths) {
    if (!this._clipper || !subjectClipperPaths?.length || !clipClipperPaths?.length) {
      return false;
    }

    const result = this._clipper.clipToPaths({
      clipType: this._clipTypeIntersection,
      subjectFillType: this._fillTypeEvenOdd,
      clipFillType: this._fillTypeEvenOdd,
      subjectInputs: [{ data: subjectClipperPaths, closed: true }],
      clipInputs: [{ data: clipClipperPaths }]
    });

    return !!(result && result.length > 0);
  }


  _wasmUnionPolygons(polygons) {
    if (!this._clipper || !Array.isArray(polygons) || !polygons.length) return [];

    const subjectPaths = this._collectSubjectPaths(polygons);
    if (!subjectPaths.length) return [];

    const polyTree = this._clipper.clipToPolyTree({
      clipType: this._clipTypeUnion,
      subjectFillType: this._fillTypeEvenOdd,
      clipFillType: this._fillTypeEvenOdd,
      subjectInputs: [{ data: subjectPaths, closed: true }]
    });

    return this._polyTreeToMultiPolygon(polyTree);
  }


  _collectSubjectPaths(polygons) {
    const subjectPaths = [];

    for (const polygonOrMulti of polygons) {
      const first = polygonOrMulti?.[0];
      if (this._isRing(first)) {   // Polygon (array of rings)
        for (const ring of polygonOrMulti) {
          const path = this._toClipperPath(ring);
          if (path) subjectPaths.push(path);
        }
      } else if (Array.isArray(first)) {  // MultiPolygon (array of polygons)
        for (const polygon of polygonOrMulti) {
          for (const ring of polygon) {
            const path = this._toClipperPath(ring);
            if (path) subjectPaths.push(path);
          }
        }
      }
    }

    return subjectPaths;
  }


  _shouldUseWasmIntersection(subjectCoords, clipCoords) {
    if (!this.canUseWasm('intersection')) return false;
    if (this._modes.intersection === 'wasm') return true;

    const totalVertices = this._countVertices(subjectCoords) + this._countVertices(clipCoords);
    return totalVertices >= this._intersectionVertexThreshold;
  }


  _shouldUseWasmIntersectionAny(subjectCoords, clipCoordsList) {
    if (!this.canUseWasm('intersection')) return false;
    if (this._modes.intersection === 'wasm') return true;
    if (clipCoordsList.length >= 3) return true;

    let totalVertices = this._countVertices(subjectCoords);
    for (const clipCoords of clipCoordsList) {
      totalVertices += this._countVertices(clipCoords);
      if (totalVertices >= this._intersectionVertexThreshold) {
        return true;
      }
    }

    return false;
  }


  _shouldUseWasmUnion(polygons) {
    if (!this.canUseWasm('union')) return false;
    if (this._modes.union === 'wasm') return true;
    if (!Array.isArray(polygons) || !polygons.length) return false;
    if (polygons.length >= this._unionPolygonThreshold) return true;

    let totalVertices = 0;
    for (const polygon of polygons) {
      totalVertices += this._countVertices(polygon);
      if (totalVertices >= this._unionVertexThreshold) {
        return true;
      }
    }

    return false;
  }


  _countVertices(coords) {
    if (!Array.isArray(coords) || !coords.length) return 0;

    const first = coords[0];
    if (!Array.isArray(first)) return 0;

    if (Number.isFinite(first[0]) && Number.isFinite(first[1])) {
      return coords.length;
    }

    let count = 0;
    for (const child of coords) {
      count += this._countVertices(child);
    }

    return count;
  }


  _polyTreeToMultiPolygon(polyTree) {
    const result = [];
    if (!polyTree?.childs?.length) return result;

    const walk = (node) => {
      if (!node || node.isOpen) return;

      if (!node.isHole) {
        const outer = this._fromIntPath(node.contour);
        if (outer.length >= 4) {
          const rings = [outer];
          for (const child of node.childs) {
            if (child?.isOpen || !child?.isHole) continue;
            const hole = this._fromIntPath(child.contour);
            if (hole.length >= 4) {
              rings.push(hole);
            }
          }
          result.push(rings);
        }
      }

      for (const child of node.childs) {
        walk(child);
      }
    };

    for (const child of polyTree.childs) {
      walk(child);
    }

    return result;
  }


  _fromIntPath(path) {
    if (!Array.isArray(path) || !path.length) return [];

    const ring = path.map(point => [
      point.x / CLIPPER_SCALE,
      point.y / CLIPPER_SCALE
    ]);

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
      ring.push([first[0], first[1]]);
    }
    return ring;
  }


  _makeBenchCircle(centerX, centerY, radius, points) {
    const ring = [];
    for (let i = 0; i < points; i++) {
      const t = (i / points) * Math.PI * 2;
      ring.push([centerX + Math.cos(t) * radius, centerY + Math.sin(t) * radius]);
    }
    ring.push(ring[0]);
    return ring;
  }


  _shouldUseWasmForIntersection() {
    if (!this._clipper) return false;

    const subjectRing = this._makeBenchCircle(0, 0, 0.03, 256);
    const clipRing = this._makeBenchCircle(0.01, 0.005, 0.03, 256);
    const subjectPoly = [subjectRing];
    const clipPoly = [clipRing];

    const iter = this._benchmarkIterations;
    const now = () => globalThis.performance?.now?.() ?? Date.now();

    const t0 = now();
    for (let i = 0; i < iter; i++) {
      Polyclip.intersection(subjectPoly, clipPoly);
    }
    const polyclipMs = now() - t0;

    const subjectClipperPaths = this.toClipperPaths(subjectPoly);
    const clipClipperPaths = this.toClipperPaths(clipPoly);
    const t1 = now();
    for (let i = 0; i < iter; i++) {
      this._wasmIntersects(subjectClipperPaths, clipClipperPaths);
    }
    const wasmMs = now() - t1;

    return Number.isFinite(wasmMs) && Number.isFinite(polyclipMs) && wasmMs < (polyclipMs * this._minWasmRatio);
  }


  _shouldUseWasmForUnion() {
    if (!this._clipper) return false;

    const ringA = this._makeBenchCircle(0, 0, 0.03, 256);
    const ringB = this._makeBenchCircle(0.01, 0.005, 0.03, 256);
    const polyA = [ringA];
    const polyB = [ringB];

    const iter = this._benchmarkIterations;
    const now = () => globalThis.performance?.now?.() ?? Date.now();

    const t0 = now();
    for (let i = 0; i < iter; i++) {
      Polyclip.union(polyA, polyB);
    }
    const polyclipMs = now() - t0;

    const t1 = now();
    for (let i = 0; i < iter; i++) {
      this._wasmUnionPolygons([polyA, polyB]);
    }
    const wasmMs = now() - t1;

    return Number.isFinite(wasmMs) && Number.isFinite(polyclipMs) && wasmMs < (polyclipMs * this._minWasmRatio);
  }

}
