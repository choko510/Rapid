import * as PIXI from 'pixi.js';
import geojsonRewind from '@mapbox/geojson-rewind';
import { vecAngle } from '@rapid-sdk/math';

import { AbstractLayer } from './AbstractLayer.js';
import { PixiFeatureLine } from './PixiFeatureLine.js';
import { PixiFeaturePoint } from './PixiFeaturePoint.js';
import { PixiFeaturePolygon } from './PixiFeaturePolygon.js';
import { getRadiusInPixels } from '../core/lib/Planar.js';

const MINZOOM = 12;


/**
 * PixiLayerOsm
 * @class
 */
export class PixiLayerOsm extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);
    this.enabled = true;   // OSM layers should be enabled by default

    this.areaContainer = null;
    this.lineContainer = null;
    this._lineLevelContainers = new Map();

    this._resolved = new Map();  // Map <entityID, GeoJSON feature>
    this._renderData = {
      polygons: new Map(),
      lines: new Map(),
      points: new Map(),
      vertices: new Map()
    };
    this._scratchDataIDs = new Set();
    this._scratchInterestingIDs = new Set();
    this._scratchRelated = {
      descendantIDs: new Set(),
      siblingIDs: new Set()
    };
    this._scratchMidpoints = new Map();
    this._midpointStyle = { markerName: 'midpoint' };
  }


  /**
   * supported
   * Whether the Layer's service exists
   */
  get supported() {
    return !!this.context.services.osm;
  }


  /**
   * enabled
   * Whether the user has chosen to see the Layer
   * Make sure to start the service first.
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
    const osm = context.services.osm;
    if (val && osm) {
      osm.startAsync()
        .then(() => gfx.immediateRedraw());
    }
  }


// experiment for benchmarking
//  /**
//   * downloadFile
//   * experiment for benchmarking
//   * @param  data
//   * @param  fileName
//   */
//  _downloadFile(data, fileName) {
//    let a = document.createElement('a');   // Create an invisible A element
//    a.style.display = 'none';
//    document.body.appendChild(a);
//
//    // Set the HREF to a Blob representation of the data to be downloaded
//    a.href = window.URL.createObjectURL(new Blob([data]));
//
//    // Use download attribute to set set desired file name
//    a.setAttribute('download', fileName);
//
//    // Trigger the download by simulating click
//    a.click();
//
//    // Cleanup
//    window.URL.revokeObjectURL(a.href);
//    document.body.removeChild(a);
//  }


  /**
   * reset
   * Every Layer should have a reset function to replace any Pixi objects and internal state.
   */
  reset() {
    super.reset();

    this._resolved.clear();  // cached geojson features
    this._renderData.polygons.clear();
    this._renderData.lines.clear();
    this._renderData.points.clear();
    this._renderData.vertices.clear();
    this._scratchDataIDs.clear();
    this._scratchInterestingIDs.clear();
    this._scratchRelated.descendantIDs.clear();
    this._scratchRelated.siblingIDs.clear();
    this._scratchMidpoints.clear();
    this._lineLevelContainers.clear();

    const groupContainer = this.scene.groups.get('basemap');

    // Remove any existing containers
    for (const child of groupContainer.children) {
      if (child.label.startsWith(this.layerID + '-')) {   // 'osm-*'
        groupContainer.removeChild(child);
        child.destroy({ children: true });  // recursive
      }
    }

    // Add containers
    const areas = new PIXI.Container();
    areas.label = `${this.layerID}-areas`;   // e.g. osm-areas
    areas.sortableChildren = true;
    this.areaContainer = areas;

    const lines = new PIXI.Container();
    lines.label = `${this.layerID}-lines`;   // e.g. osm-lines
    lines.sortableChildren = true;
    this.lineContainer = lines;

    groupContainer.addChild(areas, lines);
  }


  /**
   * render
   * Render any data we have, and schedule fetching more of it to cover the view
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  render(frame, viewport, zoom) {
    const context = this.context;
    const osm = context.services.osm;
    if (!this.enabled || !osm?.started || zoom < MINZOOM) return;

    const editor = context.systems.editor;
    const filters = context.systems.filters;
    const graph = editor.staging.graph;

    context.loadTiles();  // Load tiles of OSM data to cover the view

    let entities = editor.intersects(context.viewport.visibleExtent());   // Gather data in view
    entities = filters.filterScene(entities, graph);   // Apply feature filters

    const data = this._renderData;
    data.polygons.clear();
    data.lines.clear();
    data.points.clear();
    data.vertices.clear();

    for (const entity of entities) {
      const geom = entity.geometry(graph);
      if (geom === 'point') {
        data.points.set(entity.id, entity);
      } else if (geom === 'vertex') {
        data.vertices.set(entity.id, entity);
      } else if (geom === 'line') {
        data.lines.set(entity.id, entity);
      } else if (geom === 'area') {
        data.polygons.set(entity.id, entity);
      }
    }

// experiment for benchmarking
//    // Instructions to save 'canned' entity data for use in the renderer test suite:
//    // Set a breakpoint at the next line, then modify `this._saveCannedData` to be 'true'
//    // continuing will fire off the download of the data into a file called 'canned_data.json'.
//    // move the data into the test/spec/renderer directory.
//    if (this._saveCannedData && !this._alreadyDownloaded) {
//      const [lng, lat] = map.center();
//
//      let viewData = {
//        'lng': lng,
//        'lat': lat,
//        'zoom': zoom,
//        'width': window.innerWidth,
//        'height': window.innerHeight,
//        'viewport': viewport,
//        'data': data,
//        'entities': graph.base.entities   // TODO convert from Map to Object if we are keeping this)
//      };
//
//      let cannedData = JSON.stringify(viewData);
//      this._downloadFile(cannedData,`${zoom}_${lat}_${lng}_canned_osm_data.json`);
//      this._alreadyDownloaded = true;
//    }

    this.renderPolygons(frame, viewport, zoom, data);
    this.renderLines(frame, viewport, zoom, data);
    this.renderPoints(frame, viewport, zoom, data);

    // At this point, all the visible linear features have been accounted for,
    // and parent-child data links have been established.

    // Gather ids related for the selected/hovered/drawing features.
    const selectedIDs = this.getDataWithClass('select', false);
    const hoveredIDs = this.getDataWithClass('hover', false);
    const drawingIDs = this.getDataWithClass('drawing', false);
    const dataIDs = this._scratchDataIDs;
    dataIDs.clear();
    for (const dataID of selectedIDs) dataIDs.add(dataID);
    for (const dataID of hoveredIDs) dataIDs.add(dataID);
    for (const dataID of drawingIDs) dataIDs.add(dataID);

    // Experiment: avoid showing child vertices/midpoints for too small parents
    for (const dataID of dataIDs) {
      const entity = graph.hasEntity(dataID);
      if (entity?.type === 'node') continue;  // ways, relations only

      const renderedFeatureIDs = this._dataHasFeature.get(dataID);
      if (!renderedFeatureIDs?.size) continue;
      let tooSmall = false;
      for (const featureID of renderedFeatureIDs) {
        const geom = this.features.get(featureID)?.geometry;
        if (!geom || geom.type === 'point') continue;  // lines, polygons only (i.e. ignore virtual poi if any)
        if (geom.width < 25 && geom.height < 25) {
          tooSmall = true;
          break;
        }
      }
      if (tooSmall) {
        dataIDs.delete(dataID);
      }
    }

    // Expand set to include parent ways for selected/hovered/drawing nodes too..
    const interestingIDs = this._scratchInterestingIDs;
    interestingIDs.clear();
    for (const dataID of dataIDs) {
      interestingIDs.add(dataID);
      const entity = graph.hasEntity(dataID);
      if (entity?.type !== 'node') continue;   // nodes only
      for (const parent of graph.parentWays(entity)) {
        interestingIDs.add(parent.id);
      }
    }

    // Create collections of the sibling and descendant IDs,
    // These will determine which vertices and midpoints get drawn.
    const related = this._scratchRelated;
    related.descendantIDs.clear();
    related.siblingIDs.clear();
    for (const interestingID of interestingIDs) {
      this.getSelfAndDescendants(interestingID, related.descendantIDs);
      this.getSelfAndSiblings(interestingID, related.siblingIDs);
    }

    this.renderVertices(frame, viewport, zoom, data, related);

    if (context.mode?.id === 'select-osm') {
      this.renderMidpoints(frame, viewport, zoom, data, related);
    }
  }


  /**
   * renderPolygons
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   * @param  data       Visible OSM data to render, sorted by type
   */
  renderPolygons(frame, viewport, zoom, data) {
    const entities = data.polygons;
    const context = this.context;
    const graph = context.systems.editor.staging.graph;
    const filters = context.systems.filters;
    const l10n = context.systems.l10n;
    const presets = context.systems.presets;
    const styles = context.systems.styles;

    const pointsContainer = this.scene.groups.get('points');
    const showPoints = filters.isEnabled('points');

    for (const [entityID, entity] of entities) {
      const version = entity.v || 0;

      // Cache GeoJSON resolution, as we expect the rewind and asGeoJSON calls to be kinda slow.
      let geojson = this._resolved.get(entityID);
      if (geojson?.v !== version) {  // bust cache if the entity has a new version
        geojson = null;
      }
      if (!geojson) {
        geojson = geojsonRewind(entity.asGeoJSON(graph), true);
        geojson.v = version;
        this._resolved.set(entityID, geojson);
      }

      const parts = (geojson.type === 'Polygon') ? [geojson.coordinates]
        : (geojson.type === 'MultiPolygon') ? geojson.coordinates : [];

      for (let i = 0; i < parts.length; ++i) {
        const coords = parts[i];
        const featureID = `${this.layerID}-${entityID}-${i}`;
        let feature = this.features.get(featureID);

        // If feature existed before as a different type, recreate it.
        if (feature && feature.type !== 'polygon') {
          feature.destroy();
          feature = null;
        }

        if (!feature) {
          feature = new PixiFeaturePolygon(this, featureID);
          feature.parentContainer = this.areaContainer;
        }

        // If data has changed.. Replace data and parent-child links.
        if (feature.v !== version) {
          feature.v = version;
          feature.geometry.setCoords(coords);
          const area = feature.geometry.origExtent.area();   // estimate area from extent for speed
          feature.container.zIndex = -area;      // sort by area descending (small things above big things)

          feature.setData(entityID, entity);
          feature.clearChildData(entityID);
          if (entity.type === 'relation') {
            for (const member of entity.members) {
              feature.addChildData(entityID, member.id);
            }
          }
          if (entity.type === 'way') {
            for (const nodeID of entity.nodes) {
              feature.addChildData(entityID, nodeID);
            }
          }
        }

        this.syncFeatureClasses(feature);

        if (feature.dirty) {
          const preset = presets.match(entity, graph);

          const style = styles.styleMatch(entity.tags);
          style.labelTint = style.fill.color ?? style.stroke.color ?? 0xeeeeee;
          feature.style = style;

          const label = l10n.displayPOIName(entity.tags);
          feature.label = label;

          // POI = "Point of Interest" -and- "Pole of Inaccessability"
          // For POIs mapped as polygons, we can create a virtual point feature at the pole of inaccessability.
          // Try to show a virtual pin if there is a label or if the preset is interesting enough..
          if (showPoints && (label || isInterestingPreset(preset))) {
            feature.poiFeatureID = `${this.layerID}-${entityID}-poi-${i}`;
            feature.poiPreset = preset;
          } else {
            feature.poiFeatureID = null;
            feature.poiPreset = null;
          }
        }

        feature.update(viewport, zoom);
        this.retainFeature(feature, frame);

        // Same as above, but for the virtual POI, if any
        // Confirm that `feature.geometry.origPoi` exists - we may have skipped it if `feature.geometry.lod = 0`
        if (feature.poiFeatureID && feature.poiPreset && feature.geometry.origPoi) {
          let poiFeature = this.features.get(feature.poiFeatureID);

          if (!poiFeature) {
            poiFeature = new PixiFeaturePoint(this, feature.poiFeatureID);
            poiFeature.virtual = true;
            poiFeature.parentContainer = pointsContainer;
          }

          if (poiFeature.v !== version) {
            poiFeature.v = version;
            poiFeature.geometry.setCoords(feature.geometry.origPoi);  // pole of inaccessability
            poiFeature.setData(entityID, entity);
          }

          this.syncFeatureClasses(poiFeature);

          if (poiFeature.dirty) {
            let markerStyle = {
              iconName: feature.poiPreset.icon,
              iconTint: 0x111111,
              markerName: 'pin',
              markerTint: 0xffffff
            };

            if (hasWikidata(entity)) {
              markerStyle.iconTint = 0x444444;
              markerStyle.labelTint = 0xdddddd;
              markerStyle.markerName = 'boldPin';
              markerStyle.markerTint = 0xdddddd;
            }
            poiFeature.style = markerStyle;
            poiFeature.label = feature.label;
          }

          poiFeature.update(viewport, zoom);
          this.retainFeature(poiFeature, frame);
        }

      }
    }
  }


  /**
   * renderLines
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   * @param  data       Visible OSM data to render, sorted by type
   */
  renderLines(frame, viewport, zoom, data) {
    const entities = data.lines;
    const context = this.context;
    const graph = context.systems.editor.staging.graph;
    const l10n = context.systems.l10n;
    const styles = context.systems.styles;

    for (const [entityID, entity] of entities) {
      const layer = ((typeof entity.layer === 'function') ? entity.layer() : 0).toString();
      const levelContainer = this._getLineLevelContainer(layer);
      const zindex = getzIndex(entity.tags);
      const version = entity.v || 0;

      // Cache GeoJSON resolution, as we expect the asGeoJSON call to be kinda slow.
      let geojson = this._resolved.get(entityID);
      if (geojson?.v !== version) {  // bust cache if the entity has a new version
        geojson = null;
      }
      if (!geojson) {
        geojson = entity.asGeoJSON(graph);
        geojson.v = version;
        if (geojson.type === 'LineString' && shouldReverseForDirectionTags(entity.tags)) {
          geojson.coordinates.reverse();
        }
        this._resolved.set(entityID, geojson);
      }

      const parts = (geojson.type === 'LineString') ? [[geojson.coordinates]]
        : (geojson.type === 'Polygon') ? [geojson.coordinates]
        : (geojson.type === 'MultiPolygon') ? geojson.coordinates : [];

      for (let i = 0; i < parts.length; ++i) {
        const segments = parts[i];
        for (let j = 0; j < segments.length; ++j) {
          const coords = segments[j];
          const featureID = `${this.layerID}-${entityID}-${i}-${j}`;
          let feature = this.features.get(featureID);

          // If feature existed before as a different type, recreate it.
          if (feature && feature.type !== 'line') {
            feature.destroy();
            feature = null;
          }

          if (!feature) {
            feature = new PixiFeatureLine(this, featureID);
          }

          // If data has changed.. Replace data and parent-child links.
          if (feature.v !== version) {
            feature.v = version;
            feature.geometry.setCoords(coords);
            feature.parentContainer = levelContainer;    // Change layer stacking if necessary
            feature.container.zIndex = zindex;

            feature.setData(entityID, entity);
            feature.clearChildData(entityID);
            if (entity.type === 'relation') {
              for (const member of entity.members) {
                feature.addChildData(entityID, member.id);
              }
            }
            if (entity.type === 'way') {
              for (const nodeID of entity.nodes) {
                feature.addChildData(entityID, nodeID);
              }
            }
          }

          this.syncFeatureClasses(feature);

          if (feature.dirty) {
            let tags = entity.tags;
            let geom = entity.geometry(graph);

            // a line no tags - try to style match the tags of its parent relation
            if (!entity.hasInterestingTags()) {
              const parent = graph.parentRelations(entity).find(relation => relation.isMultipolygon());
              if (parent) {
                tags = parent.tags;
                geom = 'area';
              }
            }

            const style = styles.styleMatch(tags);
            // Todo: handle alternating/two-way case too
            if (geom === 'line') {
              style.lineMarkerName = entity.isOneWay() ? 'oneway' : '';
              style.sidedMarkerName = entity.isSided() ? 'sided' : '';
            } else {  // an area
              style.casing.width = 0;
              style.stroke.color = style.fill.color;
              style.stroke.width = 2;
              style.stroke.alpha = 1;
            }
            feature.style = style;

            feature.label = l10n.displayName(entity.tags);
          }

          feature.update(viewport, zoom);
          this.retainFeature(feature, frame);
        }
      }
    }
  }


  /**
   * renderVertices
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   * @param  data       Visible OSM data to render, sorted by type
   * @param  realated   Collections of related OSM IDs
   */
  renderVertices(frame, viewport, zoom, data, related) {
    const entities = data.vertices;
    const context = this.context;
    const graph = context.systems.editor.staging.graph;
    const l10n = context.systems.l10n;
    const presets = context.systems.presets;

    // Vertices related to the selection/hover should be drawn above everything
    const selectedContainer = this.scene.layers.get('map-ui').selected;
    const pointsContainer = this.scene.groups.get('points');

    for (const [nodeID, node] of entities) {
      let parentContainer = null;

      const isRelated = related.descendantIDs.has(nodeID) || related.siblingIDs.has(nodeID);
      if (isRelated) {   // major importance
        parentContainer = selectedContainer;
      } else if (zoom >= 16 && (node.hasInterestingTags() || node.isEndpoint(graph) || node.isIntersection(graph))) {
        parentContainer = pointsContainer;  // minor importance
      }

      if (!parentContainer) continue;   // this vertex isn't important enough to render

      const featureID = `${this.layerID}-${nodeID}`;
      const version = node.v || 0;
      let feature = this.features.get(featureID);

      // If feature existed before as a different type, recreate it.
      if (feature && feature.type !== 'point') {
        feature.destroy();
        feature = null;
      }

      if (!feature) {
        feature = new PixiFeaturePoint(this, featureID);
      }

      // If data has changed, replace it.
      if (feature.v !== version) {
        feature.v = version;
        feature.geometry.setCoords(node.loc);
        feature.setData(nodeID, node);
      }

      this.syncFeatureClasses(feature);
      feature.parentContainer = parentContainer;   // change layer stacking if necessary

      if (feature.dirty) {
        const preset = presets.match(node, graph);
        const iconName = preset?.icon;
        const directions = node.directions(graph, context.viewport);
        const radiusPixels = feature.hasClass('select') ? getRadiusInPixels(node, viewport) : 0;

        // set marker style
        let markerStyle = {
          iconName: iconName,
          iconTint: 0x111111,
          labelTint: 0xeeeeee,
          markerName: 'smallCircle',
          markerTint: 0xffffff,
          radiusPixels: radiusPixels,
          viewfieldAngles: directions,
          viewfieldName: 'viewfieldDark',
          viewfieldTint: 0xffffff
        };

        if (iconName) {
          markerStyle.markerName = 'largeCircle';
          markerStyle.iconName = iconName;
        } else if (node.hasInterestingTags()) {
          markerStyle.markerName = 'taggedCircle';
        }

        if (hasWikidata(node)) {
          markerStyle.iconTint = 0x444444;
          markerStyle.labelTint = 0xdddddd;
          markerStyle.markerTint = 0xdddddd;
        }
        if (graph.isShared(node)) {     // shared nodes / junctions are more grey
          markerStyle.iconTint = 0x111111;
          markerStyle.labelTint = 0xbbbbbb;
          markerStyle.markerTint = 0xbbbbbb;
        }

        feature.style = markerStyle;
        feature.label = l10n.displayName(node.tags);
      }

      feature.update(viewport, zoom);
      this.retainFeature(feature, frame);
    }
  }


  _getLineLevelContainer(level) {
    let levelContainer = this._lineLevelContainers.get(level);
    if (!levelContainer) {
      levelContainer = new PIXI.Container();
      levelContainer.label = level;
      levelContainer.sortableChildren = true;
      levelContainer.zIndex = Number(level);
      this.lineContainer.addChild(levelContainer);
      this._lineLevelContainers.set(level, levelContainer);
    }
    return levelContainer;
  }


  /**
   * renderPoints
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   * @param  data       Visible OSM data to render, sorted by type
   */
  renderPoints(frame, viewport, zoom, data) {
    const entities = data.points;
    const context = this.context;
    const graph = context.systems.editor.staging.graph;
    const l10n = context.systems.l10n;
    const presets = context.systems.presets;
    const pointsContainer = this.scene.groups.get('points');

    for (const [nodeID, node] of entities) {
      const featureID = `${this.layerID}-${nodeID}`;
      const version = node.v || 0;
      let feature = this.features.get(featureID);

      // If feature existed before as a different type, recreate it.
      if (feature && feature.type !== 'point') {
        feature.destroy();
        feature = null;
      }

      if (!feature) {
        feature = new PixiFeaturePoint(this, featureID);
        feature.parentContainer = pointsContainer;
      }

      // If data has changed, replace it.
      if (feature.v !== version) {
        feature.v = version;
        feature.geometry.setCoords(node.loc);
        feature.setData(nodeID, node);
      }

      this.syncFeatureClasses(feature);

      if (feature.dirty) {
        let preset = presets.match(node, graph);
        let iconName = preset?.icon;
        const radiusPixels = feature.hasClass('select') ? getRadiusInPixels(node, viewport) : 0;

        // If we matched a generic preset without an icon, try matching it as a 'vertex'
        // This is just to choose a better icon for an otherwise empty-looking pin.
        if (!iconName) {
          preset = presets.matchTags(node.tags, 'vertex');
          iconName = preset?.icon;
        }

        const directions = node.directions(graph, context.viewport);

        // set marker style
        let markerStyle = {
          iconName: iconName,
          iconTint: 0x111111,
          markerName: 'pin',
          markerTint: 0xffffff,
          radiusPixels: radiusPixels,
          viewfieldAngles: directions,
          viewfieldName: 'viewfieldDark',
          viewfieldTint: 0xffffff
        };

        if (hasWikidata(node)) {
          markerStyle.iconTint = 0x444444;
          markerStyle.labelTint = 0xdddddd;
          markerStyle.markerName = 'boldPin';
          markerStyle.markerTint = 0xdddddd;
        }
        if (preset.id === 'address') {
          markerStyle.iconName = 'maki-circle-stroked';
          markerStyle.markerName = 'largeCircle';
        }

        feature.style = markerStyle;
        feature.label = l10n.displayName(node.tags);
      }

      feature.update(viewport, zoom);
      this.retainFeature(feature, frame);
    }
  }


  /**
   * renderMidpoints
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   * @param  data       Visible OSM data to render, sorted by type
   * @param  related    Collections of related OSM IDs
   */
  renderMidpoints(frame, viewport, zoom, data, related) {
    const MIN_MIDPOINT_DIST = 40;   // distance in pixels
    const MIN_MIDPOINT_DIST_SQ = MIN_MIDPOINT_DIST * MIN_MIDPOINT_DIST;
    const context = this.context;
    const graph = context.systems.editor.staging.graph;

    // Midpoints should be drawn above everything
    const selectedContainer = this.scene.layers.get('map-ui').selected;

    // Generate midpoints from all the highlighted ways
    const midpoints = this._scratchMidpoints;
    midpoints.clear();
    const MIDPOINT_STYLE = this._midpointStyle;

    _collectMidpoints(data.lines);
    _collectMidpoints(data.polygons);

    for (const [midpointID, midpoint] of midpoints) {
      const featureID = `${this.layerID}-${midpointID}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        feature = new PixiFeaturePoint(this, featureID);
        feature.style = MIDPOINT_STYLE;
        feature.parentContainer = selectedContainer;
      }

      // Something about the midpoint has changed
      const v = _midpointVersion(midpoint);
      if (feature.v !== v) {
        feature.v = v;
        feature.geometry.setCoords(midpoint.loc);

        // Remember to apply rotation - it needs to go on the marker,
        // because the container automatically rotates to be face up.
        feature.marker.rotation = midpoint.rot;

        feature.setData(midpointID, midpoint);
        feature.addChildData(midpoint.way.id, midpointID);
      }

      this.syncFeatureClasses(feature);
      feature.update(viewport, zoom);
      this.retainFeature(feature, frame);
    }


    function _collectMidpoints(entities) {
      for (const [wayID, way] of entities) {
        // Include only ways that are selected, or descended from a relation that is selected
        if (!related.descendantIDs.has(wayID)) continue;

        // Include only actual ways that have child nodes
        const nodes = graph.childNodes(way);
        if (nodes.length < 2) continue;

        if (way.tags.oneway === '-1') {
          let aNode = nodes[nodes.length - 1];
          let aPoint = viewport.project(aNode.loc);
          for (let i = nodes.length - 2; i >= 0; i--) {
            const bNode = nodes[i];
            const bPoint = viewport.project(bNode.loc);
            _addMidpoint(aNode, aPoint, bNode, bPoint, way);
            aNode = bNode;
            aPoint = bPoint;
          }
        } else {
          let aNode = nodes[0];
          let aPoint = viewport.project(aNode.loc);
          for (let i = 1; i < nodes.length; i++) {
            const bNode = nodes[i];
            const bPoint = viewport.project(bNode.loc);
            _addMidpoint(aNode, aPoint, bNode, bPoint, way);
            aNode = bNode;
            aPoint = bPoint;
          }
        }
      }
    }

    function _addMidpoint(aNode, aPoint, bNode, bPoint, way) {
      const midpointID = (aNode.id < bNode.id) ?
        `${aNode.id}-${bNode.id}` : `${bNode.id}-${aNode.id}`;
      if (midpoints.has(midpointID)) return;

      const dx = aPoint[0] - bPoint[0];
      const dy = aPoint[1] - bPoint[1];
      if ((dx * dx + dy * dy) < MIN_MIDPOINT_DIST_SQ) return;

      const pos = [(aPoint[0] + bPoint[0]) * 0.5, (aPoint[1] + bPoint[1]) * 0.5];
      const rot = vecAngle(aPoint, bPoint) + viewport.transform.rotation;
      const loc = viewport.unproject(pos);  // store as wgs84 lon/lat

      midpoints.set(midpointID, {
        type: 'midpoint',
        id: midpointID,
        a: { id: aNode.id, point: aPoint },
        b: { id: bNode.id, point: bPoint },
        way: way,
        loc: loc,
        rot: rot
      });
    }


    // If any of these change, the midpoint needs to be redrawn.
    // (This can happen if a sibling node has moved, the midpoint moves too)
    function _midpointVersion(d) {
      return d.loc[0] + d.loc[1] + d.rot;
    }

  }

}


// For deciding if an unlabeled polygon feature is interesting enough to show a virtual pin.
// Note that labeled polygon features will always get a virtual pin.
function isInterestingPreset(preset) {
  if (!preset || preset.isFallback()) return false;

  // These presets probably are not POIs
  if (/^(address|building|indoor|landuse|man_made|military|natural|playground)/.test(preset.id)) return false;

  // These presets probably are POIs even without a label
  // See nsi.guide for the sort of things we are looking for.
  if (/^(attraction|club|craft|emergency|healthcare|office|power|shop|telecom|tourism)/.test(preset.id)) return true;
  if (/^amenity\/(?!parking|shelter)/.test(preset.id)) return true;
  if (/^leisure\/(?!garden|firepit|picnic_table|pitch|swimming_pool)/.test(preset.id)) return true;

  return false;   // not sure, just ignore it
}



const HIGHWAYSTACK = {
  motorway: 0,
  motorway_link: -1,
  trunk: -2,
  trunk_link: -3,
  primary: -4,
  primary_link: -5,
  secondary: -6,
  tertiary: -7,
  unclassified: -8,
  residential: -9,
  service: -10,
  busway: -11,
  track: -12,
  footway: -20
};


function getzIndex(tags) {
  return HIGHWAYSTACK[tags.highway] || 0;
}

// Special style for Wikidata-tagged items
function hasWikidata(entity) {
  return (
    entity.tags.wikidata ||
    entity.tags['flag:wikidata'] ||
    entity.tags['brand:wikidata'] ||
    entity.tags['network:wikidata'] ||
    entity.tags['operator:wikidata']
  );
}


function shouldReverseForDirectionTags(tags = {}) {
  return (
    tags.oneway === '-1' ||
    tags.conveying === 'backward' ||
    tags['railway:preferred_direction'] === 'backward' ||
    tags['railway:prefered_direction'] === 'backward'
  );
}
