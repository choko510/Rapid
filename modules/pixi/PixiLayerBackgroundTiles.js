import * as PIXI from 'pixi.js';
import { interpolateNumber } from 'd3-interpolate';
import { AdjustmentFilter, ConvolutionFilter } from 'pixi-filters';
import { Tiler, geoScaleToZoom } from '@rapid-sdk/math';

import { AbstractLayer } from './AbstractLayer.js';
import { getFallbackTileZoom, isTransformOnlyRedraw } from './helpers.js';

const DEBUGCOLOR = 0xffff00;
const FALLBACK_TILE_KEEP_MS = 10000;
const TILE_REFRESH_DELAY_MS = 200;
const FAILED_URL_TTL_MS = 30000;
const MAX_FAILED_URLS = 512;

// scalars for use by the convolution filter to sharpen the imagery
const sharpenMatrix = [
     0,      -0.0125,      0,
  -0.0125,    0.5,      -0.0125,
     0,      -0.0125,      0
];


/**
 * PixiLayerBackgroundTiles
 * @class
 */
export class PixiLayerBackgroundTiles extends AbstractLayer {

  /**
   * @constructor
   * @param  scene      The Scene that owns this Layer
   * @param  layerID    Unique string to use for the name of this Layer
   * @param  isMinimap  Pass `true` if this layer should be attached to the minimap
   */
  constructor(scene, layerID, isMinimap) {
    super(scene, layerID);
    this.enabled = true;   // background imagery should be enabled by default
    this.isMinimap = isMinimap;

    this.filters = {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      sharpness: 1,
    };
    this._filterCacheKey = null;
    this._filterCache = null;

    this._tileMaps = new Map();    // Map (sourceID -> Map(tileID -> tile))
    this._failed = new Set();      // Set of failed tileURLs
    this._tiler = new Tiler();
    this._needTiles = new Map();   // Reused Map(tileID -> tile)
    this._sourceIDsToDestroy = []; // Reused Array<string>
    this._tileRefreshTimer = null;
    this._tileRefreshGeneration = 0;
    this._failedAt = new Map();
    this._memoryManager = {
      getStats: () => this.getMemoryStats(),
      evict: options => this.evictMemory(options)
    };
  }


  /**
   * reset
   * Every Layer should have a reset function to replace any Pixi objects and internal state.
   */
  reset() {
    super.reset();

    if (this._tileRefreshTimer !== null) {
      window.clearTimeout(this._tileRefreshTimer);
      this._tileRefreshTimer = null;
    }
    this._tileRefreshGeneration++;

    // Items in this layer don't need to be interactive
    const groupContainer = this.scene.groups.get('background');
    groupContainer.eventMode = 'none';

    this.destroyAll();
    this._tileMaps.clear();
    this._failed.clear();
    this._failedAt.clear();
    this._needTiles.clear();
    this._sourceIDsToDestroy.length = 0;
    this._filterCacheKey = null;
    this._filterCache = null;
    this.convolutionFilter = null;
    this.blurFilter = null;

    const memory = this.context.systems.memory;
    memory?.register(`background-tiles-${this.layerID}`, this._memoryManager, 3);
  }


  /**
   * render
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   */
  render(_frame, viewport, _zoom, reasons = new Set(['data'])) {
    const isTransformOnly = isTransformOnlyRedraw(reasons);

    if (isTransformOnly) {
      this._scheduleTileRefresh();
      // The Pixi viewport and origin are already handling the temporary map
      // transform.  Rebuilding the tile set here makes every pan recalculate
      // low-zoom coverage and can start a second wave of image requests.
      return;
    } else {
      this._cancelTileRefresh();
    }

    const imagery = this.context.systems.imagery;
    const groupContainer = this.scene.groups.get('background');

    // Collect tile sources - baselayer and overlays
    const showSources = new Map();   // Map (sourceID -> source)

    const base = imagery.baseLayerSource();
    const baseID = base?.key;   // note: use `key` here - for Wayback it will include the date
    const baseFallbackSource = base ? imagery.chooseFallbackSource({ requireAvailable: true, excludeSourceID: base.id }) : null;
    if (base && baseID !== 'none') {
      showSources.set(baseID, base);
    }

    for (const overlay of imagery.overlayLayerSources()) {
      showSources.set(overlay.id, overlay);
    }

    // Render each tile source (iterates in insertion order, base then overlays)
    let index = 0;
    for (const [sourceID, source] of showSources) {
      const sourceContainer = this.getSourceContainer(sourceID);
      sourceContainer.zIndex = (source.isLocatorOverlay() ? 999 : index++);

      // If this is the base tile layer (and not minimap) apply the filters to it.
      if (!this.isMinimap && source === base) {
        this.applyFilters(sourceContainer);
      }

      let tileMap = this._tileMaps.get(sourceID);
      if (!tileMap) {
        tileMap = new Map();   // Map (tileID -> Tile)
        this._tileMaps.set(sourceID, tileMap);
      }

      const timestamp = window.performance.now();
      const fallbackSource = (source === base ? baseFallbackSource : null);
      this.renderSource(timestamp, viewport, source, sourceContainer, tileMap, fallbackSource);
    }

    // Remove any sourceContainers and data not needed anymore
    // Doing this in 2 passes to avoid affecting `.children` while iterating over it.
    const toDestroy = this._sourceIDsToDestroy;
    toDestroy.length = 0;
    for (const sourceContainer of groupContainer.children) {
      const sourceID = sourceContainer.label;
      if (!showSources.has(sourceID)) {
        toDestroy.push(sourceID);
      }
    }

    for (const sourceID of toDestroy) {
      this.destroySource(sourceID);
    }
    toDestroy.length = 0;
  }


