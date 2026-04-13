import { uiModal } from './modal.js';


export function uiRestore(context) {
  const editor = context.systems.editor;
  const l10n = context.systems.l10n;

  return function(selection) {
    if (!editor.canRestoreBackup) return;
    const snapshots = editor.getBackupSnapshots();

    let modalSelection = uiModal(selection, true);

    modalSelection.select('.modal')
      .attr('class', 'modal fillL');

    let introModal = modalSelection.select('.content');

    introModal
      .append('div')
      .attr('class', 'modal-section')
      .append('h3')
      .text(l10n.t('restore.heading'));

    introModal
      .append('div')
      .attr('class','modal-section')
      .append('p')
      .text(l10n.t('restore.description'));

    let buttonWrap = introModal
      .append('div')
      .attr('class', 'modal-actions');

    let restore = buttonWrap
      .append('button')
      .attr('class', 'restore')
      .on('click', () => {
        editor.restoreBackup();
        modalSelection.remove();
      });

    restore
      .append('svg')
      .attr('class', 'logo logo-restore')
      .append('use')
      .attr('xlink:href', '#rapid-logo-restore');

    restore
      .append('div')
      .text(l10n.t('restore.restore'));

    let reset = buttonWrap
      .append('button')
      .attr('class', 'reset')
      .on('click', () => {
        editor.clearBackup();
        modalSelection.remove();
      });

    reset
      .append('svg')
      .attr('class', 'logo logo-reset')
      .append('use')
      .attr('xlink:href', '#rapid-logo-reset');

    reset
      .append('div')
      .text(l10n.t('restore.reset'));

    if (snapshots.length) {
      const snapshotSection = introModal
        .append('div')
        .attr('class', 'modal-section restore-snapshots');

      snapshotSection
        .append('h4')
        .text(l10n.t('restore.snapshot.title', { default: 'Recent snapshots' }));

      const snapshotButtons = snapshotSection.selectAll('.restore-snapshot-item')
        .data(snapshots)
        .enter()
        .append('button')
        .attr('class', 'restore-snapshot-item')
        .on('click', (d3_event, d) => {
          d3_event.preventDefault();
          editor.restoreBackup(d.key);
          modalSelection.remove();
        });

      snapshotButtons
        .append('div')
        .attr('class', 'restore-snapshot-time')
        .text(d => (new Date(d.timestamp)).toLocaleString(l10n.localeCode()));

      snapshotButtons
        .append('div')
        .attr('class', 'restore-snapshot-count')
        .text(d => {
          const count = Number.isFinite(d.changeCount) ? d.changeCount : 0;
          return l10n.t('restore.snapshot.changes', {
            default: `${count} changes`,
            n: count
          });
        });
    }

    restore.node().focus();
  };
}
