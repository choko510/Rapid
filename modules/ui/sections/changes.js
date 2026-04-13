import { select as d3_select } from 'd3-selection';

import { JXON } from '../../util/jxon.js';
import { actionDiscardTags } from '../../actions/discard_tags.js';
import { osmChangeset } from '../../osm/index.js';
import { uiIcon } from '../icon.js';
import { uiSection } from '../section.js';


export function uiSectionChanges(context) {
  const assets = context.systems.assets;
  const editor = context.systems.editor;
  const l10n = context.systems.l10n;

  let _discardTags = {};
  let _downloadDiff = null;
  let _downloadURL = null;
  assets.loadAssetAsync('tagging_discarded')
    .then(d => _discardTags = d)
    .catch(() => { /* ignore */ });

  let section = uiSection(context, 'changes-list')
    .label(() => {
      const summary = editor.difference().summary();
      return l10n.t('inspector.title_count', { title: l10n.t('commit.changes'), count: summary.size });
    })
    .disclosureContent(renderDisclosureContent);


  function renderDisclosureContent(selection) {
    const difference = editor.difference();
    const summary = [...difference.summary().values()];

    let container = selection.selectAll('.commit-section')
      .data([0]);

    let containerEnter = container.enter()
      .append('div')
      .attr('class', 'commit-section');

    containerEnter
      .append('ul')
      .attr('class', 'changeset-list');

    container = containerEnter
      .merge(container);


    let items = container.select('ul').selectAll('li')
      .data(summary);

    let itemsEnter = items.enter()
      .append('li')
      .attr('class', 'change-item');

    let buttons = itemsEnter
      .append('button')
      .on('mouseover', mouseover)
      .on('mouseout', mouseout)
      .on('click', click);

    buttons
      .each((d, i, nodes) => {
        const geom = d.entity.geometry(d.graph);
        d3_select(nodes[i])
          .call(uiIcon(`#rapid-icon-${geom}`, `pre-text ${d.changeType}`));
      });

    buttons
      .append('span')
      .attr('class', 'change-type')
      .text(d => l10n.t(`commit.${d.changeType}`) + ' ');

    buttons
      .append('strong')
      .attr('class', 'entity-type')
      .text(d => {
        const matched = context.systems.presets.match(d.entity, d.graph);
        return (matched && matched.name()) || l10n.displayType(d.entity.id);
      });

    buttons
      .append('span')
      .attr('class', 'entity-name')
      .text(d => {
        const name = l10n.displayName(d.entity.tags);
        let string = '';
        if (name !== '') {
          string += ':';
        }
        return string += ' ' + name;
      });

    items = itemsEnter
      .merge(items);


    // Download changeset link
    const fileName = 'changes.osc';
    if (_downloadDiff !== difference) {
      let changeset = new osmChangeset().update({ id: undefined });
      const changes = editor.changes(actionDiscardTags(difference, _discardTags));
      delete changeset.id;  // Export without changeset_id

      const data = JXON.stringify(changeset.osmChangeJXON(changes));
      const blob = new Blob([data], { type: 'text/xml;charset=utf-8;' });
      if (_downloadURL) {
        window.URL.revokeObjectURL(_downloadURL);
      }
      _downloadURL = window.URL.createObjectURL(blob);
      _downloadDiff = difference;
    }

    let link = container.selectAll('.download-changes')
      .data([0]);

    let linkEnter = link.enter()
      .append('a')
      .attr('class', 'download-changes');

    linkEnter
      .call(uiIcon('#rapid-icon-load', 'inline'))
      .append('span');

    link = linkEnter.merge(link);

    link
      .attr('href', _downloadURL)  // download the data as a file
      .attr('download', fileName);

    link.selectAll('span')
      .text(l10n.t('commit.download_changes'));


    function mouseover(d) {
// todo replace legacy surface css class .hover
//      if (d.entity) {
//        context.surface().selectAll(
//          utilEntityOrMemberSelector([d.entity.id], editor.staging.graph)
//        ).classed('hover', true);
//      }
    }

    function mouseout() {
//      context.surface().selectAll('.hover')
//        .classed('hover', false);
    }

    function click(d3_event, change) {
      if (change.changeType !== 'deleted') {
        let entity = change.entity;
        context.systems.map.fitEntitiesEase(entity);
//        context.surface().selectAll(utilEntityOrMemberSelector([entity.id], editor.staging.graph))
//          .classed('hover', true);
      }
    }
  }

  return section;
}
