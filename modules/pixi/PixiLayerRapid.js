import * as PIXI from 'pixi.js';
import geojsonRewind from '@mapbox/geojson-rewind';
import { utilStringQs } from '@rapid-sdk/util';

import { AbstractLayer } from './AbstractLayer.js';
import { PixiFeatureLine } from './PixiFeatureLine.js';
import { PixiFeaturePoint } from './PixiFeaturePoint.js';
import { PixiFeaturePolygon } from './PixiFeaturePolygon.js';

const MINZOOM = 12;


/**
 * PixiLayerRapid
 * @class
 */
export class PixiLayerRapid extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);
    this.enabled = true;     // Rapid features should be enabled by default

    this._resolved = new Map();  // Map<entityID, GeoJSON feature>
    this._datasetContainers = new Map();  // Map<datasetID, { areas: PIXI.Container, lines: PIXI.Container }>
    this._datasetColors = new Map();      // Map<datasetID, { color: string, pixi: PIXI.Color }>
  }


  /**
   * supported
   * Whether the Layer's service exists
   */
  get supported() {
    // return true if any of these are installed
    const services = this.context.services;
    return !!(services.mapwithai || services.esri || services.overture);
  }


  /**
   * enabled
   * Whether the user has chosen to see the Layer
   * Make sure to start the services first.
   */
  get enabled() {
    return this._enabled;
  }
  set enabled(val) {
    if (!this.supported) {
      val = false;
    }

    if (val === this._enabled) return;  // no change
    this._enabled = val;

    const context = this.context;
    const gfx = context.systems.gfx;
    const esri = context.services.esri;
    const mapwithai = context.services.mapwithai;
    const overture = context.services.overture;

    // This code is written in a way that we can work with whatever
    // data-providing services are installed.
    const services = [];
    if (esri)      services.push(esri);
    if (mapwithai) services.push(mapwithai);
    if (overture)  services.push(overture);

    if (val && services.length) {
      Promise.all(services.map(service => service.startAsync()))
        .then(() => gfx.immediateRedraw());
    }
  }


  /**
   * reset
   * Every Layer should have a reset function to replace any Pixi objects and internal state.
   */
  reset() {
    super.reset();
    this._resolved.clear();  // cached geojson features
    this._datasetContainers.clear();
    this._datasetColors.clear();

    const groupContainer = this.scene.groups.get('basemap');

    // Remove any existing containers
    for (const child of groupContainer.children) {
      if (child.label.startsWith(this.layerID + '-')) {   // 'rapid-*'
        groupContainer.removeChild(child);
        child.destroy({ children: true });  // recursive
      }
    }

    // We don't add area or line containers here - `renderDataset()` does it as needed
  }


  _getFeatureTags(entity) {
    return entity?.geojson?.properties ?? entity?.tags ?? entity?.properties ?? {};
  }


  _getFeatureLabel(entity, l10n) {
    const tags = this._getFeatureTags(entity);
    return tags['@name'] || l10n.displayName(tags) || '';
  }


  /**
   * render
   * Render any data we have, and schedule fetching more of it to cover the view
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  render(frame, viewport, zoom) {
    const rapid = this.context.systems.rapid;
    if (!this.enabled || zoom < MINZOOM || !rapid.catalog.size) return;

// shader experiment
//const offset = this.gfx.pixi.stage.position;
//const transform = this.gfx.pixi.stage.worldTransform;
//this._uniforms.translationMatrix = transform.clone().translate(-offset.x, -offset.y);
//this._uniforms.u_time = frame/10;

    const conflation = utilStringQs(window.location.hash).conflation;
    const disableConflation = (conflation === 'false' || conflation === 'no');

    for (const dataset of rapid.catalog.values()) {
      if (!dataset.added || !dataset.enabled) continue;
      this.renderDataset(dataset, frame, viewport, zoom, disableConflation);
    }
  }


  /**
   * renderDataset
   * Render any data we have, and schedule fetching more of it to cover the view
   *
   * @param  dataset    Object
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  renderDataset(dataset, frame, viewport, zoom, disableConflation) {
    const context = this.context;
    const rapid = context.systems.rapid;

    const service = context.services[dataset.service];  // 'mapwithai' or 'esri'
    if (!service?.started) return;

    const useConflation = dataset.conflated && !disableConflation;

    // Adjust the dataset id for whether we want the data conflated or not
    const datasetID = dataset.id + (useConflation ? '-conflated' : '');

    // Overture data isn't editable, nor conflatable... yet.
    let dsGraph = null;
    if (dataset.service !== 'overture') {
       dsGraph = service.graph(datasetID);
    }

    const acceptIDs = rapid.acceptIDs;
    const ignoreIDs = rapid.ignoreIDs;

    // Gather data
    const data = { points: [], vertices: new Set(), lines: [], polygons: [] };

    /* Facebook AI/ML */
    if (dataset.service === 'mapwithai') {
      if (zoom >= 15) {  // avoid firing off too many API requests
        service.loadTiles(datasetID);  // fetch more
      }

      const entities = service.getData(datasetID);

      // fb_ai service gives us roads and buildings together,
      // so filter further according to which dataset we're drawing
      const isRoadDataset = (dataset.id === 'fbRoads' ||
        dataset.id === 'omdFootways' ||
        dataset.id === 'metaSyntheticFootways' ||
        dataset.id === 'rapid_intro_graph');

      if (isRoadDataset) {
        for (const entity of entities) {
          if (entity.type !== 'way') continue;
          if (acceptIDs.has(entity.id) || ignoreIDs.has(entity.id)) continue;
          if (entity.geometry(dsGraph) !== 'line' || !entity.tags.highway) continue;

          data.lines.push(entity);
          if (dsGraph) {
            const first = dsGraph.hasEntity(entity.first());
            if (first) data.vertices.add(first);
            const last = dsGraph.hasEntity(entity.last());
            if (last) data.vertices.add(last);
          }
        }

      } else {  // ms buildings or esri buildings through conflation service
        for (const entity of entities) {
          if (entity.type !== 'way') continue;
          if (acceptIDs.has(entity.id) || ignoreIDs.has(entity.id)) continue;
          if (entity.geometry(dsGraph) === 'area') {
            data.polygons.push(entity);
          }
        }
      }

    /* ESRI ArcGIS */
    } else if (dataset.service === 'esri') {
      if (zoom >= 14) {  // avoid firing off too many API requests
        service.loadTiles(datasetID);  // fetch more
      }

      const entities = service.getData(datasetID);
      for (const entity of entities) {
        if (acceptIDs.has(entity.id) || ignoreIDs.has(entity.id)) continue;  // skip features already accepted/ignored by the user
        const geom = entity.geometry(dsGraph);
        if (geom === 'point' && !!entity.__fbid__) {  // standalone points only (not vertices/childnodes)
          data.points.push(entity);
        } else if (geom === 'line') {
          data.lines.push(entity);
        } else if (geom === 'area') {
          data.polygons.push(entity);
        }
      }

    } else if (dataset.service === 'overture') {
      if (zoom >= 16) {  // avoid firing off too many API requests
        service.loadTiles(datasetID);  // fetch more
      }
      const entities = service.getData(datasetID);
      const isPlacesDataset = datasetID.includes('places');
      const isBuildingsDataset = datasetID.includes('buildings');
      const isRoadsDataset = datasetID.includes('roads');

      if (isBuildingsDataset || isRoadsDataset) {
        dsGraph = service.graph(dataset.id);
      }

      // Support both points (places) and polygons (buildings)
      for (const entity of entities) {
        if (acceptIDs.has(entity.id) || ignoreIDs.has(entity.id)) continue;

        if (isPlacesDataset) {
          // Points for places (GeoJSON features from VectorTileService)
          entity.overture = true;
          entity.__datasetid__ = datasetID;
          data.points.push(entity);
        } else if (isBuildingsDataset) {
          // Polygons for buildings (OSM entities from OvertureService)
          if (entity.type === 'way') {
            data.polygons.push(entity);
          }
        } else if (isRoadsDataset) {
          // Lines for roads (OSM entities from OvertureService)
          if (entity.type === 'way') {
            data.lines.push(entity);
            if (dsGraph) {
              const first = dsGraph.hasEntity(entity.first());
              if (first) data.vertices.add(first);
              const last = dsGraph.hasEntity(entity.last());
              if (last) data.vertices.add(last);
            }
          }
        }
      }

    } else if (dataset.service === 'external') {
      if (zoom >= 13) {
        service.loadTiles(datasetID);
      }

      const entities = service.getData(datasetID);
      for (const entity of entities) {
        if (acceptIDs.has(entity.id) || ignoreIDs.has(entity.id)) continue;

        if (entity?.type && typeof entity.geometry === 'function') {
          const geom = entity.geometry(dsGraph);
          if (geom === 'point' && !!entity.__fbid__) {
            data.points.push(entity);
          } else if (geom === 'line') {
            data.lines.push(entity);
          } else if (geom === 'area') {
            data.polygons.push(entity);
          }
          continue;
        }

        if (!entity?.geometry) continue;

        const type = entity.geometry.type;
        if (type === 'Point' || type === 'MultiPoint') {
          entity.overture = true;  // mark as geojson-style feature for point label/render branch
          entity.__datasetid__ = datasetID;
          data.points.push(entity);
        } else if (type === 'LineString' || type === 'MultiLineString') {
          entity.overture = true;
          entity.__datasetid__ = datasetID;
          data.lines.push(entity);
        } else if (type === 'Polygon' || type === 'MultiPolygon') {
          entity.overture = true;
          entity.__datasetid__ = datasetID;
          data.polygons.push(entity);
        }
      }
    }

    const pointsContainer = this.scene.groups.get('points');
    const { areas: areasContainer, lines: linesContainer } = this._getDatasetContainers(dataset.id);

    this.renderPolygons(areasContainer, dataset, dsGraph, frame, viewport, zoom, data);
    this.renderLines(linesContainer, dataset, dsGraph, frame, viewport, zoom, data);
    this.renderPoints(pointsContainer, dataset, dsGraph, frame, viewport, zoom, data);
  }


  /**
   * renderPolygons
   */
  renderPolygons(parentContainer, dataset, graph, frame, viewport, zoom, data) {
    const color = this._getDatasetColor(dataset);
    const l10n = this.context.systems.l10n;

    for (const entity of data.polygons) {
      let parts = [];
      if (entity.overture) {
        const geojson = entity.geometry;
        parts = (geojson.type === 'Polygon') ? [geojson.coordinates]
          : (geojson.type === 'MultiPolygon') ? geojson.coordinates : [];
      } else {
        // Cache GeoJSON resolution, as we expect the rewind and asGeoJSON calls to be kinda slow.
        // This is ok because the rapid features won't change once loaded.
        let geojson = this._resolved.get(entity.id);
        if (!geojson) {
          geojson = geojsonRewind(entity.asGeoJSON(graph), true);
          this._resolved.set(entity.id, geojson);
        }

        parts = (geojson.type === 'Polygon') ? [geojson.coordinates]
          : (geojson.type === 'MultiPolygon') ? geojson.coordinates : [];
      }

      for (let i = 0; i < parts.length; ++i) {
        const coords = parts[i];
        const featureID = `${this.layerID}-${dataset.id}-${entity.id}-${i}`;
        let feature = this.features.get(featureID);

        if (!feature) {
          feature = new PixiFeaturePolygon(this, featureID);

          feature.geometry.setCoords(coords);
          const area = feature.geometry.origExtent.area();   // estimate area from extent for speed
          feature.container.zIndex = -area;      // sort by area descending (small things above big things)

          feature.parentContainer = parentContainer;
          feature.rapidFeature = true;
          if (entity.overture) {
            feature.allowInteraction = false;
          }
          feature.setData(entity.id, entity);
// shader experiment:
// check https://github.com/pixijs/pixijs/discussions/7728 for some discussion
// we are fighting with the batch system which is unfortunate
// feature.fill.geometry.isBatchable = () => { return false; };
// feature.fill.shader = this._customshader;

// also custom `.shader` dont work on sprites at all, and so we'd have to switch to meshes maybe?
        }

        this.syncFeatureClasses(feature);

        if (feature.dirty) {
          const style = {
            labelTint: color,
            fill: { width: 2, color: color, alpha: 0.3 },
            // fill: { width: 2, color: color, alpha: 1, pattern: 'stripe' }
          };
          feature.style = style;
          feature.label = this._getFeatureLabel(entity, l10n);
          feature.update(viewport, zoom);
        }

        this.retainFeature(feature, frame);
      }
    }
  }


  /**
   * renderLines
   */
  renderLines(parentContainer, dataset, graph, frame, viewport, zoom, data) {
    const color = this._getDatasetColor(dataset);
    const l10n = this.context.systems.l10n;

    for (const entity of data.lines) {
      const featureID = `${this.layerID}-${dataset.id}-${entity.id}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        let coords;
        if (entity.overture) {
          coords = entity.geometry.coordinates;
        } else {
          const geojson = entity.asGeoJSON(graph);
          coords = geojson.coordinates;
          if (entity.tags.oneway === '-1') {
            coords.reverse();
          }
        }

        feature = new PixiFeatureLine(this, featureID);
        feature.geometry.setCoords(coords);
        feature.parentContainer = parentContainer;
        feature.rapidFeature = true;
        if (entity.overture) {
          feature.allowInteraction = false;
        }
        feature.setData(entity.id, entity);
      }

      this.syncFeatureClasses(feature);

      if (feature.dirty) {
        const style = {
          labelTint: color,
          casing: { width: 5, color: 0x444444 },
          stroke: { width: 3, color: color },
        };
        style.lineMarkerName = (entity.overture || !entity.isOneWay || !entity.isOneWay()) ? '' : 'oneway';
        feature.style = style;
        feature.label = this._getFeatureLabel(entity, l10n);
        feature.update(viewport, zoom);
      }

      this.retainFeature(feature, frame);
    }
  }


  /**
   * renderPoints
   */
  renderPoints(parentContainer, dataset, graph, frame, viewport, zoom, data) {
    const color = this._getDatasetColor(dataset);
    const l10n = this.context.systems.l10n;

    const pointStyle = {
      markerName: 'largeCircle',
      markerTint: color,
      iconName: 'maki-circle-stroked',
      labelTint: color
    };
    const vertexStyle = {
      markerName: 'smallCircle',
      markerTint: color,
      labelTint: color
    };

    for (const entity of data.points) {
      const featureID = `${this.layerID}-${dataset.id}-${entity.id}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        feature = new PixiFeaturePoint(this, featureID);
        feature.geometry.setCoords(entity.loc || entity.geojson.geometry.coordinates);
        feature.parentContainer = parentContainer;
        feature.rapidFeature = true;
        if (entity.overture) {
          feature.allowInteraction = false;
        }
        feature.setData(entity.id, entity);
      }

      this.syncFeatureClasses(feature);

      if (feature.dirty) {
        feature.style = pointStyle;
        feature.label = this._getFeatureLabel(entity, l10n);

        // experiment: label addresses
        const pointTags = this._getFeatureTags(entity);
        const housenumber = pointTags['addr:housenumber'];
        if (!feature.label && housenumber) {
          feature.label = housenumber;
        }

        feature.update(viewport, zoom);
      }

      this.retainFeature(feature, frame);
    }


    for (const entity of data.vertices) {
      const featureID = `${this.layerID}-${entity.id}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        feature = new PixiFeaturePoint(this, featureID);
        feature.geometry.setCoords(entity.loc);
        feature.parentContainer = parentContainer;
        feature.rapidFeature = true;
        feature.allowInteraction = false;   // vertices in this layer don't actually need to be interactive
        feature.setData(entity.id, entity);
      }

      this.syncFeatureClasses(feature);

      if (feature.dirty) {
        feature.style = vertexStyle;
        feature.label = this._getFeatureLabel(entity, l10n);
        // experiment: label addresses
        const vertexTags = this._getFeatureTags(entity);
        const housenumber = vertexTags['addr:housenumber'];
        if (!feature.label && housenumber) {
          feature.label = housenumber;
        }
        feature.update(viewport, zoom);
      }

      this.retainFeature(feature, frame);
    }

  }


  _getDatasetContainers(datasetID) {
    let containers = this._datasetContainers.get(datasetID);
    if (containers) return containers;

    const basemapContainer = this.scene.groups.get('basemap');
    const areas = new PIXI.Container();
    areas.label = `${this.layerID}-${datasetID}-areas`;
    areas.sortableChildren = true;

    const lines = new PIXI.Container();
    lines.label = `${this.layerID}-${datasetID}-lines`;
    lines.sortableChildren = true;

    basemapContainer.addChild(areas, lines);

    containers = { areas, lines };
    this._datasetContainers.set(datasetID, containers);
    return containers;
  }


  _getDatasetColor(dataset) {
    const datasetID = dataset.id;
    const colorVal = dataset.color;

    let colorEntry = this._datasetColors.get(datasetID);
    if (!colorEntry || colorEntry.color !== colorVal) {
      colorEntry = {
        color: colorVal,
        pixi: new PIXI.Color(colorVal)
      };
      this._datasetColors.set(datasetID, colorEntry);
    }

    return colorEntry.pixi;
  }

}
