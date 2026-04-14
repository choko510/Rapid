import { uiIcon } from '../icon.js';
import { uiLoading } from '../loading.js';
import { uiTooltip } from '../tooltip.js';
import { uiErrorModal } from '../error_modal.js';
import { operationImportFile } from '../../operations/import_file.js';


/**
 * @param {iD.Context} context
 */
export function uiSectionImportFile(context) {
  const l10n = context.systems.l10n;

  const loading = uiLoading(context)
    .message(l10n.t('operations.import_from_file.loading'))
    .blocking(true);

  const errorModal = uiErrorModal(context);

  const tooltip = uiTooltip(context)
    .title(() => l10n.t('operations.import_from_file.tooltip'))
    .placement(() => (l10n.isRTL() ? 'left' : 'right'));


  /**
   * @param {PointerEvent} event
   */
  async function onClickImport(event) {
    const allowConflicts = !!(event.ctrlKey || event.metaKey);

    try {
      await operationImportFile(context, allowConflicts, () => {
        context.container().call(loading);
      });
    } catch (err) {
      console.error(err);  // eslint-disable-line no-console

      const errorText = (err instanceof Error ? err.message : `${err}`);
      const subtitle = errorText.includes('Conflicts')
        ? l10n.tHtml('operations.import_from_file.error.conflicts')
        : l10n.tHtml('operations.import_from_file.error.unknown');

      context.container().call(
        errorModal
          .setTitle(l10n.tHtml('operations.import_from_file.error.title'))
          .setSubtitle(subtitle)
      );
    } finally {
      loading.close();
    }
  }


  /** @param {d3.Selection} selection */
  return selection => {
    let importWrap = selection.selectAll('.layer-list-import')
      .data([0]);

    const importWrapEnter = importWrap.enter()
      .append('div')
      .attr('class', 'layer-list-import');

    const buttonEnter = importWrapEnter
      .append('button')
      .attr('class', 'button-link');

    buttonEnter
      .call(uiIcon('#rapid-icon-load', 'inline'))
      .append('span');

    importWrap = importWrap.merge(importWrapEnter);

    const button = importWrap.selectAll('button')
      .call(tooltip)
      .on('click', onClickImport);

    button.selectAll('span')
      .text(l10n.t('operations.import_from_file.title'));
  };
}
