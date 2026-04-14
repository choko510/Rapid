import { dispatch as d3_dispatch } from 'd3-dispatch';
import { marked } from 'marked';

import { uiConfirm } from '../confirm.js';
import { utilNoAuto, utilRebind } from '../../util/index.js';


export function uiSettingsCustomFeatures(context) {
  const l10n = context.systems.l10n;
  const filters = context.systems.filters;
  const dispatch = d3_dispatch('change');

  function render(selection) {
    const template = filters.customFilterTemplate || '';

    const modal = uiConfirm(context, selection).okButton();
    modal
      .classed('settings-modal settings-custom_features', true);

    modal.select('.modal-section.header')
      .append('h3')
      .html(l10n.tHtml('settings.custom_features.header'));

    const textSection = modal.select('.modal-section.message-text');

    const instructions = marked.parse(`
${l10n.t('settings.custom_features.instructions.info')}
<code>building=yes</code>

${l10n.t('settings.custom_features.instructions.additional_info')}
`);

    textSection
      .append('div')
      .attr('class', 'instructions-template')
      .html(instructions);

    textSection
      .append('input')
      .attr('type', 'text')
      .attr('class', 'field-template')
      .attr('placeholder', l10n.t('settings.custom_features.template.placeholder'))
      .call(utilNoAuto)
      .property('value', template);

    const buttonSection = modal.select('.modal-section.buttons');
    buttonSection
      .insert('button', '.ok-button')
      .attr('class', 'button cancel-button secondary-action')
      .html(l10n.tHtml('confirm.cancel'));

    buttonSection.select('.cancel-button')
      .on('click.cancel', function() {
        this.blur();
        modal.close();
      });

    buttonSection.select('.ok-button')
      .on('click.save', function() {
        const nextTemplate = textSection.select('.field-template').property('value').trim();
        this.blur();
        modal.close();
        dispatch.call('change', this, { template: nextTemplate });
      });
  }

  return utilRebind(render, dispatch, 'on');
}
