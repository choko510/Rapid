import RBush from 'rbush';

import { Difference } from './Difference.js';


/**
 *  Tree
 *  A wrapper class around the `RBush` spatial index, for tracking the position of OSM Entities.
 *  Internally RBush indexes rectangular bounding boxes.
 *  The tree also must keep track of which Graph is considered "current", and will update the
 *  positions of all it's tracked Entities automatically to match the current Graph.
 *
 *  (Tree is not a good name for this thing)
 */
export class Tree {

  /**
   * @constructor
   * @param  graph  The "current" Graph of entities that this tree is tracking
   */
  constructor(graph) {
    this._current = graph;

    this._entityRBush = new RBush();
    this._entityBoxes = new Map();     // Map(entityID -> Box Object)
    this._entitySegments = new Map();  // Map(entityID -> Array[segments])

    this._segmentRBush = new RBush();
    this._segmentBoxes = new Map();    // Map(segmentID -> Box Object)
    this._queryBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  }


  /**
   * _removeEntity
   * Remove an Entity from all internal indexes.
   * @param  entityID
   */
  _removeEntity(entityID) {
    const ebox = this._entityBoxes.get(entityID);
    if (ebox) {
      this._entityRBush.remove(ebox);
      this._entityBoxes.delete(entityID);
    }

    const segments = this._entitySegments.get(entityID) ?? [];
    for (const segment of segments) {
      const segmentID = segment.id;
      const sbox = this._segmentBoxes.get(segmentID);
      if (sbox) {
        this._segmentRBush.remove(sbox);
        this._segmentBoxes.delete(segmentID);
      }
    }
    this._entitySegments.delete(entityID);
  }


  /**
   * _loadEntities
   * Add or update multiple Entities in the internal indexes.
   * @param  toUpdate  Map(entityID -> Entity) to load
   */
  _loadEntities(toUpdate) {
    const graph = this._current;

    let eboxes = [];
    let sboxes = [];

    for (const [entityID, entity] of toUpdate) {
      // Gather a bounding box for the Entity..
      const extent = entity.extent(graph);
      if (!extent) continue;

      const ebox = extent.bbox();
      ebox.id = entityID;
      this._entityBoxes.set(entityID, ebox);
      eboxes.push(ebox);

      // Gather bounding boxes for the Entity's segments (if it's a line)..
      if (typeof entity.segments !== 'function') continue;

      const segments = entity.segments(graph) ?? [];
      this._entitySegments.set(entityID, segments);

      for (const segment of segments) {
        const segmentID = segment.id;
        const segmentExtent = segment.extent(graph);
        if (!segmentExtent) continue;

        const sbox = segmentExtent.bbox();
        sbox.id = segmentID;
        sbox.segment = segment;
        this._segmentBoxes.set(segmentID, sbox);
        sboxes.push(sbox);
      }
    }

    // bulk load
    if (eboxes.length) this._entityRBush.load(eboxes);
    if (sboxes.length) this._segmentRBush.load(sboxes);
  }


  /**
   * _includeParents
   * When updating an Entity's position in the tree, we must also update
   * the positions of that Entity's parent ways and relations.
   *
   * @param  entity    Entity to check
   * @param  toUpdate  Map(entityID -> Entity)
   * @param  seen?     Set(seen entityIDs) (to avoid infinite recursion)
   */
  _includeParents(entity, toUpdate, seen) {
    const graph = this._current;
    const entityID = entity.id;
    if (!seen) seen = new Set();

    if (seen.has(entityID)) return;
    seen.add(entityID);

    for (const way of graph.parentWays(entity)) {
      if (this._entityBoxes.has(way.id)) {
        this._removeEntity(way.id);
        toUpdate.set(way.id, way);
      }
      this._includeParents(way, toUpdate, seen);
    }

    for (const relation of graph.parentRelations(entity)) {
      if (this._entityBoxes.has(relation.id)) {
        this._removeEntity(relation.id);
        toUpdate.set(relation.id, relation);
      }
      this._includeParents(relation, toUpdate, seen);
    }
  }


