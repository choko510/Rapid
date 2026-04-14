import { actionChangeTags } from '../actions/change_tags.js';
import { ValidationIssue, ValidationFix } from '../core/lib/index.js';


export function validationOneLaneWithNoOneway(context) {
  const type = 'oneway_onelane';
  const editor = context.systems.editor;
  const l10n = context.systems.l10n;

  function makeOnewayFix(onewayValue) {
    return new ValidationFix({
      icon: 'rapid-icon-way',
      title: l10n.t(`issues.fix.tag_as_oneway_${onewayValue}.title`),
      onClick: function() {
        const entityID = this.issue.entityIds[0];
        const graph = editor.staging.graph;
        const current = graph.entity(entityID);
        const tags = { ...current.tags, oneway: onewayValue };
        editor.perform(actionChangeTags(entityID, tags));
        editor.commit({
          annotation: l10n.t(`issues.fix.tag_as_oneway_${onewayValue}.annotation`),
          selectedIDs: [entityID]
        });
      }
    });
  }

  function makeNoMarkingsFix() {
    return new ValidationFix({
      icon: 'rapid-icon-way',
      title: l10n.t('issues.fix.tag_as_oneway_no_markings.title'),
      onClick: function() {
        const entityID = this.issue.entityIds[0];
        const graph = editor.staging.graph;
        const current = graph.entity(entityID);
        const tags = { ...current.tags, 'lane_markings': 'no' };
        delete tags.lanes;
        editor.perform(actionChangeTags(entityID, tags));
        editor.commit({
          annotation: l10n.t('issues.fix.tag_as_oneway_no_markings.annotation'),
          selectedIDs: [entityID]
        });
      }
    });
  }

  function makeIssue(entity) {
    return new ValidationIssue(context, {
      type: type,
      subtype: type,
      severity: 'warning',
      message: function() {
        const graph = editor.staging.graph;
        const current = graph.hasEntity(this.entityIds[0]);
        return current ? l10n.t('issues.oneway_onelane.message', {
          feature: l10n.displayLabel(current, graph)
        }) : '';
      },
      reference: function(selection) {
        selection.selectAll('.issue-reference')
          .data([0])
          .enter()
          .append('div')
          .attr('class', 'issue-reference')
          .text(l10n.t('issues.oneway_onelane.reference'));
      },
      entityIds: [entity.id],
      hash: type,
      dynamicFixes: function() {
        return [
          makeOnewayFix('yes'),
          makeOnewayFix('alternating'),
          makeOnewayFix('reversible'),
          new ValidationFix({
            title: l10n.t('issues.fix.change_lane_tag.title')
          }),
          makeNoMarkingsFix()
        ];
      }
    });
  }


  let validation = function checkOneLaneWithNoOneway(entity) {
    if (entity.type !== 'way') return [];

    const lanes = entity.tags.lanes;
    if (lanes !== '1') return [];

    if (entity.tags.oneway !== 'no' && entity.tags.oneway !== '0') return [];
    if (entity.tags.leisure === 'slipway') return [];

    return [makeIssue(entity)];
  };

  validation.type = type;

  return validation;
}