  /**
   * renderSource
   * @param timestamp        Timestamp in milliseconds
   * @param viewport         Pixi viewport to use for rendering
   * @param source           Imagery tile source Object
   * @param sourceContainer  PIXI.Container to render the tiles to
   * @param tileMap          Map(tile.id -> Tile) for this tile source
   * @param fallbackSource   Optional Imagery tile source used when tile requests fail
   */
  renderSource(timestamp, viewport, source, sourceContainer, tileMap, fallbackSource = null) {
    const context = this.context;
    const textureManager = this.gfx.textures;
    const osm = context.services.osm;
    const t = viewport.transform.props;
    const sourceID = source.key;   // note: use `key` here, for Wayback it will include the date
    const sourceIsLocatorOverlay = source.isLocatorOverlay();

    // Defensive coding in case nominatim/other reasons cause us to get an invalid view transform.
    if (isNaN(t.x) || isNaN(t.y)) {
      return;
    }

    // The tile debug container lives on the `map-ui` layer so it is drawn over everything
    let showDebug = false;
    let debugContainer;
    if (!this.isMinimap) {
      showDebug = context.getDebug('tile');
      debugContainer = this.scene.layers.get('map-ui').tileDebug;
      debugContainer.visible = showDebug;
    }

    const tileSize = source.tileSize || 256;
    const z = geoScaleToZoom(t.k, tileSize);  // Use actual zoom for this, not effective zoom

    // Apply imagery offset (in pixels) to the source container
    const offsetScale = Math.pow(2, z);
    sourceContainer.position.set(source.offset[0] * offsetScale, source.offset[1] * offsetScale);

    // Determine tiles needed to cover the view at the zoom we want,
    // including any zoomed out tiles if this field contains any holes
    const needTiles = this._needTiles;
    needTiles.clear();
    const primaryTiles = new Map();

    // Make sure the min zoom is at least 1.
    // z=0 causes a bug for Mapbox layers to disappear, these use very large tile size.
    // Also the locator overlay should always show its labels, which start at zoom 1.
    const maxZoom = Math.max(1, Math.ceil(z));                 // the zoom we want (round up for sharper imagery)
    const minZoom = Math.max(1, maxZoom - source.zoomRange);   // the mininimum zoom we'll accept

    let covered = false;
    let primaryZoom = null;
    for (let tryZoom = maxZoom; !covered && tryZoom >= minZoom; tryZoom--) {
      if (!source.validZoom(tryZoom)) continue;  // not valid here, zoom out
      if (sourceIsLocatorOverlay && maxZoom > 17) continue;   // overlay is blurry if zoomed in this far

      primaryZoom = tryZoom;

      const result = this._tiler
        .tileSize(tileSize)
        .margin(0)
        .skipNullIsland(!!source.overlay)
        .zoomRange(tryZoom)
        .getTiles(this.isMinimap ? viewport : context.viewport);  // minimap passes in its own viewport

      let hasHoles = false;
      for (const tile of result.tiles) {
        // skip locator overlay tiles where we have osm data loaded there
        if (!this.isMinimap && tryZoom >= 10 && osm && sourceIsLocatorOverlay) {
          const loc = tile.wgs84Extent.center();
          if (osm.isDataLoaded(loc)) continue;
        }

        const sourceURL = source.url(tile.xyz);
        const fallbackURL = fallbackSource?.url(tile.xyz);
        if (this._setTileURLs(tile, sourceURL, fallbackURL)) {
          primaryTiles.set(tile.id, tile);
        } else {
          hasHoles = true;   // url invalid or has failed in the past
        }
      }
      covered = !hasHoles;
    }

    // Keep a low-resolution parent layer visible while the primary tiles load.
    // This prevents untextured sprites from exposing the renderer's black clear color.
    const fallbackZoom = !source.overlay ? getFallbackTileZoom(primaryZoom ?? maxZoom, minZoom) : null;
    if (fallbackZoom !== null && source.validZoom(fallbackZoom)) {
      const result = this._tiler
        .tileSize(tileSize)
        .margin(1)
        .skipNullIsland(!!source.overlay)
        .zoomRange(fallbackZoom)
        .getTiles(this.isMinimap ? viewport : context.viewport);

      for (const tile of result.tiles) {
        if (primaryTiles.has(tile.id)) continue;

        const sourceURL = source.url(tile.xyz);
        const fallbackURL = fallbackSource?.url(tile.xyz);
        if (this._setTileURLs(tile, sourceURL, fallbackURL)) {
          tile.isFallback = true;
          needTiles.set(tile.id, tile);
        }
      }
    }

    // Add primary tiles after fallback tiles so their requests start later,
    // while zIndex still guarantees that sharper imagery draws above parents.
    for (const [tileID, tile] of primaryTiles) {
      needTiles.set(tileID, tile);
    }


    // Create a Sprite for each tile
    // Parent tiles are inserted first so they can fill gaps while children load.
    for (const [tileID, tile] of needTiles) {
      if (tileMap.has(tileID)) continue;   // we made it already

      const tileName = `${sourceID}-${tileID}`;
      const sprite = new PIXI.Sprite();
      sprite.label = tileName;
      sprite.anchor.set(0, 1);    // left, bottom
      sprite.zIndex = tile.xyz[2];   // draw zoomed tiles above unzoomed tiles
      sprite.alpha = source.alpha;
      sprite.visible = false;    // avoid drawing an untextured sprite as black
      sourceContainer.addChild(sprite);
      tile.sprite = sprite;
      tile.timestamp = timestamp;
      tileMap.set(tileID, tile);

      // Start loading the image
      tile.loaded = false;
      this.loadTile(tile, textureManager);
    }


    // Update or remove the existing tiles
    for (const [tileID, tile] of tileMap) {
      let keepTile = false;

      // Keep this tile if it is in the `needTiles` map.
      if (needTiles.has(tileID)) {
        keepTile = true;
        tile.timestamp = timestamp;

      // Keep base (not overlay) tiles around a little while longer,
      // so they can stand in for a needed tile that has not loaded yet.
      } else if (!source.overlay) {
        const keepMs = tile.isFallback ? FALLBACK_TILE_KEEP_MS : 3000;
        keepTile = (timestamp - tile.timestamp < keepMs);
      }

      if (keepTile) {   // Tile may be visible - update position and scale
        const [x, y] = viewport.project(tile.wgs84Extent.min);   // left, bottom
        tile.sprite.position.set(x, y);
        const size = tileSize * Math.pow(2, z - tile.xyz[2]);
        tile.sprite.width = size;
        tile.sprite.height = size;

        if (showDebug && debugContainer && !source.overlay) {
          // Display debug tile info
          if (!tile.debug) {
            tile.debug = new PIXI.Graphics();
            tile.debug.label = `debug-${tileID}`;
            tile.debug.eventMode = 'none';
            debugContainer.addChild(tile.debug);
          }

          if (!tile.text) {
            tile.text = new PIXI.BitmapText({
              text: tileID,
              style: {
                fontFamily: 'rapid-debug',
                fontSize: 14
              }
            });

            tile.text.label = `label-${tileID}`;
            tile.text.tint = DEBUGCOLOR;
            tile.text.eventMode = 'none';
            debugContainer.addChild(tile.text);
          }

          tile.debug.position.set(x, y - size);         // left, top
          tile.text.position.set(x + 2, y - size + 2);  // left, top
          tile.debug
            .clear()
            .rect(0, 0, size, size)
            .stroke({ width: 2, color: DEBUGCOLOR });
        }

      } else {   // tile not needed, can destroy it
        this.destroyTile(tile);
        tileMap.delete(tileID);
      }
    }

  }


