/**
 * @param {string} entityID
 * @param {{ id: string; type: string; role: string }[]} newMembers
 */
export function actionReplaceRelationMembers(entityID, newMembers) {
  /** @param {iD.Graph} graph */
  return graph => {
    let entity = graph.entity(entityID);
    entity = entity.update({ members: newMembers });
    return graph.replace(entity);
  };
}
