import { dispatch as d3_dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';
import { utilArrayUniqBy } from '@rapid-sdk/util';

import { uiIcon } from './icon.js';
import { uiCombobox} from './combobox.js';
import { UiField } from './UiField.js';
import { uiFormFields } from './form_fields.js';
import { utilRebind, utilTriggerEvent } from '../util/index.js';
import { getIncompatibleSources } from '../validations/incompatible_source.js';


export function uiChangesetEditor(context) {
    const l10n = context.systems.l10n;
    const dispatch = d3_dispatch('change');

    var formFields = uiFormFields(context);
    var commentCombo = uiCombobox(context, 'comment').caseSensitive(true);
    var _uifields;
    var _tags;
    var _changesetID;


    function changesetEditor(selection) {
        render(selection);
    }


    function render(selection) {
        var initial = false;

        if (!_uifields) {
            initial = true;
            var presetSysetem = context.systems.presets;

            _uifields = [
                new UiField(context, presetSysetem.field('comment'), null, { show: true, revert: false }),
                new UiField(context, presetSysetem.field('source'), null, { show: false, revert: false }),
                new UiField(context, presetSysetem.field('hashtags'), null, { show: false, revert: false }),
            ];

            _uifields.forEach(function(field) {
                field
                    .on('change', function(t, onInput) {
                        dispatch.call('change', field, undefined, t, onInput);
                    });
            });
        }

        _uifields.forEach(function(field) {
            field
                .tags(_tags);
        });


        selection
            .call(formFields.fieldsArr(_uifields));


        if (initial) {
            var commentField = selection.select('.form-field-comment textarea');
            var commentNode = commentField.node();

            if (commentNode) {
                commentNode.focus();
                commentNode.select();
            }

            // trigger a 'blur' event so that comment field can be cleaned
            // and checked for hashtags, even if retrieved from localstorage
            utilTriggerEvent(commentField, 'blur');

            var osm = context.services.osm;
            if (osm) {
                osm.userChangesets(function (err, changesets) {
                    if (err) return;

                    var comments = changesets.map(function(changeset) {
                        var comment = changeset.tags.comment;
                        return comment ? { title: comment, value: comment } : null;
                    }).filter(Boolean);

                    commentField
                        .call(commentCombo
                            .data(utilArrayUniqBy(comments, 'title'))
                        );
                });
            }
        }

        renderWarnings(
            findIncompatibleSources(_tags.comment, 'comment'),
            selection.select('.form-field-comment'),
            'comment-warning'
        );

        renderWarnings(
            findIncompatibleSources(_tags.source, 'source'),
            selection.select('.form-field-source'),
            'source-warning'
        );

        function findIncompatibleSources(str, which) {
            return getIncompatibleSources(str).map(rule => {
                const match = rule.regex.exec(str);
                const value = match?.[1] || match?.[0] || '';
                return {
                    id: `incompatible_source.${which}.${rule.id}.${value.toLowerCase()}`,
                    msg: (selection) => {
                        selection
                            .append('span')
                            .text(l10n.t(`commit.changeset_incompatible_source.${which}`, { value: value }));

                        selection
                            .append('br');

                        selection
                            .append('a')
                            .attr('target', '_blank')
                            .attr('href', l10n.t('commit.changeset_incompatible_source.link'))
                            .text(l10n.t(`issues.incompatible_source.reference.${rule.id}`));
                    }
                };
            });
        }

        function renderWarnings(warnings, $selection, klass) {
            var entries = $selection.selectAll('.' + klass)
                .data(warnings, d => d.id);

            entries.exit()
                .transition()
                .duration(200)
                .style('opacity', 0)
                .remove();

            var enter = entries.enter()
                .insert('div', '.tag-reference-body')
                .attr('class', `field-warning ${klass}`)
                .style('opacity', 0);

            enter
                .call(uiIcon('#rapid-icon-alert', 'inline'))
                .append('span');

            enter
                .transition()
                .duration(200)
                .style('opacity', 1);

            entries.merge(enter)
                .selectAll('div > span')
                .text('')
                .each(function(d) {
                    d3_select(this).call(d.msg);
                });
        }
    }


    changesetEditor.tags = function(_) {
        if (!arguments.length) return _tags;
        _tags = _;
        // Don't reset _uifields here.
        return changesetEditor;
    };


    changesetEditor.changesetID = function(_) {
        if (!arguments.length) return _changesetID;
        if (_changesetID === _) return changesetEditor;
        _changesetID = _;
        _uifields = null;
        return changesetEditor;
    };


    return utilRebind(changesetEditor, dispatch, 'on');
}