  _scheduleTileRefresh() {
    if (this._tileRefreshTimer !== null) {
      window.clearTimeout(this._tileRefreshTimer);
    }

    const generation = this._tileRefreshGeneration;
    this._tileRefreshTimer = window.setTimeout(() => {
      this._tileRefreshTimer = null;
      if (generation !== this._tileRefreshGeneration) return;
      this.gfx.deferredRedraw('tile');
    }, TILE_REFRESH_DELAY_MS);
  }


  _cancelTileRefresh() {
    if (this._tileRefreshTimer === null) return;
    window.clearTimeout(this._tileRefreshTimer);
    this._tileRefreshTimer = null;
  }


  getMemoryStats() {
    let loaded = 0;
    let inflight = 0;
    let total = 0;
    for (const tileMap of this._tileMaps.values()) {
      total += tileMap.size;
      for (const tile of tileMap.values()) {
        if (tile.loaded) loaded++;
        if (tile.image) inflight++;
      }
    }
    return {
      sources: this._tileMaps.size,
      tiles: total,
      loaded,
      inflight,
      failedURLs: this._failed.size
    };
  }


  evictMemory(options = {}) {
    const maxTiles = 240;
    const now = window.performance.now();
    let removed = 0;
    const maxMs = options.maxMs ?? 4;
    const maxRemovals = options.maxItems ?? 16;
    const start = now;
    const canContinue = () => {
      return removed < maxRemovals && performance.now() - start < maxMs;
    };

    // Expire negative-cache entries independently of tile pressure.
    for (const [url, time] of this._failedAt) {
      if (!canContinue()) break;
      if (now - time > FAILED_URL_TTL_MS) {
        this._failedAt.delete(url);
        this._failed.delete(url);
      }
    }

    // Bound recent failures too, even when map tile count stays low.
    while (this._failedAt.size > MAX_FAILED_URLS && canContinue()) {
      const url = this._failedAt.keys().next().value;
      this._failedAt.delete(url);
      this._failed.delete(url);
    }

    for (const tileMap of this._tileMaps.values()) {
      for (const [tileID, tile] of tileMap) {
        if (!canContinue()) return removed;
        if (tile.image || !tile.loaded || tile.isFallback) continue;
        if (now - tile.timestamp < 3000) continue;

        this.destroyTile(tile);
        tileMap.delete(tileID);
        removed++;
      }
    }

    let over = [...this._tileMaps.values()]
      .reduce((count, map) => count + map.size, 0) - maxTiles;
    if (over <= 0) return removed;

    for (const tileMap of this._tileMaps.values()) {
      for (const [tileID, tile] of tileMap) {
        if (!canContinue() || over <= 0) return removed;
        if (tile.image || !tile.loaded || tile.isFallback) continue;
        if (now - tile.timestamp < FALLBACK_TILE_KEEP_MS) continue;

        this.destroyTile(tile);
        tileMap.delete(tileID);
        removed++;
        over--;
      }
    }
    return removed;
  }


