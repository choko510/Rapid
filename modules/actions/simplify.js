import { geoOrthoNormalizedDotProduct } from '../geo/index.js';
import { actionDeleteNode } from './delete_node.js';


export function actionSimplify(wayID, viewport, degThresh) {
    var threshold = degThresh || 5;   // degrees within straight to simplify
    var upperThreshold = Math.cos(threshold * Math.PI / 180);


    function shouldKeepNode(node, graph) {
        return graph.parentWays(node).length > 1 ||
            graph.parentRelations(node).length ||
            node.hasInterestingTags();
    }


    function isNearlyStraight(prevNode, node, nextNode) {
        var prevPoint = viewport.project(prevNode.loc);
        var point = viewport.project(node.loc);
        var nextPoint = viewport.project(nextNode.loc);

        var dotp = Math.abs(geoOrthoNormalizedDotProduct(prevPoint, nextPoint, point));
        return dotp > upperThreshold;
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
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            nodeCount.set(node.id, (nodeCount.get(node.id) || 0) + 1);
        }

        var toDelete = [];
        for (i = 0; i < nodes.length; i++) {
            node = nodes[i];

            if (!isClosed && (i === 0 || i === nodes.length - 1)) continue;  // keep line endpoints
            if (shouldKeepNode(node, graph)) continue;                        // keep important/shared nodes
            if ((nodeCount.get(node.id) || 0) > 1) continue;                 // keep self-intersection nodes

            var prevNode = nodes[(i - 1 + nodes.length) % nodes.length];
            var nextNode = nodes[(i + 1) % nodes.length];
            if (!prevNode || !nextNode || prevNode.id === nextNode.id) continue;

            if (isNearlyStraight(prevNode, node, nextNode)) {
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
