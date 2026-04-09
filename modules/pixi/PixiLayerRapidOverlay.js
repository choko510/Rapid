import * as PIXI from 'pixi.js';

import { AbstractLayer } from './AbstractLayer.js';


/**
 * PixiLayerRapidOverlay
 * This class contains any overlay vectors that should be 'drawn over' the map, usually at low zooms.
 * The data for these are scraped from the RapidSystem's datasets, specifically the 'overlay' field.
 * @class
 */
export class PixiLayerRapidOverlay extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);

    this._enabled = true;
    this._overlaysDefined = null;
    this.overlaysContainer = null;
    this._overlayFeatures = new Map();   // Map<featureID, PIXI.Graphics>
    this._overlayRetained = new Map();   // Map<featureID, frame>
  }


  /**
   * reset
   * Every Layer should have a reset function to replace any Pixi objects and internal state.
   */
  reset() {
    super.reset();

    const groupContainer = this.scene.groups.get('basemap');

    // Remove any existing containers
    for (const child of groupContainer.children) {
      if (child.label === this.layerID) {   // 'rapidoverlay'
        groupContainer.removeChild(child);
        child.destroy({ children: true });  // recursive
      }
    }

    // Add containers
    const overlays = new PIXI.Container();
    overlays.label = `${this.layerID}`;  // 'rapidoverlay'
    overlays.sortableChildren = false;
    overlays.interactiveChildren = true;
    this.overlaysContainer = overlays;
    this._overlaysDefined = null;
    this._overlayFeatures.clear();
    this._overlayRetained.clear();

    groupContainer.addChild(overlays);
  }


  /**
   * render
   * Render the GeoJSON custom data
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  render(frame, viewport, zoom) {
    if (!this.enabled || !(this.hasData())) return;

    const vtService = this.context.services.vectortile;
    if (!vtService) return;

    for (const dataset of this.context.systems.rapid.catalog.values()) {
      if (dataset.overlay && dataset.enabled && dataset.added) {
        const colorKey = dataset.color;
        const customColor = new PIXI.Color(dataset.color);
        const overlay = dataset.overlay;
        if ((zoom >= overlay.minZoom ) && (zoom <= overlay.maxZoom)) {  // avoid firing off too many API requests
          vtService.loadTiles(overlay.url);
        }

        const overlayData = vtService.getData(overlay.url);
        this.renderPoints(frame, viewport, overlayData, dataset.id, customColor, colorKey);
      }
    }
  }


  /**
   * renderPoints
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  data       Array of point data
   * @param  datasetID  Dataset ID
   * @param  color      The color to use
   * @param  colorKey   Key used to determine whether a point needs a style refresh
   */
  renderPoints(frame, viewport, data, datasetID, color, colorKey) {
    const parentContainer = this.overlaysContainer;
    for (let d = 0; d < data.length; d++) {
      const item = data[d];
      const geojson = item?.geojson;
      if (!geojson?.geometry) continue;

      const parts = (geojson.geometry.type === 'Point') ? [geojson.geometry.coordinates]
        : (geojson.geometry.type === 'MultiPoint') ? geojson.geometry.coordinates : [];
      const sourceID = item.id ?? geojson.id ?? d;

      for (let i = 0; i < parts.length; ++i) {
        const featureID = `${datasetID}-${sourceID}-${i}`;
        const loc = parts[i];
        const point = viewport.project(loc);
        let feature = this._overlayFeatures.get(featureID);

        if (feature && feature.__rapidColor !== colorKey) {
          feature.destroy();
          feature = null;
          this._overlayFeatures.delete(featureID);
          this._overlayRetained.delete(featureID);
        }

        if (!feature) {
          feature = new PIXI.Graphics()
            .circle(0, 0, 40)
            .fill({ color, alpha: 0.05 });
          feature.eventMode = 'none';
          feature.__rapidColor = colorKey;
          parentContainer.addChild(feature);
          this._overlayFeatures.set(featureID, feature);
        }

        feature.visible = true;
        feature.x = point[0];
        feature.y = point[1];
        this._overlayRetained.set(featureID, frame);
      }
    }
  }


  cull(frame) {
    for (const [featureID, feature] of this._overlayFeatures) {
      const seenFrame = this._overlayRetained.get(featureID);
      if (seenFrame === frame) continue;

      feature.visible = false;

      if (seenFrame === undefined || frame - seenFrame > 20) {
        feature.destroy();
        this._overlayFeatures.delete(featureID);
        this._overlayRetained.delete(featureID);
      }
    }
  }


  /**
   * hasData
   * Return true if there is any overlay endpoint URLs defined in the rapid datasets.
   * @return {boolean}  `true` if there is a vector tile template or geojson to display
   */
  hasData() {
    if (this._overlaysDefined === null) {
      this._overlaysDefined = false;
      for (const dataset of this.context.systems.rapid.catalog.values()) {
        if (dataset.overlay) {
          this._overlaysDefined = true;
          break;
        }
      }
    }

    return this._overlaysDefined;
  }

}
