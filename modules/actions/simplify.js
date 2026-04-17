import { geoOrthoNormalizedDotProduct } from '../geo/index.js';
import { actionDeleteNode } from './delete_node.js';
import { geoSphericalDistance } from '@rapid-sdk/math';


export function actionSimplify(wayID, viewport, degThresh) {
    var threshold = degThresh || 5;   // degrees within straight to simplify
    var thresholdCos = Math.cos(threshold * Math.PI / 180);
    var thresholdFarCos = Math.cos(2 * Math.PI / 180);

    function shouldKeepNode(node, graph) {
        return graph.parentWays(node).length > 1 ||
            graph.parentRelations(node).length ||
            node.hasInterestingTags();
    }


    function isNearlyStraight(prevNode, nextNode, prevPoint, point, nextPoint) {
        var dist = geoSphericalDistance(prevNode.loc, nextNode.loc);
        var currentUpperThreshold = dist > 20 ? thresholdFarCos : thresholdCos;

        var dotp = Math.abs(geoOrthoNormalizedDotProduct(prevPoint, nextPoint, point));
        return dotp > currentUpperThreshold;
    }


    function collectDeleteIDs(graph) {
        var way = graph.hasEntity(wayID);
        if (!way || way.type !== 'way') return [];

        var nodes = graph.childNodes(way);
        if (!nodes.length) return [];

        var isClosed = way.isClosed();
        if (isClosed) {
            nodes = nodes.slice(0, -1);   // treat closed ways as a ring without duplicate endpoint
        }

        var minNodes = isClosed ? 3 : 2;
        if (nodes.length <= minNodes) return [];

        var nodeCount = new Map();
        var points = new Array(nodes.length);
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            nodeCount.set(node.id, (nodeCount.get(node.id) || 0) + 1);
            points[i] = viewport.project(node.loc);
        }

        var toDelete = [];
        for (i = 0; i < nodes.length; i++) {
            node = nodes[i];

            if (!isClosed && (i === 0 || i === nodes.length - 1)) continue;  // keep line endpoints
            if (shouldKeepNode(node, graph)) continue;                        // keep important/shared nodes
            if ((nodeCount.get(node.id) || 0) > 1) continue;                 // keep self-intersection nodes

            var prevIdx = (i - 1 + nodes.length) % nodes.length;
            var nextIdx = (i + 1) % nodes.length;
            var prevNode = nodes[prevIdx];
            var nextNode = nodes[nextIdx];
            if (!prevNode || !nextNode || prevNode.id === nextNode.id) continue;

            if (isNearlyStraight(prevNode, nextNode, points[prevIdx], points[i], points[nextIdx])) {
                toDelete.push(node.id);
            }
        }

        var maxDelete = Math.max(0, nodes.length - minNodes);
        if (toDelete.length > maxDelete) {
            toDelete = toDelete.slice(0, maxDelete);
        }

        return toDelete;
    }


    var action = function(graph) {
        var toDelete = collectDeleteIDs(graph);
        for (var i = 0; i < toDelete.length; i++) {
            var nodeID = toDelete[i];
            if (!graph.hasEntity(nodeID)) continue;
            graph = actionDeleteNode(nodeID)(graph);
        }
        return graph;
    };


    action.disabled = function(graph) {
        return collectDeleteIDs(graph).length ? false : 'nothing_to_simplify';
    };


    return action;
}
