import { Extent, geomGetSmallestSurroundingRectangle, vecInterp } from '@rapid-sdk/math';
import { polygonHull, polygonCentroid } from 'd3-polygon';
import polylabel from '@mapbox/polylabel';


/**
 * PixiGeometry
 * Wrapper for geometry data, used by the various PixiFeatureXXX classes
 * Because recalculating and reprojecting geometry is expensive, this class tries to do it only if necessary.
 *
 * The geometry data should be passed to `setCoords()`
 *
 * Properties you can access:
 *   `type`          String describing what kind of geometry this is ('point', 'line', 'polygon')
 *   `origCoords`    Original coordinate data (in WGS84 long/lat)
 *   `origExtent`    Original extent (the bounds of the geometry)
 *   `origHull`      Original convex hull
 *   `origCentroid`  Original centroid (center of mass / rotation), [ lon, lat ]
 *   `origPoi`       Original pole of inaccessability, [ lon, lat ]
 *   `origSsr`       Original smallest surrounding rectangle
 *   `coords`        Projected coordinate data
 *   `flatCoords`    Projected coordinate data, flat Array how Pixi wants it [ x,y, x,y, … ]
 *   `extent`        Projected extent
 *   `outer`         Projected outer ring, Array of coordinate pairs [ [x,y], [x,y], … ]
 *   `flatOuter`     Projected outer ring, flat Array how Pixi wants it [ x,y, x,y, … ]
 *   `holes`         Projected hole rings, Array of Array of coordinate pairs [ [ [x,y], [x,y], … ] ]
 *   `flatHoles`     Projected hole rings, Array of flat Array how Pixi wants it [ [ x,y, x,y, … ] ]
 *   `hull`          Projected convex hull, Array of coordinate pairs [ [x,y], [x,y], … ]
 *   `centroid`      Projected centroid, [x, y]
 *   `poi`           Projected pole of inaccessability, [x, y]
 *   `ssr`           Projected smallest surrounding rectangle data (angle, poly)
 *   `width`         Width of projected shape, in pixels
 *   `height`        Height of projected shape, in pixels
 *   `lod`           Level of detail for the geometry (0 = off, 1 = simplified, 2 = full)
 */
export class PixiGeometry {

  /**
   * @constructor
   */
  constructor() {
    this.type = null;      // 'point', 'line', or 'polygon'
    this.dirty = true;
    this.reset();
  }


  /**
   * destroy
   * Release memory.
   * Do not use the geometry after calling `destroy()`.
   */
  destroy() {
    this.reset();
  }


  /**
   * reset
   * Remove all stored data
   */
  reset() {
    // Original data - These are in WGS84 coordinates
    // ([0,0] is Null Island)
    this.origCoords = null;     // coordinate data
    this.origExtent = null;     // extent (bounding box)
    this.origHull = null;       // convex hull
    this.origCentroid = null;   // centroid (center of mass / rotation)
    this.origPoi = null;        // pole of inaccessability
    this.origSsr = null;        // smallest surrounding rectangle

    // The rest of the data is projected data in screen coordinates
    // ([0,0] is the origin of the Pixi scene)
    this.coords = null;
    this.flatCoords = null;
    this.extent = null;
    this.hull = null;
    this.centroid = null;
    this.poi = null;
    this.ssr = null;

    this.outer = null;
    this.flatOuter = null;
    this.holes = null;
    this.flatHoles = null;

    this.width = 0;
    this.height = 0;
    this.lod = 0;

    // Cached projected data reused between `update()` calls to reduce allocations.
    this._projExtent = null;
    this._extentTopLeft = null;
    this._extentBottomRight = null;
    this._projRings = null;
    this._projFlatRings = null;
    this._projHoles = null;
    this._projFlatHoles = null;
    this._projHull = null;
    this._projSsr = null;
  }