  _setTileURLs(tile, sourceURL, fallbackURL) {
    const hasFallback = !!fallbackURL && sourceURL !== fallbackURL;
    tile.fallbackURL = hasFallback ? fallbackURL : null;
    tile.url = sourceURL || tile.fallbackURL;

    if (tile.url && this._failed.has(tile.url)) {
      tile.url = this._nextFallbackURL(tile, tile.url);
    }

    return !!tile.url;
  }


  _nextFallbackURL(tile, failedURL) {
    if (!tile.fallbackURL || failedURL === tile.fallbackURL) return null;
    if (this._failed.has(tile.fallbackURL)) return null;
    return tile.fallbackURL;
  }


  loadTile(tile, textureManager) {
    this.gfx.recordTileReq();
    const image = new Image();
    image.crossOrigin = 'anonymous';
    tile.image = image;

    // After the image loads, allocate space for it in the texture atlas
    image.onload = () => {
      this._failed.delete(tile.url);
      this._failedAt.delete(tile.url);
      if (!tile.sprite || !tile.image) return;  // it's possible that the tile isn't needed anymore and got pruned

      const w = tile.image.naturalWidth;
      const h = tile.image.naturalHeight;
      tile.sprite.texture = textureManager.allocate('tile', tile.sprite.label, w, h, tile.image);
      tile.sprite.visible = true;

      tile.loaded = true;
      tile.image = null;  // reference to `image` is held by the atlas, we can null it
      this.gfx.deferredRedraw('tile');
    };

    image.onerror = () => {
      const failedURL = tile.url;
      this._failed.add(failedURL);
      this._failedAt.delete(failedURL);
      this._failedAt.set(failedURL, window.performance.now());

      const fallbackURL = this._nextFallbackURL(tile, failedURL);
      if (fallbackURL) {
        tile.image = null;
        tile.url = fallbackURL;
        this.loadTile(tile, textureManager);
        return;
      }

      tile.image = null;
      this.gfx.deferredRedraw('tile');
    };

    image.src = tile.url;
  }


