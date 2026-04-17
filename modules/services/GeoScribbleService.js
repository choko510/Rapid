import { Tiler } from '@rapid-sdk/math';
import { utilQsString } from '@rapid-sdk/util';
import RBush from 'rbush';
import { geojsonExtent } from '../util/util.js';
import { AbstractSystem } from '../core/AbstractSystem.js';
import { utilFetchResponse, utilLRUSetAdd } from '../util/index.js';


const TILEZOOM = 16.5;
const GEOSCRIBBLE_API = 'https://geoscribble.osmz.ru/geojson';


/**
 * `GeoScribbleService`
 * GeoScribble is a service that allows users to collaboratively draw on the map.
 * This service connects to the GeoScribble API to fetch public 'scribbles'.
 * @see https://wiki.openstreetmap.org/wiki/GeoScribble
 * @see https://geoscribble.osmz.ru/docs
 * @see https://github.com/Zverik/geoscribble
 *
 * Events available:
 *   'loadedData'
 */
export class GeoScribbleService extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'geoScribble';
    this.autoStart = false;
    this._nextID = 0;

    this._cache = {};
    this._tiler = new Tiler().zoomRange(TILEZOOM).skipNullIsland(true);
    this._maxLoadedTiles = 300;
    this._maxShapes = 25000;
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
   * Called after completing an edit session to reset any internal state
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    if (this._cache.inflightTile) {
      Object.values(this._cache.inflightTile).forEach(controller => this._abortRequest(controller));
    }
    this._nextID = 0;
    this._cache = {
      shapes: {},
      loadedTile: {},
      loadedTileOrder: new Set(),   // Set<tileID> ordered least-recently-used -> most-recently-used
      shapeOrder: new Set(),        // Set<shapeID> ordered least-recently-used -> most-recently-used
      tileShapeIDs: {},             // Object<tileID -> Set<shapeID>>
      shapeTileIDs: {},             // Object<shapeID -> tileID>
      inflightTile: {},
      rbush: new RBush()
    };

    return Promise.resolve();
  }


  /**
   * getData
   * Get already loaded image data that appears in the current map view
   * @return  {Array}  Array of image data
   */
  getData() {
    const extent = this.context.viewport.visibleExtent();
    return this._cache.rbush.search(extent.bbox()).map(d => d.data);
  }


  /**
   * getNextID
   * Get a unique ID
   * @return  {string}   Unique ID
   */
  getNextID() {
    return (this._nextID++).toString();
  }


  /**
   * loadTiles
   * Schedule any data requests needed to cover the current map view
   */
  loadTiles() {
    const cache = this._cache;

    // determine the needed tiles to cover the view
    const viewport = this.context.viewport;
    const tiles = this._tiler.getTiles(viewport).tiles;
    const wantedTileIDs = new Set(tiles.map(tile => tile.id));

    // Abort inflight requests that are no longer needed
    this._abortUnwantedRequests(cache, tiles);

    // Issue new requests..
    for (const tile of tiles) {
      if (cache.loadedTile[tile.id]) {
        utilLRUSetAdd(cache.loadedTileOrder, tile.id);
      }
      if (cache.loadedTile[tile.id] || cache.inflightTile[tile.id]) continue;

      const rect = tile.wgs84Extent.rectangle().join(',');
      const url = GEOSCRIBBLE_API + '?' + utilQsString({ bbox: rect });

      const controller = new AbortController();
      cache.inflightTile[tile.id] = controller;

      fetch(url, { signal: controller.signal })
        .then(utilFetchResponse)
        .then(data => {
          cache.loadedTile[tile.id] = true;
          utilLRUSetAdd(cache.loadedTileOrder, tile.id);
          const tileShapeIDs = new Set();

          for (const shape of data.features) {
            const featureID = this.getNextID();   // Generate a unique id for this feature
            shape.id = featureID;
            shape.__featurehash__ = featureID;    // legacy

            // afaict the shapes never get updates, so the version can just be 0
            // (if we ever need to stitch partial geometries together, this will bump their version)
            shape.v = 0;

            const box = geojsonExtent(shape).bbox();
            box.data = shape;
            cache.rbush.insert(box);

            cache.shapes[featureID] = shape;
            utilLRUSetAdd(cache.shapeOrder, featureID);
            tileShapeIDs.add(featureID);
            cache.shapeTileIDs[featureID] = tile.id;
          }
          cache.tileShapeIDs[tile.id] = tileShapeIDs;

          this._trimCache(wantedTileIDs);

          const gfx = this.context.systems.gfx;
          gfx.deferredRedraw();
          this.emit('loadedData');
        })
        .catch(err => {
          if (err.name === 'AbortError') return;    // ok
          cache.loadedTile[tile.id] = true;         // don't retry
          utilLRUSetAdd(cache.loadedTileOrder, tile.id);
          this._trimCache(wantedTileIDs);
        })
        .finally(() => {
          delete cache.inflightTile[tile.id];
        });
    }
  }


  _abortRequest(controller) {
    if (controller) {
      controller.abort();
    }
  }


  _abortUnwantedRequests(cache, tiles) {
    Object.keys(cache.inflightTile).forEach(k => {
      const wanted = tiles.find(tile => k === tile.id);
      if (!wanted) {
        this._abortRequest(cache.inflightTile[k]);
        delete cache.inflightTile[k];
      }
    });
  }


  _trimCache(wantedTileIDs) {
    const cache = this._cache;
    const protectedTileIDs = new Set(wantedTileIDs);
    for (const tileID of Object.keys(cache.inflightTile)) {
      protectedTileIDs.add(tileID);
    }

    let attempts = cache.loadedTileOrder.size;
    while (cache.loadedTileOrder.size > this._maxLoadedTiles && attempts-- > 0) {
      const oldestTileID = cache.loadedTileOrder.values().next().value;
      if (oldestTileID === undefined) break;

      if (protectedTileIDs.has(oldestTileID)) {
        utilLRUSetAdd(cache.loadedTileOrder, oldestTileID);
        continue;
      }

      this._evictTile(cache, oldestTileID);
    }

    while (cache.shapeOrder.size > this._maxShapes) {
      const oldestShapeID = cache.shapeOrder.values().next().value;
      if (oldestShapeID === undefined) break;

      this._evictShape(cache, oldestShapeID, true);
    }
  }


  _evictTile(cache, tileID) {
    const shapeIDs = cache.tileShapeIDs[tileID];
    if (shapeIDs) {
      for (const shapeID of shapeIDs) {
        this._evictShape(cache, shapeID, false);
      }
      delete cache.tileShapeIDs[tileID];
    }

    cache.loadedTileOrder.delete(tileID);
    delete cache.loadedTile[tileID];
  }


  _evictShape(cache, shapeID, invalidateSourceTile = false) {
    const shape = cache.shapes[shapeID];
    if (!shape) return;

    const tileID = cache.shapeTileIDs[shapeID];
    if (invalidateSourceTile && tileID && cache.loadedTile[tileID]) {
      this._evictTile(cache, tileID);
      return;
    }

    cache.shapeOrder.delete(shapeID);
    delete cache.shapes[shapeID];

    if (tileID && cache.tileShapeIDs[tileID]) {
      cache.tileShapeIDs[tileID].delete(shapeID);
      if (cache.tileShapeIDs[tileID].size === 0) {
        delete cache.tileShapeIDs[tileID];
      }
    }
    delete cache.shapeTileIDs[shapeID];

    cache.rbush.remove({ data: { id: shapeID } }, (a, b) => a.data.id === b.data.id);
  }

}