  /**
   * update
   * @param  {Viewport}  viewport - Pixi viewport to use for rendering
   */
  update(viewport) {
    if (!this.dirty || !this.origCoords || !this.origExtent) return;  // nothing to do
    this.dirty = false;

    // reset all projected properties
    this.coords = null;
    this.flatCoords = null;
    this.extent = null;
    this.outer = null;
    this.flatOuter = null;
    this.holes = null;
    this.flatHoles = null;
    this.hull = null;
    this.centroid = null;
    this.poi = null;
    this.ssr = null;

    // Points are simple, just project once.
    if (this.type === 'point') {
      this.coords = viewport.project(this.origCoords);
      const extent = this._projExtent ?? (this._projExtent = new Extent());
      extent.min[0] = this.coords[0];
      extent.min[1] = this.coords[1];
      extent.max[0] = this.coords[0];
      extent.max[1] = this.coords[1];
      this.extent = extent;
      this.centroid = this.coords;
      this.width = 0;
      this.height = 0;
      this.lod = 2;  // full detail
      return;
    }

    // A line or a polygon.

    // First, project extent..
    const extent = this._projExtent ?? (this._projExtent = new Extent());
    this.extent = extent;
    // Watch out, we can't project min/max directly (because Y is flipped).
    // Construct topLeft, bottomRight corners and project those.
    const topLeft = this._extentTopLeft ?? (this._extentTopLeft = [0, 0]);
    topLeft[0] = this.origExtent.min[0];
    topLeft[1] = this.origExtent.max[1];
    const bottomRight = this._extentBottomRight ?? (this._extentBottomRight = [0, 0]);
    bottomRight[0] = this.origExtent.max[0];
    bottomRight[1] = this.origExtent.min[1];
    const projMin = viewport.project(topLeft);
    const projMax = viewport.project(bottomRight);
    extent.min[0] = projMin[0];
    extent.min[1] = projMin[1];
    extent.max[0] = projMax[0];
    extent.max[1] = projMax[1];

    const [minX, minY] = extent.min;
    const [maxX, maxY] = extent.max;
    this.width = maxX - minX;
    this.height = maxY - minY;

    // So small, don't waste time on it.
    if (this.width < 4 && this.height < 4) {
      this.lod = 0;
      return;
    }


    // Reproject the coordinate data..
    // Generate both normal coordinate rings and flattened rings at the same time to avoid extra iterations.
    // Preallocate Arrays to avoid garbage collection formerly caused by excessive Array.push()
    const origRings = (this.type === 'line') ? [this.origCoords] : this.origCoords;
    let projRings = this._projRings;
    if (!projRings || projRings.length !== origRings.length) {
      projRings = new Array(origRings.length);
      this._projRings = projRings;
    }
    let projFlatRings = this._projFlatRings;
    if (!projFlatRings || projFlatRings.length !== origRings.length) {
      projFlatRings = new Array(origRings.length);
      this._projFlatRings = projFlatRings;
    }

    for (let i = 0; i < origRings.length; ++i) {
      const origRing = origRings[i];
      let projRing = projRings[i];
      if (!projRing || projRing.length !== origRing.length) {
        projRing = new Array(origRing.length);
        projRings[i] = projRing;
      }
      let projFlatRing = projFlatRings[i];
      if (!projFlatRing || projFlatRing.length !== (origRing.length * 2)) {
        projFlatRing = new Array(origRing.length * 2);
        projFlatRings[i] = projFlatRing;
      }

      for (let j = 0; j < origRing.length; ++j) {
        const xy = viewport.project(origRing[j]);
        const prev = projRing[j];
        if (prev) {
          prev[0] = xy[0];
          prev[1] = xy[1];
        } else {
          projRing[j] = xy;
        }

        const k = j * 2;
        projFlatRing[k] = xy[0];
        projFlatRing[k + 1] = xy[1];
      }
    }

    // Assign outer and holes
    if (this.type === 'line') {
      this.coords = projRings[0];
      this.flatCoords = projFlatRings[0];
      this.outer = projRings[0];
      this.flatOuter = projFlatRings[0];
      this.holes = null;
      this.flatHoles = null;
    } else {
      this.coords = projRings;
      this.flatCoords = projFlatRings;
      this.outer = projRings[0];
      this.flatOuter = projFlatRings[0];
      const holeCount = Math.max(0, projRings.length - 1);
      let holes = this._projHoles;
      if (!holes || holes.length !== holeCount) {
        holes = new Array(holeCount);
        this._projHoles = holes;
      }
      let flatHoles = this._projFlatHoles;
      if (!flatHoles || flatHoles.length !== holeCount) {
        flatHoles = new Array(holeCount);
        this._projFlatHoles = flatHoles;
      }
      for (let i = 0; i < holeCount; ++i) {
        holes[i] = projRings[i + 1];
        flatHoles[i] = projFlatRings[i + 1];
      }
      this.holes = holes;
      this.flatHoles = flatHoles;
    }

    // Calculate hull, centroid, poi, ssr if possible
    if (this.outer.length === 0) {          // no coordinates? - shouldn't happen
      // no-op

    } else if (this.outer.length === 1) {   // single coordinate? - wrong but can happen
      this.centroid = this.outer[0];
      this.origCentroid = viewport.unproject(this.centroid);
      this.poi = this.centroid;
      this.origPoi = this.origCentroid;

    } else if (this.outer.length === 2) {   // 2 coordinate line
      this.centroid = vecInterp(this.outer[0], this.outer[1], 0.5);  // average the 2 points
      this.origCentroid = viewport.unproject(this.centroid);
      this.poi = this.centroid;
      this.origPoi = this.origCentroid;

    } else {     // > 2 coordinates...

      // Convex Hull
      if (this.origHull) {   // calculated already, reproject
        let hull = this._projHull;
        if (!hull || hull.length !== this.origHull.length) {
          hull = new Array(this.origHull.length);
          this._projHull = hull;
        }
        for (let i = 0; i < this.origHull.length; ++i) {
          const xy = viewport.project(this.origHull[i]);
          const prev = hull[i];
          if (prev) {
            prev[0] = xy[0];
            prev[1] = xy[1];
          } else {
            hull[i] = xy;
          }
        }
        this.hull = hull;
      } else {               // recalculate and store as WGS84
        this.hull = polygonHull(this.outer);
        if (this.hull) {
          this._projHull = this.hull;
          this.origHull = new Array(this.hull.length);
          for (let i = 0; i < this.origHull.length; ++i) {
            this.origHull[i] = viewport.unproject(this.hull[i]);
          }
        }
      }

      // Centroid
      if (this.origCentroid) {   // calculated already, reproject
        this.centroid = viewport.project(this.origCentroid);
      } else if (this.hull) {    // recalculate and store as WGS84
        if (this.hull.length === 2) {
          this.centroid = vecInterp(this.hull[0], this.hull[1], 0.5);  // average the 2 points
        } else {
          this.centroid = polygonCentroid(this.hull);
        }
        this.origCentroid = viewport.unproject(this.centroid);
      }

      // Pole of Inaccessability
      if (this.origPoi) {    // calculated already, reproject
        this.poi = viewport.project(this.origPoi);
      } else {               // recalculate and store as WGS84
        this.poi = polylabel(this.coords);   // it expects outer + rings
        this.origPoi = viewport.unproject(this.poi);
      }

      // Smallest Surrounding Rectangle
      if (this.origSsr) {        // calculated already, reproject
        let ssr = this._projSsr;
        if (!ssr || !ssr.poly || ssr.poly.length !== this.origSsr.poly.length) {
          ssr = { angle: this.origSsr.angle, poly: new Array(this.origSsr.poly.length) };
          this._projSsr = ssr;
        }
        ssr.angle = this.origSsr.angle;
        for (let i = 0; i < this.origSsr.poly.length; ++i) {
          const xy = viewport.project(this.origSsr.poly[i]);
          const prev = ssr.poly[i];
          if (prev) {
            prev[0] = xy[0];
            prev[1] = xy[1];
          } else {
            ssr.poly[i] = xy;
          }
        }
        this.ssr = ssr;
      } else if (this.hull) {    // recalculate and store as WGS84
        this.ssr = geomGetSmallestSurroundingRectangle(this.hull);
        if (this.ssr) {
          this._projSsr = this.ssr;
          this.origSsr = { angle: this.ssr.angle, poly: new Array(this.ssr.poly.length) };
          for (let i = 0; i < this.ssr.poly.length; ++i) {
            this.origSsr.poly[i] = viewport.unproject(this.ssr.poly[i]);
          }
        }
      }
    }

    this.lod = 2;   // full detail (for now)
  }


