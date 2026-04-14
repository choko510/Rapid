import { dispatch as d3_dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';

import { uiCombobox } from '../combobox.js';
import { utilGetSetValue, utilNoAuto, utilRebind } from '../../util/index.js';


export function uiFieldCycleway(context, uifield) {
    const l10n = context.systems.l10n;
    const dispatch = d3_dispatch('change');

    var items = d3_select(null);
    var wrap = d3_select(null);
    var _tags;

    function cycleway(selection) {

        function stripcolon(s) {
            return s.replace(':', '');
        }


        wrap = selection.selectAll('.form-field-input-wrap')
            .data([0]);

        wrap = wrap.enter()
            .append('div')
            .attr('class', 'form-field-input-wrap form-field-input-' + uifield.type)
            .merge(wrap);


        var div = wrap.selectAll('ul')
            .data([0]);

        div = div.enter()
            .append('ul')
            .attr('class', 'rows rows-table')
            .merge(div);

        var keys = ['cycleway:left', 'cycleway:right'];

        items = div.selectAll('li')
            .data(keys);

        var enter = items.enter()
            .append('li')
            .attr('class', function(d) { return 'labeled-input preset-cycleway-' + stripcolon(d); });

        enter
            .append('div')
            .attr('class', 'label preset-label-cycleway')
            .attr('for', function(d) { return 'preset-input-cycleway-' + stripcolon(d); })
            .html(function(d) { return uifield.tHtml('types.' + d); });

        enter
            .append('div')
            .attr('class', 'preset-input-cycleway-wrap')
            .append('input')
            .attr('type', 'text')
            .attr('class', function(d) { return 'preset-input-cycleway preset-input-' + stripcolon(d); })
            .call(utilNoAuto)
            .each(function(d) {
                d3_select(this)
                    .call(uiCombobox(context, 'cycleway-' + stripcolon(d))
                        .data(cycleway.options(d))
                    );
            });

        items = items.merge(enter);

        // Update
        wrap.selectAll('.preset-input-cycleway')
            .on('change', change)
            .on('blur', change);
    }


    function change(d3_event, key) {
        var newValue = context.cleanTagValue(utilGetSetValue(d3_select(this)));

        // don't override multiple values with blank string
        if (!newValue && (Array.isArray(_tags.cycleway) || Array.isArray(_tags['cycleway:both']) || Array.isArray(_tags[key]))) return;

        if (newValue === 'none' || newValue === '') { newValue = undefined; }

        var otherKey = key === 'cycleway:left' ? 'cycleway:right' : 'cycleway:left';
        var commonValue = (typeof _tags.cycleway === 'string') ? _tags.cycleway :
            (typeof _tags['cycleway:both'] === 'string') ? _tags['cycleway:both'] : undefined;
        var otherValue = commonValue ?? _tags[otherKey];
        if (otherValue && Array.isArray(otherValue)) {
            // we must always have an explicit value for comparison
            otherValue = otherValue[0];
        }
        if (otherValue === 'none' || otherValue === '') { otherValue = undefined; }

        let tag;

        // If the left and right tags match, use the cycleway tag to tag both
        // sides the same way
        if (newValue === otherValue) {
            // Preserve whichever common key already exists when possible.
            const commonKey = ('cycleway:both' in _tags && !('cycleway' in _tags)) ? 'cycleway:both' : 'cycleway';
            tag = {
                [commonKey]: newValue,
                cycleway: commonKey === 'cycleway' ? newValue : undefined,
                'cycleway:both': commonKey === 'cycleway:both' ? newValue : undefined,
                'cycleway:left': undefined,
                'cycleway:right': undefined
            };
        } else {
            // Always set both left and right as changing one can affect the other
            tag = {
                cycleway: undefined,
                'cycleway:both': undefined
            };
            tag[key] = newValue;
            tag[otherKey] = otherValue;
        }

        dispatch.call('change', this, tag);
    }


    cycleway.options = function() {
        return uifield.presetField.options.map(function(option) {
            return {
                title: uifield.t(`options.${option}.description`),
                value: option
            };
        });
    };


    cycleway.tags = function(tags) {
        _tags = tags;

        // If cycleway is set, use that instead of individual values
        var commonValue = typeof tags.cycleway === 'string' ? tags.cycleway :
            (typeof tags['cycleway:both'] === 'string' ? tags['cycleway:both'] : undefined);

        utilGetSetValue(items.selectAll('.preset-input-cycleway'), function(d) {
                if (commonValue) return commonValue;
                return !tags.cycleway && typeof tags[d] === 'string' ? tags[d] : '';
            })
            .attr('title', function(d) {
                if (Array.isArray(tags.cycleway) || Array.isArray(tags['cycleway:both']) || Array.isArray(tags[d])) {
                    var vals = [];
                    if (Array.isArray(tags.cycleway)) {
                        vals = vals.concat(tags.cycleway);
                    }
                    if (Array.isArray(tags['cycleway:both'])) {
                        vals = vals.concat(tags['cycleway:both']);
                    }
                    if (Array.isArray(tags[d])) {
                        vals = vals.concat(tags[d]);
                    }
                    return vals.filter(Boolean).join('\n');
                }
                return null;
            })
            .attr('placeholder', function(d) {
                if (Array.isArray(tags.cycleway) || Array.isArray(tags['cycleway:both']) || Array.isArray(tags[d])) {
                    return l10n.t('inspector.multiple_values');
                }
                return uifield.placeholder;
            })
            .classed('mixed', function(d) {
                return Array.isArray(tags.cycleway) || Array.isArray(tags['cycleway:both']) || Array.isArray(tags[d]);
            });
    };


    cycleway.focus = function() {
        var node = wrap.selectAll('input').node();
        if (node) node.focus();
    };


    return utilRebind(cycleway, dispatch, 'on');
}
