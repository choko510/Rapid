/**
 * @param {string} entityID
 * @param {string[]} newNodeIDs
 */
export function actionReplaceWayNodes(entityID, newNodeIDs) {
  /** @param {iD.Graph} graph */
  return graph => {
    let entity = graph.entity(entityID);
    entity = entity.update({ nodes: newNodeIDs });
    return graph.replace(entity);
  };
}