  /**
   * setCoords
   * @param {Array<*>} data - Geometry `Array` (contents depends on the Feature type)
   *
   * 'point' - Single wgs84 coordinate
   *    [lon, lat]
   *
   * 'line' - Array of coordinates
   *    [ [lon, lat], [lon, lat],  … ]
   *
   * 'polygon' - Array of Arrays
   *    [
   *      [ [lon, lat], [lon, lat], … ],   // outer ring
   *      [ [lon, lat], [lon, lat], … ],   // inner rings
   *      …
   *    ]
   */
  setCoords(data) {
    const type = this._inferType(data);
    if (!type) return;  // do nothing if data is missing

    this.reset();
    this.type = type;
    this.origCoords = data;

    // Determine extent (bounds)
    if (type === 'point') {
      this.origExtent = new Extent(data);
      this.origCentroid = data;

    } else {
      this.origExtent = new Extent();
      const outer = (this.type === 'line') ? this.origCoords : this.origCoords[0];  // outer only
      for (const loc of outer) {
        this.origExtent.extendSelf(loc);
      }
    }

    this.dirty = true;
  }


  /**
   * _inferType
   * Determines what kind of geometry we were passed.
   * @param   {Array<*>}  arr - Geometry `Array` (contents depends on the Feature type)
   * @return  {string?}   'point', 'line', 'polygon' or null
   */
  _inferType(data) {
    const a = Array.isArray(data) && data[0];
    if (typeof a === 'number') return 'point';

    const b = Array.isArray(a) && a[0];
    if (typeof b === 'number') return 'line';

    const c = Array.isArray(b) && b[0];
    if (typeof c === 'number') return 'polygon';

    return null;
  }

}