  /**
   * destroyAll
   * Frees all the resources used by all sources
   */
  destroyAll() {
    const groupContainer = this.scene.groups.get('background');

    // Doing this in 2 passes to avoid affecting `.children` while iterating over it.
    const toDestroy = this._sourceIDsToDestroy;
    toDestroy.length = 0;
    for (const sourceContainer of groupContainer.children) {
      const sourceID = sourceContainer.label;
      toDestroy.push(sourceID);
    }

    for (const sourceID of toDestroy) {
      this.destroySource(sourceID);
    }
    toDestroy.length = 0;
  }


  /**
   * destroySource
   * Frees all the resources used by a source
   * @param  sourceID
   */
  destroySource(sourceID) {
    const tileMap = this._tileMaps.get(sourceID);
    for (const [tileID, tile] of tileMap) {
      this.destroyTile(tile);
      tileMap.delete(tileID);
    }
    this._tileMaps.delete(sourceID);

    const groupContainer = this.scene.groups.get('background');
    let sourceContainer = groupContainer.getChildByLabel(sourceID);
    if (sourceContainer) {
      sourceContainer.destroy({ children: true });
    }
  }


  /**
   * destroyTile
   * Frees all the resources used by a tile
   * @param  tile  Tile object
   */
  destroyTile(tile) {
    const textureManager = this.gfx.textures;

    if (tile.sprite) {
      if (tile.loaded) {
        textureManager.free('tile', tile.sprite.label);
      } else if (tile.image) {
        this.gfx.recordTileAbort();
      }
      tile.sprite.destroy({ texture: true, textureSource: false });
    }

    if (tile.debug) {
      tile.debug.destroy();
    }
    if (tile.text) {
      tile.text.destroy();
    }

    tile.image = null;
    tile.sprite = null;
    tile.debug = null;
    tile.text = null;
  }


  /**
   * getSourceContainer
   * Gets a PIXI.Container to hold the tiles for the given sourceID, creating one if needed
   * @param   sourceID
   * @return  a PIXI.Container
   */
  getSourceContainer(sourceID) {
    const groupContainer = this.scene.groups.get('background');
    let sourceContainer = groupContainer.getChildByLabel(sourceID);
    if (!sourceContainer) {
      sourceContainer = new PIXI.Container();
      sourceContainer.label = sourceID;
      sourceContainer.eventMode = 'none';
      sourceContainer.sortableChildren = true;
      groupContainer.addChild(sourceContainer);
    }
    return sourceContainer;
  }


  /**
   * applyFilters
   * Adds an adjustment filter for brightness/contrast/saturation and
   * a sharpen/blur filter, depending on the UI slider settings.
   * @param  sourceContainer   PIXI.Container that contains the tiles
   */
  applyFilters(sourceContainer) {
    const f = this.filters;
    const key = `${f.brightness}|${f.contrast}|${f.saturation}|${f.sharpness}`;
    if (this._filterCacheKey !== key || !this._filterCache) {
      const adjustmentFilter = new AdjustmentFilter({
        brightness: f.brightness,
        contrast: f.contrast,
        saturation: f.saturation,
      });

      const filters = [adjustmentFilter];

      this.convolutionFilter = null;
      this.blurFilter = null;

      if (f.sharpness > 1) {
        // The convolution filter consists of adjacent pixels with a negative factor and the central pixel being at least one.
        // The central pixel (at index 4 of our 3x3 array) starts at 1 and increases
        const convolutionArray = sharpenMatrix.map((n, i) => {
          if (i === 4) {
            const interp = interpolateNumber(1, 2)(f.sharpness);
            const result = n * interp;
            return result;
          } else {
            return n;
          }
        });

        this.convolutionFilter = new ConvolutionFilter(convolutionArray);
        filters.push(this.convolutionFilter);

      } else if (f.sharpness < 1) {
        const blurFactor = interpolateNumber(1, 8)(1 - f.sharpness);
        this.blurFilter = new PIXI.BlurFilter({
          strength: blurFactor,
          quality: 4
        });
        filters.push(this.blurFilter);
      }

      this._filterCacheKey = key;
      this._filterCache = filters;
    }

    if (sourceContainer.filters !== this._filterCache) {
      sourceContainer.filters = this._filterCache;
    }
  }


  setBrightness(val) {
    this.filters.brightness = val;
  }

  setContrast(val) {
    this.filters.contrast = val;
  }

  setSaturation(val) {
    this.filters.saturation = val;
  }

  setSharpness(val) {
    this.filters.sharpness = val;
  }

}
