import { geoSphericalDistance, Tiler } from '@rapid-sdk/math';
import { AbstractSystem } from '../core/AbstractSystem.js';
import { Graph, RapidDataset, Tree } from '../core/lib/index.js';
import { osmEntity, osmNode, osmWay } from '../osm/index.js';
import { geojsonFeatures } from '../util/util.js';
import { utilFetchResponse } from '../util/index.js';

const ALLOWED_SOURCE_TYPES = new Set(['geojson', 'vectortile']);
const SUPPORTED_GEOMETRIES = new Set([
  'Point', 'MultiPoint',
  'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon'
]);
const BUILDING_NODE_PROXIMITY_METERS = 2;
const BUILDING_NODE_MATCH_RATIO_THRESHOLD = 0.9;
const METERS_PER_DEGREE_LAT = 111320;


/**
 * `ExternalDatasetService`
 * This service manages externally imported Rapid datasets.
 * It supports importing a manifest from URL or JSON file and serving runtime data.
 */
export class ExternalDatasetService extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'external';

    this._tiler = new Tiler().margin(1);
    this._datasets = new Map();    // Map(datasetID -> record)
    this._nextFeatureID = 1;
  }


  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    const vtService = this.context.services.vectortile;
    const prereq = vtService ? vtService.initAsync() : Promise.resolve();
    return prereq.then(() => this.resetAsync());
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    this._started = true;
    const vtService = this.context.services.vectortile;
    return vtService ? vtService.startAsync() : Promise.resolve();
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state.
   * Keep the imported dataset definitions, but clear loaded runtime data.
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    for (const record of this._datasets.values()) {
      if (record.controller) {
        record.controller.abort();
      }
      for (const controller of record.inflight.values()) {
        controller.abort();
      }

      record.controller = null;
      record.loadPromise = null;
      record.inflight.clear();
      record.loadedTiles.clear();
      record.tileFeatures.clear();
      record.lastv = null;

      if (record.source.type === 'geojson') {
        record.features = [];
        record.loaded = false;
      }

      if (record.acceptAsOSM) {
        record.graph = new Graph();
        record.tree = new Tree(record.graph);
        record.convertedFeatureIDs.clear();
      }
    }

    return Promise.resolve();
  }


  /**
   * getAvailableDatasets
   * Called by `RapidSystem` to get the datasets that this service provides.
   * @return {Array<RapidDataset>}  The datasets this service provides
   */
  getAvailableDatasets() {
    return Array.from(this._datasets.values()).map(record => record.dataset);
  }


  /**
   * importFromURL
   * Fetch and import a manifest from URL.
   * @param   {string}  url
   * @return  {Promise<Object>} import result
   */
  async importFromURL(url) {
    const trimmed = this._cleanString(url);
    if (!trimmed || !this._isValidURL(trimmed)) {
      throw new Error('Invalid manifest URL');
    }

    const data = await fetch(trimmed).then(utilFetchResponse);
    return this.importManifest(data);
  }


  /**
   * importFromFile
   * Read and import a manifest from a local file.
   * @param   {File}  file
   * @return  {Promise<Object>} import result
   */
  async importFromFile(file) {
    if (!file) {
      throw new Error('No file selected');
    }

    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON file');
    }

    return this.importManifest(data);
  }


  /**
   * importManifest
   * Validate and import one manifest payload.
   * @param   {Object|string}  manifest
   * @return  {Object} result with imported datasets and validation errors
   */
  importManifest(manifest) {
    const { datasets, errors } = this._normalizeManifest(manifest);
    const imported = new Map();  // last one wins for duplicate ids

    for (const entry of datasets) {
      const dataset = this._buildRapidDataset(entry);
      const acceptAsOSM = (entry.source.type === 'geojson') && entry.categories.has('buildings');
      const graph = acceptAsOSM ? new Graph() : null;
      const tree = acceptAsOSM ? new Tree(graph) : null;

      const existing = this._datasets.get(dataset.id);
      if (existing?.controller) {
        existing.controller.abort();
      }
      for (const controller of existing?.inflight?.values() ?? []) {
        controller.abort();
      }

      this._datasets.set(dataset.id, {
        dataset: dataset,
        source: entry.source,
        acceptAsOSM: acceptAsOSM,
        features: [],
        isTiledGeoJSON: this._isTiledGeoJSONSource(entry.source.url),
        loaded: false,
        controller: null,
        loadPromise: null,
        inflight: new Map(),
        loadedTiles: new Set(),
        tileFeatures: new Map(),
        lastv: null,
        graph: graph,
        tree: tree,
        convertedFeatureIDs: new Set()
      });

      imported.set(dataset.id, dataset);
    }

    return {
      datasets: Array.from(imported.values()),
      errors: errors
    };
  }


  /**
   * getData
   * Get already loaded data that appears in the current map view.
   * @param   {string}  datasetID - datasetID to get data for
   * @return  {Array}   Array of data (GeoJSON features)
   */
  getData(datasetID) {
    const record = this._datasets.get(datasetID);
    if (!record) return [];

    if (record.source.type === 'geojson') {
      if (record.acceptAsOSM) {
        return this._getBuildingWayData(record);
      }
      if (record.isTiledGeoJSON) {
        return this._getTiledGeoJSONData(record);
      }
      return record.features;
    }

    if (record.source.type === 'vectortile') {
      const vtService = this.context.services.vectortile;
      if (!vtService) return [];
      return vtService.getData(record.source.url).map(d => d.geojson).filter(Boolean);
    }

    return [];
  }


  /**
   * loadTiles
   * Schedule any data requests needed to cover the current map view.
   * @param   {string}  datasetID - datasetID to load data for
   */
  loadTiles(datasetID) {
    if (this._paused) return;

    const record = this._datasets.get(datasetID);
    if (!record) return;

    if (record.source.type === 'geojson') {
      if (record.isTiledGeoJSON) {
        this._loadTiledGeoJSONTiles(record);
        return;
      }

      if (record.loaded || record.loadPromise) return;

      const controller = new AbortController();
      record.controller = controller;
      record.loadPromise = fetch(record.source.url, { signal: controller.signal })
        .then(utilFetchResponse)
        .then(data => this._setGeoJSONData(record, data))
        .catch(err => {
          if (err.name === 'AbortError') return;
          console.error(err);  // eslint-disable-line no-console
        })
        .finally(() => {
          record.controller = null;
          record.loadPromise = null;
        });

    } else if (record.source.type === 'vectortile') {
      const vtService = this.context.services.vectortile;
      vtService?.loadTiles(record.source.url);
    }
  }


  /**
   * graph
   * Return the graph for a given dataset.
   * @param   {string}  datasetID - datasetID to get graph for
   * @return  {Graph|null}
   */
  graph(datasetID) {
    const record = this._datasets.get(datasetID);
    return record?.graph ?? null;
  }


  _normalizeManifest(manifest) {
    const errors = [];
    let data = manifest;

    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (err) {
        return {
          datasets: [],
          errors: [{ index: -1, id: null, message: 'Manifest is not valid JSON' }]
        };
      }
    }

    const entries = Array.isArray(data) ? data : data?.datasets;
    if (!Array.isArray(entries)) {
      return {
        datasets: [],
        errors: [{ index: -1, id: null, message: 'Manifest must contain a "datasets" array' }]
      };
    }

    const normalized = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const itemErrors = [];
      const rawID = this._cleanString(entry?.id);
      const rawLabel = this._cleanString(entry?.label);

      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ index: i, id: rawID || null, message: 'Dataset entry must be an object' });
        continue;
      }
      if (!rawID) itemErrors.push('Missing required field "id"');
      if (!rawLabel) itemErrors.push('Missing required field "label"');

      const categories = new Set(
        Array.isArray(entry.categories)
          ? entry.categories.map(d => this._cleanString(d)).filter(Boolean)
          : []
      );
      if (!categories.size) itemErrors.push('Missing required field "categories" (non-empty array)');

      const sourceType = this._cleanString(entry.source?.type).toLowerCase();
      const sourceURL = this._cleanString(entry.source?.url);
      if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
        itemErrors.push('Unsupported source type (must be "geojson" or "vectortile")');
      }
      if (!sourceURL || !this._isValidURL(sourceURL)) {
        itemErrors.push('Invalid source URL');
      }

      const beta = (entry.beta === true) || categories.has('preview');
      const featured = (entry.featured === true) || categories.has('featured');
      if (beta) categories.add('preview');
      if (featured) categories.add('featured');
      categories.add('external');

      if (itemErrors.length) {
        errors.push({ index: i, id: rawID || null, message: itemErrors.join('; ') });
        continue;
      }

      normalized.push({
        id: rawID,
        label: rawLabel,
        description: this._cleanString(entry.description),
        categories: categories,
        source: {
          type: sourceType,
          url: sourceURL
        },
        itemUrl: this._cleanString(entry.itemUrl),
        licenseUrl: this._cleanString(entry.licenseUrl),
        thumbnailUrl: this._cleanString(entry.thumbnailUrl),
        color: this._cleanString(entry.color),
        beta: beta,
        featured: featured
      });
    }

    return { datasets: normalized, errors: errors };
  }


  _buildRapidDataset(entry) {
    return new RapidDataset(this.context, {
      id: entry.id,
      service: 'external',
      conflated: false,
      categories: new Set(entry.categories),
      dataUsed: ['external', entry.label],
      label: entry.label,
      description: entry.description,
      itemUrl: entry.itemUrl,
      licenseUrl: entry.licenseUrl,
      thumbnailUrl: entry.thumbnailUrl,
      color: entry.color || undefined,
      beta: entry.beta,
      featured: entry.featured
    });
  }


  _setGeoJSONData(record, data) {
    const geojson = this._asFeatureCollection(data);
    if (!geojson) {
      throw new Error(`Dataset "${record.dataset.id}" source did not return GeoJSON`);
    }

    const features = this._normalizeFeatures(record.dataset.id, geojson);
    if (record.acceptAsOSM) {
      this._mergeBuildingFeatures(record, features);
    } else {
      record.features = features;
    }
    record.loaded = true;

    const gfx = this.context.systems.gfx;
    gfx?.deferredRedraw();
    this.emit('loadedData');
  }


  _setGeoJSONTileData(record, tileID, data) {
    const geojson = this._asFeatureCollection(data);
    if (!geojson) {
      throw new Error(`Dataset "${record.dataset.id}" source did not return GeoJSON`);
    }

    const features = this._normalizeFeatures(record.dataset.id, geojson);
    if (record.acceptAsOSM) {
      this._mergeBuildingFeatures(record, features);
    } else {
      record.tileFeatures.set(tileID, features);
    }
    record.loadedTiles.add(tileID);

    const gfx = this.context.systems.gfx;
    gfx?.deferredRedraw();
    this.emit('loadedData');
  }


  _getTiledGeoJSONData(record) {
    if (record.acceptAsOSM) {
      return this._getBuildingWayData(record);
    }

    const viewport = this.context.viewport;
    if (!viewport) return [];

    const tiles = this._tiler.getTiles(viewport).tiles;
    const results = [];

    for (const tile of tiles) {
      const tileFeatures = record.tileFeatures.get(tile.id);
      if (tileFeatures?.length) {
        results.push(...tileFeatures);
      }
    }

    return results;
  }


  _getBuildingWayData(record) {
    const graph = record.graph;
    const tree = record.tree;
    if (!graph || !tree) return [];

    const viewport = this.context.viewport;
    const extent = viewport?.visibleExtent?.() ?? { bbox: () => ({ minX: -180, minY: -90, maxX: 180, maxY: 90 }) };

    const ways = tree.intersects(extent, graph)
      .filter(entity => entity.type === 'way');

    return this._filterBuildingSuggestionsNearOSM(ways, graph, extent);
  }


  _filterBuildingSuggestionsNearOSM(ways, externalGraph, extent) {
    if (!ways.length) return ways;

    const osmNodeLocs = this._getNearbyOSMBuildingNodeLocs(extent);
    if (!osmNodeLocs.length) return ways;

    return ways.filter(way => !this._isMostlyNearExistingBuildingNodes(way, externalGraph, osmNodeLocs));
  }


  _getNearbyOSMBuildingNodeLocs(extent) {
    const editor = this.context.systems.editor;
    const osmGraph = editor?.staging?.graph;
    if (!editor || !osmGraph || typeof editor.intersects !== 'function') return [];

    const osmEntities = editor.intersects(extent) ?? [];
    if (!Array.isArray(osmEntities) || !osmEntities.length) return [];

    const locs = [];
    const seenNodeIDs = new Set();

    for (const entity of osmEntities) {
      if (entity?.type !== 'way') continue;
      if (!entity.tags?.building || entity.tags.building === 'no') continue;
      if (typeof entity.isClosed === 'function' && !entity.isClosed()) continue;

      const nodeIDs = Array.isArray(entity.nodes) ? entity.nodes : [];
      for (const nodeID of nodeIDs) {
        if (!nodeID || seenNodeIDs.has(nodeID)) continue;
        seenNodeIDs.add(nodeID);

        const node = osmGraph.hasEntity?.(nodeID);
        if (node?.type !== 'node' || !Array.isArray(node.loc)) continue;

        const lon = Number(node.loc[0]);
        const lat = Number(node.loc[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        locs.push([lon, lat]);
      }
    }

    return locs;
  }


  _isMostlyNearExistingBuildingNodes(way, externalGraph, osmNodeLocs) {
    const nodeIDs = Array.isArray(way?.nodes) ? way.nodes : [];
    if (!nodeIDs.length) return false;

    const proposalNodeLocs = [];
    for (let i = 0; i < nodeIDs.length; i++) {
      const nodeID = nodeIDs[i];
      if (!nodeID) continue;

      // Skip closing node duplicate if present
      if (i === nodeIDs.length - 1 && nodeID === nodeIDs[0]) continue;

      const node = externalGraph.hasEntity?.(nodeID);
      if (node?.type !== 'node' || !Array.isArray(node.loc)) continue;

      const lon = Number(node.loc[0]);
      const lat = Number(node.loc[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      proposalNodeLocs.push([lon, lat]);
    }

    if (!proposalNodeLocs.length) return false;

    let nearCount = 0;
    for (const loc of proposalNodeLocs) {
      if (this._hasNearbyNode(loc, osmNodeLocs, BUILDING_NODE_PROXIMITY_METERS)) {
        nearCount++;
      }
    }

    return (nearCount / proposalNodeLocs.length) >= BUILDING_NODE_MATCH_RATIO_THRESHOLD;
  }


  _hasNearbyNode(loc, candidates, thresholdMeters) {
    const lat = loc[1];
    const latTol = thresholdMeters / METERS_PER_DEGREE_LAT;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const lonTol = latTol / Math.max(Math.abs(cosLat), 0.2);

    for (const candidate of candidates) {
      if (!candidate) continue;

      const dLon = Math.abs(candidate[0] - loc[0]);
      const dLat = Math.abs(candidate[1] - loc[1]);
      if (dLon > lonTol || dLat > latTol) continue;

      if (geoSphericalDistance(loc, candidate) <= thresholdMeters) {
        return true;
      }
    }

    return false;
  }


  _mergeBuildingFeatures(record, features) {
    const graph = record.graph;
    const tree = record.tree;
    if (!graph || !tree) return;

    const datasetID = record.dataset.id;
    const convertedFeatureIDs = record.convertedFeatureIDs;
    const newEntities = [];

    for (const feature of features) {
      const featureID = feature?.id;
      if (!featureID || convertedFeatureIDs.has(featureID)) continue;
      convertedFeatureIDs.add(featureID);

      const entities = this._geojsonToBuildingEntities(feature, featureID, datasetID);
      if (entities?.length) {
        newEntities.push(...entities);
      }
    }

    if (!newEntities.length) return;
    graph.rebase(newEntities, [graph], true);
    tree.rebase(newEntities, true);
  }


  _geojsonToBuildingEntities(feature, featureID, datasetID) {
    const geometry = feature?.geometry;
    const polygonCoords = (geometry?.type === 'Polygon') ? [geometry.coordinates]
      : (geometry?.type === 'MultiPolygon') ? geometry.coordinates
      : [];
    if (!polygonCoords.length) return null;

    const props = (feature.properties && typeof feature.properties === 'object') ? feature.properties : {};
    const tags = this._getBuildingTags(props);
    const entities = [];

    for (let i = 0; i < polygonCoords.length; i++) {
      const wayFeatureID = polygonCoords.length > 1 ? `${featureID}-p${i}` : featureID;
      const outerRing = polygonCoords[i]?.[0];
      if (!Array.isArray(outerRing) || outerRing.length < 4) continue;

      const coords = [];
      for (const loc of outerRing) {
        if (!Array.isArray(loc) || loc.length < 2) continue;
        const lon = Number(loc[0]);
        const lat = Number(loc[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        coords.push([lon, lat]);
      }
      if (coords.length < 4) continue;

      const first = coords[0];
      const last = coords[coords.length - 1];
      const closed = (first[0] === last[0]) && (first[1] === last[1]);
      if (!closed) {
        coords.push([first[0], first[1]]);
      }
      if (coords.length < 4) continue;

      const nodeIDs = [];

      for (let j = 0; j < coords.length - 1; j++) {
        const nodeID = osmEntity.id('node');
        const node = new osmNode({
          id: nodeID,
          loc: coords[j],
          tags: {}
        });
        node.__fbid__ = `${datasetID}-${wayFeatureID}-n${j}`;
        node.__service__ = 'external';
        node.__datasetid__ = datasetID;
        entities.push(node);
        nodeIDs.push(nodeID);
      }

      if (nodeIDs.length < 3) continue;
      nodeIDs.push(nodeIDs[0]);

      const way = new osmWay({
        id: osmEntity.id('way'),
        nodes: nodeIDs,
        tags: Object.assign({}, tags)
      });

      way.__fbid__ = `${datasetID}-${wayFeatureID}`;
      way.__service__ = 'external';
      way.__datasetid__ = datasetID;
      entities.push(way);
    }

    return entities;
  }


  _getBuildingTags(properties) {
    const tags = {};

    if (typeof properties.building === 'string' && properties.building.trim()) {
      tags.building = properties.building.trim();
    } else if (properties.building === true) {
      tags.building = 'yes';
    } else {
      tags.building = 'yes';
    }

    if (typeof properties.source === 'string' && properties.source.trim()) {
      tags.source = properties.source.trim();
    }

    const name = (typeof properties.name === 'string' && properties.name.trim())
      ? properties.name.trim()
      : (typeof properties['@name'] === 'string' && properties['@name'].trim())
        ? properties['@name'].trim()
        : '';
    if (name) {
      tags.name = name;
    }

    if (properties.height !== undefined && properties.height !== null) {
      tags.height = String(properties.height);
    }

    if (properties['building:levels'] !== undefined && properties['building:levels'] !== null) {
      tags['building:levels'] = String(properties['building:levels']);
    }

    return tags;
  }


  _loadTiledGeoJSONTiles(record) {
    const viewport = this.context.viewport;
    if (!viewport) return;
    if (record.lastv === viewport.v) return;
    record.lastv = viewport.v;

    const tiles = this._tiler.getTiles(viewport).tiles;
    const needed = new Set(tiles.map(tile => tile.id));

    for (const [tileID, controller] of record.inflight) {
      if (!needed.has(tileID)) {
        controller.abort();
        record.inflight.delete(tileID);
      }
    }

    for (const tile of tiles) {
      if (record.loadedTiles.has(tile.id) || record.inflight.has(tile.id)) continue;

      const [x, y, z] = tile.xyz;
      const url = this._expandTileTemplate(record.source.url, x, y, z);
      const controller = new AbortController();
      record.inflight.set(tile.id, controller);

      fetch(url, { signal: controller.signal })
        .then(utilFetchResponse)
        .then(data => this._setGeoJSONTileData(record, tile.id, data))
        .catch(err => {
          if (err.name === 'AbortError') return;
          console.error(err);  // eslint-disable-line no-console
        })
        .finally(() => {
          record.inflight.delete(tile.id);
        });
    }
  }


  _isTiledGeoJSONSource(url) {
    const sourceURL = this._cleanString(url);
    const hasX = /\{x\}/i.test(sourceURL);
    const hasY = /\{y\}/i.test(sourceURL) || /\{-y\}/i.test(sourceURL) || /\{ty\}/i.test(sourceURL);
    return hasX && hasY;
  }


  _expandTileTemplate(template, x, y, z) {
    const tmsY = Math.pow(2, z) - y - 1;

    return template
      .replace(/\{switch:([^}]+)\}/gi, (s, r) => {
        const subdomains = r.split(',');
        return subdomains[(x + y) % subdomains.length];
      })
      .replace(/\{z(oom)?\}/gi, z)
      .replace(/\{-y\}/gi, tmsY)
      .replace(/\{ty\}/gi, tmsY)
      .replace(/\{x\}/gi, x)
      .replace(/\{y\}/gi, y);
  }


  _asFeatureCollection(data) {
    let geojson = data;
    if (typeof geojson === 'string') {
      geojson = JSON.parse(geojson);
    }

    if (!geojson || typeof geojson !== 'object') return null;
    if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) return geojson;
    if (geojson.type === 'Feature') return { type: 'FeatureCollection', features: [geojson] };
    if (geojson.type && geojson.coordinates) {
      return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: geojson }]
      };
    }
    return null;
  }


  _normalizeFeatures(datasetID, geojson) {
    const results = [];

    for (const feature of geojsonFeatures(geojson)) {
      for (const normalized of this._toSingleFeatures(feature)) {
        const geometry = normalized?.geometry;
        if (!geometry || !SUPPORTED_GEOMETRIES.has(geometry.type)) continue;

        const properties = (normalized.properties && typeof normalized.properties === 'object')
          ? Object.assign({}, normalized.properties)
          : {};

        if (!properties['@name'] && typeof properties.name === 'string') {
          properties['@name'] = properties.name;
        }

        const id = normalized.id ?? `${datasetID}-${this._nextFeatureID++}`;
        results.push({
          type: 'Feature',
          id: id,
          __featurehash__: id,
          properties: properties,
          geometry: geometry
        });
      }
    }

    return results;
  }


  _cleanString(val) {
    return (typeof val === 'string') ? val.trim() : '';
  }


  _isValidURL(url) {
    const candidate = this._cleanString(url);
    if (!candidate) return false;

    // Allow templates like {z}/{x}/{y} and {switch:a,b,c}
    const testURL = candidate
      .replace(/\{switch:[^}]+\}/g, 'a')
      .replace(/\{zoom\}/gi, '0')
      .replace(/\{z\}/gi, '0')
      .replace(/\{x\}/gi, '0')
      .replace(/\{-y\}/gi, '0')
      .replace(/\{ty\}/gi, '0')
      .replace(/\{y\}/gi, '0');

    try {
      const parsedURL = new URL(testURL);
      return !!parsedURL;
    } catch (err) {
      return false;
    }
  }


  _toSingleFeatures(geojson) {
    const result = [];
    const geometry = geojson?.geometry;
    if (!geojson || !geometry) return result;

    const type = geometry.type;
    const coords = geometry.coordinates;
    const isMulti = /^Multi/.test(type);
    const parts = isMulti ? coords : [coords];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let featureID;
      if (geojson.id !== undefined && geojson.id !== null && geojson.id !== '') {
        featureID = isMulti ? `${geojson.id}-${i}` : geojson.id;
      }

      result.push({
        type: 'Feature',
        id: featureID,
        geometry: {
          type: type.replace('Multi', ''),
          coordinates: part
        },
        properties: Object.assign({}, geojson.properties)   // shallow copy
      });
    }
    return result;
  }

}
