import { uiModal } from './modal.js';
import { utilCmd } from '../util/cmd.js';


/**
 * UiCommandPalette
 * Lightweight searchable command launcher for common editor actions.
 */
export class UiCommandPalette {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    this.context = context;

    this.$modal = null;
    this._keys = null;
    this._query = '';
    this._selectedIndex = 0;

    this.show = this.show.bind(this);
    this.hide = this.hide.bind(this);
    this.toggle = this.toggle.bind(this);
    this.render = this.render.bind(this);
    this._keydown = this._keydown.bind(this);
    this._setQuery = this._setQuery.bind(this);
    this._executeAction = this._executeAction.bind(this);
    this._setupKeybinding = this._setupKeybinding.bind(this);

    const l10n = context.systems.l10n;
    l10n.on('localechange', () => {
      this._setupKeybinding();
      this.render();
    });

    this._setupKeybinding();
  }


  _setupKeybinding() {
    const context = this.context;
    const keybinding = context.keybinding();

    if (Array.isArray(this._keys)) {
      keybinding.off(this._keys);
    }

    this._keys = [utilCmd('⌘K')];
    keybinding.on(this._keys, e => {
      e?.preventDefault();
      this.toggle();
    });
  }


  _buildActions() {
    const context = this.context;
    const editor = context.systems.editor;
    const scene = context.systems.gfx.scene;
    const ui = context.systems.ui;
    const l10n = context.systems.l10n;

    const toggleRapidLayer = () => {
      const enabled = scene.layers.get('rapid')?.enabled;
      if (enabled) {
        scene.disableLayers('rapid');
      } else {
        scene.enableLayers('rapid');
      }
    };

    const actions = [
      {
        id: 'add-point',
        label: l10n.t('modes.add_point.title'),
        shortcut: utilCmd(l10n.t('shortcuts.command.add_point.key')),
        keywords: 'draw point node',
        run: () => context.enter('add-point')
      },
      {
        id: 'draw-line',
        label: l10n.t('modes.add_line.title'),
        shortcut: utilCmd(l10n.t('shortcuts.command.add_line.key')),
        keywords: 'draw line way road',
        run: () => context.enter('draw-line')
      },
      {
        id: 'draw-area',
        label: l10n.t('modes.add_area.title'),
        shortcut: utilCmd(l10n.t('shortcuts.command.add_area.key')),
        keywords: 'draw area polygon building',
        run: () => context.enter('draw-area')
      },
      {
        id: 'add-note',
        label: l10n.t('modes.add_note.title'),
        shortcut: utilCmd(l10n.t('shortcuts.command.add_note.key')),
        keywords: 'note qa comment',
        run: () => context.enter('add-note')
      },
      {
        id: 'undo',
        label: l10n.t('shortcuts.command.undo.label'),
        shortcut: utilCmd('⌘Z'),
        keywords: 'history undo',
        run: () => editor.undo()
      },
      {
        id: 'redo',
        label: l10n.t('shortcuts.command.redo.label'),
        shortcut: utilCmd('⌘⇧Z'),
        keywords: 'history redo',
        run: () => editor.redo()
      },
      {
        id: 'open-shortcuts',
        label: l10n.t('shortcuts.command.keyboard_shortcuts.label'),
        shortcut: utilCmd(l10n.t('shortcuts.command.keyboard_shortcuts.key')),
        keywords: 'shortcut help keyboard',
        run: () => ui.Shortcuts?.toggle()
      },
      {
        id: 'toggle-map-data-pane',
        label: l10n.t('shortcuts.command.toggle_map_data.label'),
        shortcut: utilCmd(l10n.t('shortcuts.command.toggle_map_data.key')),
        keywords: 'pane map data',
        run: () => ui.Overmap?.MapPanes?.MapData?.togglePane()
      },
      {
        id: 'toggle-issues-pane',
        label: l10n.t('shortcuts.command.toggle_issues.label'),
        shortcut: utilCmd(l10n.t('shortcuts.command.toggle_issues.key')),
        keywords: 'pane issues validation qa',
        run: () => ui.Overmap?.MapPanes?.Issues?.togglePane()
      },
      {
        id: 'toggle-preferences-pane',
        label: l10n.t('shortcuts.command.toggle_preferences.label'),
        shortcut: utilCmd(l10n.t('shortcuts.command.toggle_preferences.key')),
        keywords: 'pane preferences settings',
        run: () => ui.Overmap?.MapPanes?.Preferences?.togglePane()
      },
      {
        id: 'toggle-rapid-layer',
        label: l10n.t('shortcuts.command.toggle_rapid_data.label'),
        shortcut: utilCmd('⇧' + l10n.t('shortcuts.command.toggle_rapid_data.key')),
        keywords: 'rapid ai dataset layer',
        run: toggleRapidLayer
      },
      {
        id: 'open-rapid-datasets',
        label: l10n.t('rapid_menu.add_manage_datasets'),
        shortcut: '',
        keywords: 'rapid datasets catalog',
        run: () => ui.MapToolbar?.Rapid?.RapidModal?.show()
      },
      {
        id: 'open-plugin-manager',
        label: l10n.t('plugin_manager.heading'),
        shortcut: '',
        keywords: 'plugin manager extensions',
        run: () => ui.MapToolbar?.Rapid?.PluginModal?.show()
      }
    ];

    const pluginCommands = context.systems.plugins?.getCommands?.() ?? [];
    for (const pluginCommand of pluginCommands) {
      actions.push({
        id: `plugin-${pluginCommand.id}`,
        label: pluginCommand.label,
        shortcut: pluginCommand.shortcut || '',
        keywords: pluginCommand.keywords || 'plugin',
        run: pluginCommand.run
      });
    }

    return actions;
  }


  _getFilteredActions() {
    const all = this._buildActions();
    const q = this._query.trim().toLowerCase();
    if (!q) return all;

    return all.filter(action => {
      const searchText = `${action.label} ${action.keywords ?? ''}`.toLowerCase();
      return searchText.includes(q);
    });
  }


  show() {
    const context = this.context;
    const $container = context.container();
    const isShowing = $container.selectAll('.shaded > div.modal-command-palette').size();
    if (isShowing) return;

    const otherShowing = $container.selectAll('.shaded > div:not(.modal-command-palette)').size();
    if (otherShowing) return;

    this._query = '';
    this._selectedIndex = 0;
    this.$modal = uiModal($container);
    this.$modal.select('.modal')
      .attr('class', 'modal modal-command-palette fillL');

    this.render();

    window.setTimeout(() => {
      const inputNode = this.$modal?.select('.command-palette-input').node();
      inputNode?.focus();
    }, 0);
  }


  hide() {
    if (!this.$modal) return;
    this.$modal.close();
    this.$modal = null;
  }


  toggle() {
    const $container = this.context.container();
    const isShowing = $container.selectAll('.shaded > div.modal-command-palette').size();
    if (isShowing) {
      this.hide();
    } else {
      this.show();
    }
  }


  _setQuery(val = '') {
    this._query = val;
    this._selectedIndex = 0;
    this.render();
  }


  _keydown(e) {
    if (!this.$modal) return;

    const actions = this._getFilteredActions();

    if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
      return;
    }

    if (!actions.length) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._selectedIndex = (this._selectedIndex - 1 + actions.length) % actions.length;
      this.render();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._selectedIndex = (this._selectedIndex + 1) % actions.length;
      this.render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const action = actions[this._selectedIndex];
      this._executeAction(action);
    }
  }


  _executeAction(action) {
    if (!action?.run) return;
    this.hide();
    action.run();
  }


  render() {
    if (!this.$modal) return;

    const l10n = this.context.systems.l10n;
    const actions = this._getFilteredActions();
    if (this._selectedIndex >= actions.length) {
      this._selectedIndex = Math.max(actions.length - 1, 0);
    }

    const $content = this.$modal.select('.content');

    let $section = $content.selectAll('.command-palette-section')
      .data([0]);

    const $$section = $section.enter()
      .append('div')
      .attr('class', 'command-palette-section');

    $$section
      .append('h3')
      .attr('class', 'command-palette-heading');

    $$section
      .append('input')
      .attr('class', 'command-palette-input')
      .attr('type', 'search')
      .on('input', e => this._setQuery(e.target.value))
      .on('keydown', this._keydown);

    $$section
      .append('div')
      .attr('class', 'command-palette-no-results');

    $$section
      .append('ul')
      .attr('class', 'command-palette-list');

    $section = $section.merge($$section);

    $section.selectAll('.command-palette-heading')
      .text(l10n.t('command.palette.title', { default: 'Command Palette' }));

    $section.selectAll('.command-palette-input')
      .attr('placeholder', l10n.t('inspector.search'))
      .property('value', this._query);

    $section.selectAll('.command-palette-no-results')
      .style('display', actions.length ? 'none' : 'block')
      .text(l10n.t('geocoder.no_results_worldwide'));

    let $items = $section.selectAll('.command-palette-item')
      .data(actions, d => d.id);

    $items.exit()
      .remove();

    const $$items = $items.enter()
      .append('li')
      .append('button')
      .attr('type', 'button')
      .attr('class', 'command-palette-item')
      .on('mouseover', (e, d) => {
        const idx = actions.findIndex(a => a.id === d.id);
        if (idx !== -1) {
          this._selectedIndex = idx;
          this.render();
        }
      })
      .on('click', (e, d) => {
        e.preventDefault();
        this._executeAction(d);
      });

    $$items
      .append('span')
      .attr('class', 'command-palette-item-label');

    $$items
      .append('span')
      .attr('class', 'command-palette-item-shortcut');

    $items = $section.selectAll('.command-palette-item');

    $items
      .classed('active', (d, i) => i === this._selectedIndex);

    $items.selectAll('.command-palette-item-label')
      .text(d => d.label);

    $items.selectAll('.command-palette-item-shortcut')
      .html(d => {
        if (!d.shortcut) return '';
        let html = '';
        const context = this.context;
        for (let i = 0; i < d.shortcut.length; i++) {
          html += '<kbd>' + utilCmd.display(context, d.shortcut[i]) + '</kbd>';
        }
        return html;
      });
  }

}

