import { vecInterp } from '@rapid-sdk/math';

export function actionMoveNode(nodeID, toLoc) {

    var action = function(graph, t) {
        if (t === null || !isFinite(t)) t = 1;
        t = Math.min(Math.max(+t, 0), 1);
        if (t === 0) return graph;

        var node = graph.entity(nodeID);
        var fromLoc = node.loc;
        var loc = (t === 1) ? toLoc : vecInterp(fromLoc, toLoc, t);

        if (fromLoc[0] === loc[0] && fromLoc[1] === loc[1]) return graph;

        return graph.replace(node.move(loc));
    };

    action.transitionable = true;

    return action;
}
