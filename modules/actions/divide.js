import { geomLineIntersection, vecInterp, vecLength } from '@rapid-sdk/math';
import { utilArrayUniq, utilArrayUniqBy } from '@rapid-sdk/util';

import { osmNode } from '../osm/node.js';
import { osmWay } from '../osm/way.js';


function coordKey(point) {
  return `${point[0].toFixed(8)},${point[1].toFixed(8)}`;
}


/**
 * Divide a 4-corner shape into a rows x cols grid.
 * @param   {number}  shortCount
 * @param   {number}  longCount
 * @param   {Array}   points
 * @returns {Object}
 */
export function divideRectangle(shortCount, longCount, points) {
  const cache = new Map();
  const cached = point => {
    const key = coordKey(point);
    if (!cache.has(key)) {
      cache.set(key, [point[0], point[1]]);
    }
    return cache.get(key);
  };

  const [A, B, C, D] = points.map(cached);

  const avgColsLength = (vecLength(A, B) + vecLength(D, C)) / 2;
  const avgRowsLength = (vecLength(A, D) + vecLength(B, C)) / 2;
  const cols = avgColsLength >= avgRowsLength ? longCount : shortCount;
  const rows = avgColsLength >= avgRowsLength ? shortCount : longCount;

  const top = new Array(cols + 1).fill(0).map((_, i) => cached(vecInterp(A, B, i / cols)));
  const bottom = new Array(cols + 1).fill(0).map((_, i) => cached(vecInterp(D, C, i / cols)));
  const left = new Array(rows + 1).fill(0).map((_, i) => cached(vecInterp(A, D, i / rows)));
  const right = new Array(rows + 1).fill(0).map((_, i) => cached(vecInterp(B, C, i / rows)));

  const newShapes = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const W = cached(vecInterp(left[row], right[row], col / cols));
      const X = cached(vecInterp(left[row], right[row], (col + 1) / cols));
      const Y = cached(vecInterp(left[row + 1], right[row + 1], (col + 1) / cols));
      const Z = cached(vecInterp(left[row + 1], right[row + 1], col / cols));
      newShapes.push([W, X, Y, Z]);
    }
  }

  const hasSelfIntersections = newShapes.some(([W, X, Y, Z]) => {
    return (
      geomLineIntersection([W, X], [Y, Z]) ||
      geomLineIntersection([X, Y], [Z, W])
    );
  });

  const outerRing = [
    ...top.slice(0, -1),
    ...right.slice(0, -1),
    ...bottom.slice().reverse().slice(0, -1),
    ...left.slice().reverse().slice(0, -1)
  ];

  return {
    isValid: !hasSelfIntersections,
    newShapes: newShapes,
    outerRing: outerRing
  };
}


/**
 * Divide operation action factory.
 * @param   {string}  wayID
 * @param   {Object}  viewport
 * @returns {Function}
 */
export function actionDivide(wayID, viewport) {
  let _createdWayIDs = [];

  const action = (shortCount, longCount) => (graph) => {
    _createdWayIDs = [];

    const originalWay = graph.entity(wayID);
    const originalNodes = utilArrayUniq(graph.childNodes(originalWay));
    const points = originalNodes.map(node => viewport.project(node.loc));

    const result = divideRectangle(shortCount, longCount, points);
    if (!result.isValid) return graph;

    const coordToNode = new Map();
    for (let i = 0; i < points.length; i++) {
      coordToNode.set(coordKey(points[i]), originalNodes[i]);
    }

    const newWayIDs = new Set();
    for (let i = 0; i < result.newShapes.length; i++) {
      const shape = result.newShapes[i];
      const nodeIDs = [];

      for (const coord of shape) {
        const key = coordKey(coord);
        let node = coordToNode.get(key);
        if (!node) {
          node = osmNode({ loc: viewport.unproject(coord) });
          graph = graph.replace(node);
          coordToNode.set(key, node);
        }
        nodeIDs.push(node.id);
      }
      nodeIDs.push(nodeIDs[0]);   // close way

      const splitWay = osmWay({
        id: (i === 0 ? originalWay.id : undefined),
        version: (i === 0 ? originalWay.version : undefined),
        nodes: nodeIDs,
        tags: originalWay.tags
      });

      graph = graph.replace(splitWay);
      newWayIDs.add(splitWay.id);
      _createdWayIDs.push(splitWay.id);
    }

    const outer = result.outerRing
      .map(coord => coordToNode.get(coordKey(coord))?.id)
      .filter(Boolean);

    const neighbours = utilArrayUniqBy(
      originalNodes
        .flatMap(node => graph.parentWays(node))
        .filter(way => !newWayIDs.has(way.id)),
      'id'
    );

    const edgeCount = originalNodes.length;
    for (let i = 0; i < neighbours.length; i++) {
      let neighbour = neighbours[i];
      for (let j = 0; j < edgeCount; j++) {
        const a = originalNodes[j].id;
        const b = originalNodes[(j + 1) % edgeCount].id;
        neighbour = replaceNeighbourEdge(neighbour, a, b, outer);
      }
      graph = graph.replace(neighbour);
    }

    return graph;
  };

  action.getCreatedWayIDs = function() {
    return _createdWayIDs;
  };

  action.disabled = function(graph) {
    const way = graph.entity(wayID);
    const nodes = utilArrayUniq(graph.childNodes(way));

    if (!way.isClosed() || way.geometry(graph) !== 'area') return 'not_closed';
    if (nodes.length > 4) return 'more_than_four_nodes';
    if (nodes.length < 4) return 'less_than_four_nodes';

    return false;
  };

  action.transitionable = true;

  return action;
}


function replaceNeighbourEdge(way, a, b, outer) {
  const aIndex = outer.indexOf(a);
  const bIndex = outer.indexOf(b);
  if (aIndex === -1 || bIndex === -1) return way;

  const edge = aIndex < bIndex ?
    outer.slice(aIndex, bIndex) :
    [...outer.slice(aIndex), ...outer.slice(0, bIndex)];
  if (!edge.length) return way;

  let changed = false;
  const nodes = [...way.nodes];

  for (let i = 0; i < nodes.length; i++) {
    const curr = nodes[i];
    const prev = nodes[i - 1];
    const next = nodes[i + 1];

    if (curr === a && next === b) {
      nodes.splice(i, 1, ...edge);
      i += edge.length - 1;
      changed = true;
    } else if (curr === a && prev === b) {
      const reversed = [...edge].reverse();
      nodes.splice(i, 1, ...reversed);
      i += reversed.length - 1;
      changed = true;
    }
  }

  return changed ? way.update({ nodes: nodes }) : way;
}
