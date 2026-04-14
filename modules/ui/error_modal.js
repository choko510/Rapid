import { select as d3_select } from 'd3-selection';

import { uiConfirm } from './confirm.js';


export function uiErrorModal(context) {
  let _modal = d3_select(null);
  let _title = '';
  let _subtitle = '';

  /** @param {d3.Selection} selection */
  const errorModal = selection => {
    _modal = uiConfirm(context, selection).okButton();

    _modal.select('.modal-section.header').append('h3').html(_title);
    _modal.select('.modal-section.message-text').html(_subtitle);
    _modal.select('button.close').classed('hide', true);

    return errorModal;
  };

  /** @param {string} val */
  errorModal.setTitle = val => {
    _title = val;
    return errorModal;
  };

  /** @param {string} val */
  errorModal.setSubtitle = val => {
    _subtitle = val;
    return errorModal;
  };

  errorModal.close = () => _modal.remove();

  return errorModal;
}