  /**
   * _setCurrentGraph
   * This will change the "current" Graph of this tree, performing whatever
   * operations are needed to add/update/remove tracked entities.
   * @param  graph
   */
  _setCurrentGraph(graph) {
    if (graph === this._current) return;

    // gather changes needed
    const changeHint = graph.changeHint(this._current);
    const diff = new Difference(this._current, graph, changeHint);
    this._current = graph;

    const changed = diff.didChange;
    if (!changed.addition && !changed.deletion && !changed.geometry) return;

    const toUpdate = new Map();

    if (changed.deletion) {
      for (const entity of diff.deleted()) {
        this._removeEntity(entity.id);
      }
    }

    if (changed.geometry) {
      const seen = new Set();
      for (const entity of diff.modifiedGeometry()) {
        this._removeEntity(entity.id);
        toUpdate.set(entity.id, entity);
        this._includeParents(entity, toUpdate, seen);
      }
    }

    if (changed.addition) {
      for (const entity of diff.created()) {
        toUpdate.set(entity.id, entity);
      }
    }

    this._loadEntities(toUpdate);
  }


  /**
   * rebase
   * This is used to load new Entities into the tree, but without adjusting which Graph is current.
   * It's called when fetching new data from the OSM API, restoring saved history, etc.
   * @param  entities   Array of Entities
   * @param  force?     If `true`, replace an Entity, even if we've seen it already
   */
  rebase(entities, force) {
    const graph = this._current;
    const local = graph.local;
    const toUpdate = new Map();

    for (const entity of entities) {
      if (!entity.visible) continue;

      const entityID = entity.id;

      // Entity is deleted in current graph, leave it out of the tree..
      const isDeleted = local.entities.has(entityID) && (local.entities.get(entityID) === undefined);
      if (isDeleted) continue;

      // Entity is already in the tree, skip (unless force = true)
      if (this._entityBoxes.has(entityID) && !force) continue;

      // Add or Replace the Entity
      this._removeEntity(entityID);
      toUpdate.set(entityID, entity);
      this._includeParents(entity, toUpdate);
    }

    this._loadEntities(toUpdate);
  }


  /**
   * intersects
   * Returns a result of Entities that intersect the given map extent.
   * We first update the current graph if needed, to make sure the results are fresh.
   * @param  extent   Extent to check
   * @param  graph    The current graph
   * @return Array of entities with bounding boxes overlapping `extent` for the given `graph`
   */
  intersects(extent, graph) {
    this._setCurrentGraph(graph);
    const bbox = this._queryBox;
    bbox.minX = extent.min[0];
    bbox.minY = extent.min[1];
    bbox.maxX = extent.max[0];
    bbox.maxY = extent.max[1];

    const boxes = this._entityRBush.search(bbox);
    const entities = new Array(boxes.length);
    for (let i = 0; i < boxes.length; i++) {
      entities[i] = graph.entity(boxes[i].id);
    }
    return entities;
  }

  /**
   * waySegments
   * Returns the result of Segments that intersect the given map extent.
   * We first update the current graph if needed, to make sure the results are fresh.
   * @param  extent   Extent to check
   * @param  graph    The current graph
   * @return Array of segment objects with bounding boxes overlapping `extent` for the given `graph`
   */
  waySegments(extent, graph) {
    this._setCurrentGraph(graph);
    const bbox = this._queryBox;
    bbox.minX = extent.min[0];
    bbox.minY = extent.min[1];
    bbox.maxX = extent.max[0];
    bbox.maxY = extent.max[1];

    const boxes = this._segmentRBush.search(bbox);
    const segments = new Array(boxes.length);
    for (let i = 0; i < boxes.length; i++) {
      segments[i] = boxes[i].segment;
    }
    return segments;
  }

}
