import { utilGetAllNodes } from '@rapid-sdk/util';

import { actionDivide } from '../actions/divide.js';
import { KeyOperationBehavior } from '../behaviors/KeyOperationBehavior.js';
import { uiConfirm } from '../ui/confirm.js';
import { operationIsTooLarge } from './helpers/large_edit.js';
import { utilNoAuto, utilTotalExtent } from '../util/index.js';

const DIVIDE_LIMIT = 200;


export function operationDivide(context, selectedIDs) {
  const editor = context.systems.editor;
  const graph = editor.staging.graph;
  const l10n = context.systems.l10n;

  const entity = selectedIDs.length === 1 ? graph.hasEntity(selectedIDs[0]) : null;
  const isNew = entity?.isNew?.() ?? false;
  const extent = entity ? utilTotalExtent([entity], graph) : null;
  const coords = utilGetAllNodes(selectedIDs, graph).map(node => node.loc);
  const divideAction = (entity?.type === 'way') ? actionDivide(entity.id, context.viewport) : null;

  let operation = function() {
    if (!divideAction) return;

    const modal = uiConfirm(context, context.container()).okButton();
    modal.select('.modal-section.header')
      .append('h3')
      .text(l10n.t('operations.divide.title'));

    const textSection = modal.select('.modal-section.message-text');
    const buttonSection = modal.select('.modal-section.buttons');
    const okButton = buttonSection.select('.ok-button');

    buttonSection
      .insert('button', '.ok-button')
      .attr('class', 'button cancel-button secondary-action')
      .html(l10n.tHtml('confirm.cancel'));

    const form = textSection
      .append('form')
      .attr('class', 'divide-modal')
      .on('submit', (d3_event) => {
        d3_event.preventDefault();
        _clickSave();
      });

    const inputLong = form
      .append('input')
      .attr('type', 'number')
      .attr('step', '1')
      .attr('min', '1')
      .attr('value', 1)
      .call(utilNoAuto);

    form.append('span').text('×');

    const inputShort = form
      .append('input')
      .attr('type', 'number')
      .attr('step', '1')
      .attr('min', '1')
      .attr('value', 1)
      .call(utilNoAuto);

    const error = textSection
      .append('div')
      .attr('class', 'issue-warning divide-modal-error');

    function _sanitize(input) {
      const val = Number.parseInt(input.property('value'), 10);
      return Number.isFinite(val) && val > 0 ? val : 1;
    }

    function _isValid(shortCount, longCount) {
      if ((shortCount * longCount) > DIVIDE_LIMIT) {
        error.text(l10n.t('operations.divide.error.too_big', { limit: DIVIDE_LIMIT }));
        return false;
      }
      error.text('');
      return true;
    }

    function _syncValidity() {
      const shortCount = _sanitize(inputShort);
      const longCount = _sanitize(inputLong);
      okButton.property('disabled', !_isValid(shortCount, longCount));
    }

    function _clickSave() {
      const shortCount = _sanitize(inputShort);
      const longCount = _sanitize(inputLong);
      if (!_isValid(shortCount, longCount)) return;

      modal.close();
      if (shortCount === 1 && longCount === 1) return;

      const annotation = operation.annotation();
      editor.beginTransaction();
      editor.perform(divideAction(shortCount, longCount));

      const postGraph = editor.staging.graph;
      const createdWayIDs = divideAction.getCreatedWayIDs()
        .filter(entityID => postGraph.hasEntity(entityID));
      const nextSelection = createdWayIDs.length ? createdWayIDs : selectedIDs;

      editor.commit({ annotation: annotation, selectedIDs: nextSelection });
      editor.endTransaction();
      context.enter('select-osm', { selection: { osm: nextSelection } });
    }

    buttonSection.select('.cancel-button')
      .on('click.cancel', () => modal.close());

    buttonSection.select('.ok-button')
      .on('click.save', _clickSave);

    inputLong.on('input', _syncValidity);
    inputShort.on('input', _syncValidity);
    inputLong.node()?.focus();
    inputLong.node()?.select();
    _syncValidity();
  };


  operation.available = function() {
    return !!divideAction && selectedIDs.length === 1;
  };


  // don't cache this because visible extent/data can change
  operation.disabled = function() {
    if (!divideAction) return '';

    const graph = editor.staging.graph;
    const disabledReason = divideAction.disabled(graph);
    if (disabledReason) {
      return disabledReason;
    } else if (!isNew && operationIsTooLarge(context, extent)) {
      return 'too_large';
    } else if (!isNew && notDownloaded()) {
      return 'not_downloaded';
    } else if (selectedIDs.some(context.hasHiddenConnections)) {
      return 'connected_to_hidden';
    }

    return false;

    function notDownloaded() {
      if (context.inIntro) return false;
      const osm = context.services.osm;
      if (osm) {
        const missing = coords.filter(loc => !osm.isDataLoaded(loc));
        if (missing.length) {
          missing.forEach(loc => context.loadTileAtLoc(loc));
          return true;
        }
      }
      return false;
    }
  };


  operation.tooltip = function() {
    const disabledReason = operation.disabled();
    return disabledReason ?
      l10n.t(`operations.divide.disabled.${disabledReason}`) :
      l10n.t('operations.divide.tooltip');
  };


  operation.annotation = function() {
    return l10n.t('operations.divide.annotation');
  };


  operation.id = 'divide';
  operation.keys = [ l10n.t('shortcuts.command.divide.key') ];
  operation.title = l10n.t('operations.divide.title');
  operation.behavior = new KeyOperationBehavior(context, operation);

  return operation;
}
