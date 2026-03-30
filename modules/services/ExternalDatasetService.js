import { AbstractSystem } from '../core/AbstractSystem.js';
import { RapidDataset } from '../core/lib/index.js';
import { geojsonFeatures } from '../util/util.js';
import { utilFetchResponse } from '../util/index.js';

const ALLOWED_SOURCE_TYPES = new Set(['geojson', 'vectortile']);
const SUPPORTED_GEOMETRIES = new Set([
  'Point', 'MultiPoint',
  'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon'
]);


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
      record.controller = null;
      record.loadPromise = null;

      if (record.source.type === 'geojson') {
        record.features = [];
        record.loaded = false;
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

      const existing = this._datasets.get(dataset.id);
      if (existing?.controller) {
        existing.controller.abort();
      }

      this._datasets.set(dataset.id, {
        dataset: dataset,
        source: entry.source,
        features: [],
        loaded: false,
        controller: null,
        loadPromise: null
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
   * Return the graph for a given dataset (not applicable for external datasets).
   * @return  {null}
   */
  graph() {
    return null;
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

    record.features = this._normalizeFeatures(record.dataset.id, geojson);
    record.loaded = true;

    const gfx = this.context.systems.gfx;
    gfx?.deferredRedraw();
    this.emit('loadedData');
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
