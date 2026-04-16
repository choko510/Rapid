import { uiIcon } from './icon.js';
import { uiModal } from './modal.js';


/**
 * UiPluginManagerModal
 * Modal for browsing registry plugins with search/filter and toggling them on/off.
 */
export class UiPluginManagerModal {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    this.context = context;

    this.$modal = null;
    this.$advancedWrap = null;
    this.$permissionWrap = null;
    this._permissionResolver = null;

    this._registryToAdd = '';
    this._searchText = '';
    this._tagFilter = '*';
    this._advancedConfirmed = false;
    this._statusText = '';
    this._statusKind = 'info';
    this._pendingPluginStates = new Map();
    this._processingCount = 0;

    this.show = this.show.bind(this);
    this.render = this.render.bind(this);
    this.rerender = this.render.bind(this);
    this._setStatus = this._setStatus.bind(this);
    this._clearStatus = this._clearStatus.bind(this);
    this._refreshRegistry = this._refreshRegistry.bind(this);
    this._addRegistry = this._addRegistry.bind(this);
    this._removeActiveRegistry = this._removeActiveRegistry.bind(this);
    this._changeActiveRegistry = this._changeActiveRegistry.bind(this);
    this._togglePlugin = this._togglePlugin.bind(this);
    this._toggleAdvancedConfirm = this._toggleAdvancedConfirm.bind(this);
    this._openAdvancedModal = this._openAdvancedModal.bind(this);
    this._closeAdvancedModal = this._closeAdvancedModal.bind(this);
    this._changeSearchText = this._changeSearchText.bind(this);
    this._changeTagFilter = this._changeTagFilter.bind(this);
    this._showPermissionPrompt = this._showPermissionPrompt.bind(this);
    this._closePermissionModal = this._closePermissionModal.bind(this);

    const l10n = context.systems.l10n;
    const plugins = context.systems.plugins;
    l10n.on('localechange', this.rerender);
    plugins?.on('pluginschange', this.rerender);
    plugins?.setPermissionPromptHandler?.(this._showPermissionPrompt);
  }


  /**
   * show
   * Show plugin manager modal.
   */
  show() {
    const context = this.context;
    const $container = context.container();
    const isShowing = $container.selectAll('.shaded').size();
    if (isShowing) return;

    this.$modal = uiModal($container);
    this.$modal.select('.modal')
      .classed('modal-plugin-manager', true);

    this.$modal.select('.content')
      .classed('plugin-manager-content', true);

    const originalClose = this.$modal.close;
    this.$modal.close = () => {
      this._closePermissionModal(false);
      this._closeAdvancedModal();
      this.$modal = null;
      originalClose();
    };

    this.render();
  }


  /**
   * render
   */
  render() {
    if (!this.$modal) return;

    const context = this.context;
    const l10n = context.systems.l10n;
    const plugins = context.systems.plugins;
    const registryState = plugins?.getRegistryState() ?? {};
    const bundled = plugins?.getBundledPlugins() ?? [];
    const catalog = plugins?.getRegistryCatalog() ?? [];
    const $content = this.$modal.select('.content');

    const allTags = Array.from(new Set(catalog.flatMap(plugin => plugin.tags || []))).sort((a, b) => a.localeCompare(b));
    if (this._tagFilter !== '*' && !allTags.includes(this._tagFilter)) {
      this._tagFilter = '*';
    }

    const search = this._searchText.toLowerCase();
    const filteredCatalog = catalog.filter(plugin => {
      const name = (plugin.name || '').toLowerCase();
      const description = (plugin.description || '').toLowerCase();
      const id = (plugin.id || '').toLowerCase();
      const tags = (plugin.tags || []).map(tag => String(tag).toLowerCase());
      const matchesText = !search || name.includes(search) || description.includes(search) || id.includes(search);
      const matchesTag = this._tagFilter === '*' || tags.includes(this._tagFilter.toLowerCase());
      return matchesText && matchesTag;
    });

    let registryFetchedAt = l10n.t('plugin_manager.registry_never_updated');
    if (registryState.fetchedAt) {
      const date = new Date(registryState.fetchedAt);
      if (!Number.isNaN(date.getTime())) {
        registryFetchedAt = date.toLocaleString();
      }
    }

    let registryStatus = l10n.t('plugin_manager.registry_status', {
      url: registryState.url || '',
      updated: registryFetchedAt
    });
    if (registryState.error) {
      registryStatus += `\n${l10n.t('plugin_manager.registry_error')}: ${registryState.error}`;
    }

    $content.classed('is-processing', this._isProcessing());

    // Heading
    let $heading = $content.selectAll('.plugin-manager-heading')
      .data([0]);

    const $$heading = $heading.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-manager-heading');

    $$heading.append('h3');
    $$heading.append('p');

    $heading = $heading.merge($$heading);
    $heading.selectAll('h3')
      .text(l10n.t('plugin_manager.heading'));
    $heading.selectAll('p')
      .text(l10n.t('plugin_manager.description'));

    // Top controls section (search/filter)
    let $controls = $content.selectAll('.plugin-manager-install')
      .data([0]);

    const $$controls = $controls.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-manager-install');

    const $$catalogControls = $$controls
      .append('div')
      .attr('class', 'plugin-catalog-controls');

    $$catalogControls
      .append('input')
      .attr('class', 'plugin-catalog-search')
      .on('input', this._changeSearchText);

    $$catalogControls
      .append('select')
      .attr('class', 'plugin-catalog-tag-filter')
      .on('change', this._changeTagFilter);

    $$controls
      .append('pre')
      .attr('class', 'plugin-install-result');

    $controls = $controls.merge($$controls);

    $controls.selectAll('.plugin-catalog-search')
      .attr('placeholder', l10n.t('plugin_manager.search_placeholder'))
      .property('value', this._searchText)
      .attr('disabled', this._isProcessing() ? true : null);

    const localizedTagOptions = allTags
      .map(tag => ({ value: tag, label: this._localizeTag(tag) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const tagOptions = [{ value: '*', label: l10n.t('plugin_manager.filter_tag_all') }]
      .concat(localizedTagOptions);

    const $tagOptions = $controls.selectAll('.plugin-catalog-tag-filter')
      .selectAll('option')
      .data(tagOptions, d => d.value);

    $tagOptions.exit()
      .remove();

    $tagOptions.enter()
      .append('option')
      .merge($tagOptions)
      .attr('value', d => d.value)
      .text(d => d.label);

    $controls.selectAll('.plugin-catalog-tag-filter')
      .property('value', this._tagFilter)
      .attr('disabled', this._isProcessing() ? true : null);

    $controls.selectAll('.plugin-install-result')
      .classed('hide', !this._statusText)
      .classed('has-errors', this._statusKind === 'error')
      .text(this._statusText);

    // Bundled section (hidden when empty)
    let $bundled = $content.selectAll('.plugin-manager-bundled')
      .data([0]);

    const $$bundled = $bundled.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-manager-bundled');

    $$bundled
      .append('h4')
      .attr('class', 'plugin-section-heading');

    $$bundled
      .append('div')
      .attr('class', 'plugin-list plugin-list-bundled');

    $bundled = $bundled.merge($$bundled);
    $bundled.classed('hide', bundled.length === 0);
    $bundled.selectAll('.plugin-section-heading')
      .text(l10n.t('plugin_manager.section_bundled'));

    this._renderPluginList($bundled.selectAll('.plugin-list-bundled'), bundled);

    // Registry catalog section
    let $registry = $content.selectAll('.plugin-manager-registry')
      .data([0]);

    const $$registry = $registry.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-manager-registry');

    $$registry
      .append('h4')
      .attr('class', 'plugin-section-heading');

    $$registry
      .append('div')
      .attr('class', 'plugin-list plugin-list-registry');

    $$registry
      .append('div')
      .attr('class', 'plugin-list-empty');

    $registry = $registry.merge($$registry);
    $registry.selectAll('.plugin-section-heading')
      .text(l10n.t('plugin_manager.section_registry_catalog'));

    $registry.selectAll('.plugin-list-empty')
      .classed('hide', filteredCatalog.length > 0)
      .text(l10n.t('plugin_manager.empty_filtered'));

    this._renderPluginList($registry.selectAll('.plugin-list-registry'), filteredCatalog);

    // Advanced section (button only)
    let $advancedSection = $content.selectAll('.plugin-manager-advanced')
      .data([0]);

    const $$advancedSection = $advancedSection.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-manager-advanced');

    $$advancedSection
      .append('button')
      .attr('class', 'plugin-btn plugin-btn-secondary plugin-advanced-controls-open')
      .on('click', this._openAdvancedModal);

    $advancedSection = $advancedSection.merge($$advancedSection);
    $advancedSection.selectAll('.plugin-advanced-controls-open')
      .text(l10n.t('plugin_manager.advanced_controls_show'))
      .attr('disabled', this._isProcessing() ? true : null);

    // OK Button
    let $buttons = $content.selectAll('.modal-section.buttons')
      .data([0]);

    const $$buttons = $buttons.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section buttons');

    $$buttons
      .append('button')
      .attr('class', 'plugin-btn plugin-btn-primary plugin-manager-close')
      .on('click', () => this.$modal?.close());

    const buttonNode = $$buttons.selectAll('button').node();
    if (buttonNode) buttonNode.focus();

    $buttons = $buttons.merge($$buttons);
    $buttons.selectAll('.plugin-manager-close')
      .text(l10n.t('confirm.okay'))
      .attr('disabled', this._isProcessing() ? true : null);

    this._renderAdvancedModal(registryStatus);
  }


  _renderPluginList($selection, plugins) {
    const l10n = this.context.systems.l10n;

    let $rows = $selection.selectAll('.plugin-row')
      .data(plugins, d => d.id);

    $rows.exit().remove();

    const $$rows = $rows.enter()
      .append('div')
      .attr('class', 'plugin-row');

    const $$left = $$rows
      .append('div')
      .attr('class', 'plugin-card-body');

    $$left
      .append('div')
      .attr('class', 'plugin-name');

    $$left
      .append('div')
      .attr('class', 'plugin-description');

    $$left
      .append('div')
      .attr('class', 'plugin-meta');

    const $$inputs = $$rows
      .append('div')
      .attr('class', 'plugin-card-actions');

    const $$switch = $$inputs
      .append('label')
      .attr('class', 'plugin-switch');

    $$switch
      .append('input')
      .attr('type', 'checkbox')
      .attr('class', 'plugin-switch-input')
      .on('change', this._togglePlugin);

    $$switch
      .append('span')
      .attr('class', 'plugin-switch-slider');

    $rows = $rows.merge($$rows);
    $rows.attr('data-plugin-id', d => d.id);

    $rows
      .classed('is-disabled', d => d.revoked)
      .classed('is-pending', d => this._pendingPluginStates.has(d.id));

    $rows.selectAll('.plugin-name')
      .text(d => d.name);

    $rows.selectAll('.plugin-description')
      .text(d => d.description || '');

    $rows.selectAll('.plugin-meta')
      .text(d => {
        const tags = (d.tags?.length ? d.tags : d.kinds)
          .map(tag => this._localizeTag(tag))
          .join(', ');
        const version = d.pluginVersion || '1.0.0';
        const source = d.source === 'bundled'
          ? l10n.t('plugin_manager.meta_source_bundled')
          : l10n.t('plugin_manager.meta_source_registry');
        const installState = d.source === 'registry'
          ? (d.installed ? l10n.t('plugin_manager.meta_installed') : l10n.t('plugin_manager.meta_not_installed'))
          : '';
        const revoked = d.revoked
          ? ` • ${l10n.t('plugin_manager.meta_revoked')}`
          : '';
        return [source, installState, `v${version}`, tags].filter(Boolean).join(' • ') + revoked;
      });

    $rows.selectAll('.plugin-switch-input')
      .property('checked', d => this._pendingPluginStates.has(d.id) ? this._pendingPluginStates.get(d.id) : d.enabled)
      .attr('disabled', d => (d.revoked || this._pendingPluginStates.has(d.id)) ? true : null);
  }


  _openAdvancedModal() {
    if (!this.$modal || this.$advancedWrap) return;
    this._clearStatus();

    const $shaded = this.context.container().selectAll('.shaded');
    if ($shaded.empty()) return;

    let $wrap = $shaded.selectAll('.plugin-advanced-wrap')
      .data([0]);

    const $$wrap = $wrap.enter()
      .append('div')
      .attr('class', 'plugin-advanced-wrap');

    $$wrap
      .append('div')
      .attr('class', 'plugin-advanced-backdrop')
      .on('click', this._closeAdvancedModal);

    const $$modal = $$wrap
      .append('div')
      .attr('class', 'modal modal-plugin-manager plugin-advanced-modal');

    $$modal
      .append('button')
      .attr('class', 'close')
      .on('click', this._closeAdvancedModal)
      .call(uiIcon('#rapid-icon-close'));

    $$modal
      .append('div')
      .attr('class', 'content plugin-manager-content plugin-advanced-content');

    this.$advancedWrap = $wrap = $wrap.merge($$wrap);
    this._renderAdvancedModal('');
  }


  _closeAdvancedModal() {
    if (this.$advancedWrap) {
      this.$advancedWrap.remove();
      this.$advancedWrap = null;
    }
  }


  _renderAdvancedModal(registryStatus) {
    if (!this.$advancedWrap) return;

    const plugins = this.context.systems.plugins;
    const l10n = this.context.systems.l10n;
    const registryState = plugins?.getRegistryState() ?? {};
    const registryURLs = Array.isArray(registryState.registries) ? registryState.registries : [];
    const activeRegistryURL = registryState.activeURL || registryState.url || registryURLs[0] || '';
    const $content = this.$advancedWrap.selectAll('.plugin-advanced-content');

    let $heading = $content.selectAll('.plugin-advanced-heading')
      .data([0]);

    const $$heading = $heading.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-advanced-heading');

    $$heading.append('h4');
    $$heading.append('p');

    $heading = $heading.merge($$heading);
    $heading.selectAll('h4')
      .text(l10n.t('plugin_manager.advanced_modal_heading'));
    $heading.selectAll('p')
      .text(l10n.t('plugin_manager.advanced_modal_description'));

    let $warning = $content.selectAll('.plugin-advanced-warning')
      .data([0]);

    const $$warning = $warning.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-advanced-warning');

    $$warning.append('p')
      .attr('class', 'plugin-advanced-warning-text');

    const $$confirmLabel = $$warning
      .append('label')
      .attr('class', 'plugin-advanced-confirm-label');

    $$confirmLabel
      .append('input')
      .attr('type', 'checkbox')
      .attr('class', 'plugin-advanced-confirm-input')
      .on('change', this._toggleAdvancedConfirm);

    $$confirmLabel
      .append('span')
      .attr('class', 'plugin-advanced-confirm-text');

    $warning = $warning.merge($$warning);
    $warning.selectAll('.plugin-advanced-warning-text')
      .text(l10n.t('plugin_manager.advanced_warning'));
    $warning.selectAll('.plugin-advanced-confirm-input')
      .property('checked', this._advancedConfirmed)
      .attr('disabled', this._isProcessing() ? true : null);
    $warning.selectAll('.plugin-advanced-confirm-text')
      .text(l10n.t('plugin_manager.advanced_confirm'));

    let $controls = $content.selectAll('.plugin-advanced-controls')
      .data([0]);

    const $$controls = $controls.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-advanced-controls');

    $$controls
      .append('div')
      .attr('class', 'plugin-registry-label');

    const $$registryRow = $$controls
      .append('div')
      .attr('class', 'plugin-registry-row');

    $$registryRow
      .append('select')
      .attr('class', 'plugin-registry-select')
      .on('change', this._changeActiveRegistry);

    $$registryRow
      .append('button')
      .attr('class', 'plugin-btn plugin-btn-secondary plugin-refresh-button')
      .on('click', this._refreshRegistry);

    $$registryRow
      .append('button')
      .attr('class', 'plugin-btn plugin-btn-secondary plugin-remove-registry-button')
      .on('click', this._removeActiveRegistry);

    const $$registryAddRow = $$controls
      .append('div')
      .attr('class', 'plugin-registry-add-row');

    $$registryAddRow
      .append('input')
      .attr('class', 'plugin-registry-add-url')
      .on('input', e => {
        this._registryToAdd = String(e?.currentTarget?.value ?? e?.target?.value ?? '').trim();
      })
      .on('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._addRegistry();
        }
      });

    $$registryAddRow
      .append('button')
      .attr('class', 'plugin-btn plugin-btn-primary plugin-add-registry-button')
      .on('click', this._addRegistry);

    $$controls
      .append('div')
      .attr('class', 'plugin-registry-status');

    $controls = $controls.merge($$controls);

    $controls.selectAll('.plugin-registry-label')
      .text(l10n.t('plugin_manager.registry_select_label'));

    const $registryOptions = $controls.selectAll('.plugin-registry-select')
      .selectAll('option')
      .data(registryURLs, d => d);

    $registryOptions.exit()
      .remove();

    $registryOptions.enter()
      .append('option')
      .merge($registryOptions)
      .attr('value', d => d)
      .text(d => d);

    const inputDisabled = this._isProcessing() ? true : null;

    $controls.selectAll('.plugin-registry-select')
      .property('value', activeRegistryURL)
      .attr('disabled', inputDisabled);

    $controls.selectAll('.plugin-refresh-button')
      .text(l10n.t('plugin_manager.refresh_button'))
      .attr('disabled', inputDisabled);

    $controls.selectAll('.plugin-remove-registry-button')
      .text(l10n.t('plugin_manager.remove_registry_button'))
      .attr('disabled', (registryURLs.length <= 1 || this._isProcessing()) ? true : null);

    $controls.selectAll('.plugin-registry-add-url')
      .attr('placeholder', l10n.t('plugin_manager.registry_add_placeholder'))
      .property('value', this._registryToAdd)
      .attr('disabled', inputDisabled);

    $controls.selectAll('.plugin-add-registry-button')
      .text(l10n.t('plugin_manager.registry_add_button'))
      .attr('disabled', inputDisabled);

    $controls.selectAll('.plugin-registry-status')
      .text(registryStatus);

    let $buttons = $content.selectAll('.plugin-advanced-buttons')
      .data([0]);

    const $$buttons = $buttons.enter()
      .append('div')
      .attr('class', 'modal-section plugin-manager-section plugin-advanced-buttons');

    $$buttons
      .append('button')
      .attr('class', 'plugin-btn plugin-btn-primary')
      .on('click', this._closeAdvancedModal);

    $buttons = $buttons.merge($$buttons);
    $buttons.selectAll('button')
      .text(l10n.t('confirm.okay'))
      .attr('disabled', inputDisabled);
  }


  async _showPermissionPrompt(request = {}) {
    const l10n = this.context.systems.l10n;
    const pluginName = String(request.pluginName || '');
    const capabilities = Array.isArray(request.capabilities) ? request.capabilities : [];

    if (!capabilities.length) return true;

    const $shaded = this.context.container().selectAll('.shaded');
    if ($shaded.empty()) {
      const summary = capabilities
        .map(item => `${item.label || item.id}: ${item.description || item.id}`)
        .join('\n');
      const message = l10n.t('plugin_manager.permissions.prompt', {
        name: pluginName,
        capabilities: summary
      });
      return window.confirm(message);
    }

    this._closePermissionModal(false);

    return new Promise(resolve => {
      this._permissionResolver = resolve;

      let $wrap = $shaded.selectAll('.plugin-permission-wrap')
        .data([0]);

      const $$wrap = $wrap.enter()
        .append('div')
        .attr('class', 'plugin-permission-wrap');

      $$wrap
        .append('div')
        .attr('class', 'plugin-permission-backdrop')
        .on('click', () => this._closePermissionModal(false));

      const $$modal = $$wrap
        .append('div')
        .attr('class', 'modal modal-plugin-manager plugin-permission-modal');

      $$modal
        .append('button')
        .attr('class', 'close')
        .on('click', () => this._closePermissionModal(false))
        .call(uiIcon('#rapid-icon-close'));

      const $$content = $$modal
        .append('div')
        .attr('class', 'content plugin-manager-content plugin-permission-content');

      $$content
        .append('div')
        .attr('class', 'modal-section plugin-manager-section plugin-permission-heading')
        .append('h4');

      $$content
        .append('div')
        .attr('class', 'modal-section plugin-manager-section plugin-permission-description');

      $$content
        .append('div')
        .attr('class', 'modal-section plugin-manager-section plugin-permission-list');

      const $$buttons = $$content
        .append('div')
        .attr('class', 'modal-section plugin-manager-section plugin-permission-buttons');

      $$buttons
        .append('button')
        .attr('class', 'plugin-btn plugin-btn-secondary plugin-permission-deny')
        .on('click', () => this._closePermissionModal(false));

      $$buttons
        .append('button')
        .attr('class', 'plugin-btn plugin-btn-primary plugin-permission-allow')
        .on('click', () => this._closePermissionModal(true));

      this.$permissionWrap = $wrap = $wrap.merge($$wrap);
      const $content = $wrap.selectAll('.plugin-permission-content');

      $content.selectAll('.plugin-permission-heading h4')
        .text(l10n.t('plugin_manager.permissions.heading', { name: pluginName }));

      $content.selectAll('.plugin-permission-description')
        .text(l10n.t('plugin_manager.permissions.description'));

      const $items = $content.selectAll('.plugin-permission-list')
        .selectAll('.plugin-permission-item')
        .data(capabilities, d => d.id);

      $items.exit()
        .remove();

      const $$items = $items.enter()
        .append('div')
        .attr('class', 'plugin-permission-item');

      $$items
        .append('div')
        .attr('class', 'plugin-permission-name');

      $$items
        .append('div')
        .attr('class', 'plugin-permission-detail');

      const $merged = $$items.merge($items);
      $merged.selectAll('.plugin-permission-name')
        .text(d => d.label || d.id);
      $merged.selectAll('.plugin-permission-detail')
        .text(d => d.description || d.id);

      $content.selectAll('.plugin-permission-deny')
        .text(l10n.t('plugin_manager.permissions.deny_button'));

      $content.selectAll('.plugin-permission-allow')
        .text(l10n.t('plugin_manager.permissions.allow_button'));
    });
  }


  _closePermissionModal(accepted) {
    if (this.$permissionWrap) {
      this.$permissionWrap.remove();
      this.$permissionWrap = null;
    }

    if (this._permissionResolver) {
      const resolve = this._permissionResolver;
      this._permissionResolver = null;
      resolve(Boolean(accepted));
    }
  }


  _toggleAdvancedConfirm(e) {
    const checked = e?.currentTarget?.checked ?? e?.target?.checked;
    this._advancedConfirmed = (typeof checked === 'boolean')
      ? checked
      : Boolean(this.$advancedWrap?.select('.plugin-advanced-confirm-input').property('checked'));
    this.render();
  }


  _changeSearchText(e) {
    this._searchText = (e?.currentTarget?.value ?? '').trim();
    this._clearStatus();
    this.render();
  }


  _changeTagFilter(e) {
    this._tagFilter = (e?.currentTarget?.value ?? '*').trim() || '*';
    this._clearStatus();
    this.render();
  }


  _requireAdvancedConfirmed() {
    if (this._advancedConfirmed) return true;
    this._setStatus(this.context.systems.l10n.t('plugin_manager.advanced_required_error'), 'error');
    this.render();
    return false;
  }


  async _runWithProcessing(task) {
    if (this._isProcessing()) return;
    this._processingCount++;
    this.render();
    try {
      await task();
    } finally {
      this._processingCount = Math.max(0, this._processingCount - 1);
      this.render();
    }
  }


  async _refreshRegistry() {
    await this._runWithProcessing(async () => {
      if (!this._requireAdvancedConfirmed()) return;

      const plugins = this.context.systems.plugins;
      const registryURL = plugins.getRegistryState()?.activeURL || plugins.getRegistryState()?.url || '';
      try {
        const result = await plugins.refreshRegistryAsync({ registryURL });
        this._setStatus(
          this.context.systems.l10n.t('plugin_manager.refresh_success', {
            count: result.entries,
            revoked: result.revoked
          }),
          'info'
        );
      } catch (err) {
        this._setStatus(err.message, 'error');
      }
    });
  }


  async _changeActiveRegistry(e) {
    await this._runWithProcessing(async () => {
      if (!this._requireAdvancedConfirmed()) return;

      const plugins = this.context.systems.plugins;
      const registryURL = String(
        e?.currentTarget?.value ??
        e?.target?.value ??
        this.$advancedWrap?.select('.plugin-registry-select').property('value') ??
        ''
      ).trim();
      if (!registryURL) return;

      try {
        plugins.setActiveRegistry(registryURL);
        await plugins.refreshRegistryAsync({ registryURL });
        this._setStatus(
          this.context.systems.l10n.t('plugin_manager.registry_selected_success', { url: registryURL }),
          'info'
        );
      } catch (err) {
        this._setStatus(err.message, 'error');
      }
    });
  }


  async _addRegistry() {
    await this._runWithProcessing(async () => {
      if (!this._requireAdvancedConfirmed()) return;

      const plugins = this.context.systems.plugins;
      const typedURL = String(this.$advancedWrap?.select('.plugin-registry-add-url').property('value') ?? '').trim();
      const registryURL = this._registryToAdd.trim() || typedURL;
      if (!registryURL) {
        this._setStatus(this.context.systems.l10n.t('plugin_manager.registry_add_missing'), 'error');
        return;
      }

      try {
        plugins.addRegistry(registryURL);
        await plugins.refreshRegistryAsync({ registryURL });
        this._registryToAdd = '';
        this._setStatus(
          this.context.systems.l10n.t('plugin_manager.registry_add_success', { url: registryURL }),
          'info'
        );
      } catch (err) {
        this._setStatus(err.message, 'error');
      }
    });
  }


  async _removeActiveRegistry() {
    await this._runWithProcessing(async () => {
      if (!this._requireAdvancedConfirmed()) return;

      const plugins = this.context.systems.plugins;
      const state = plugins.getRegistryState() || {};
      const registryURL = state.activeURL || state.url || '';
      if (!registryURL) return;

      try {
        plugins.removeRegistry(registryURL);
        const next = plugins.getRegistryState() || {};
        const nextURL = next.activeURL || next.url || '';
        if (nextURL) {
          await plugins.refreshRegistryAsync({ registryURL: nextURL });
        }
        this._setStatus(
          this.context.systems.l10n.t('plugin_manager.registry_remove_success', { url: registryURL }),
          'info'
        );
      } catch (err) {
        this._setStatus(err.message, 'error');
      }
    });
  }


  async _togglePlugin(e, d) {
    const plugins = this.context.systems.plugins;
    const checkbox = e?.currentTarget;
    let plugin = d;
    if (!plugin) {
      const pluginID = checkbox?.closest('.plugin-row')?.getAttribute('data-plugin-id');
      if (pluginID) {
        const catalog = plugins?.getRegistryCatalog?.() ?? [];
        const bundled = plugins?.getBundledPlugins?.() ?? [];
        plugin = catalog.find(item => item.id === pluginID) || bundled.find(item => item.id === pluginID);
      }
    }

    if (!plugin) {
      this.render();
      return;
    }

    if (this._isProcessing()) {
      if (checkbox) {
        checkbox.checked = this._pendingPluginStates.has(plugin.id)
          ? this._pendingPluginStates.get(plugin.id)
          : Boolean(plugin.enabled);
      }
      return;
    }

    const desired = Boolean(checkbox?.checked);
    const registryURL = plugins.getRegistryState()?.activeURL || plugins.getRegistryState()?.url || '';

    this._pendingPluginStates.set(plugin.id, desired);
    await this._runWithProcessing(async () => {
      try {
        if (plugin.source === 'registry') {
          await plugins.setRegistryPluginEnabled(plugin.id, desired, { registryURL });
        } else {
          await plugins.setPluginEnabled(plugin.id, desired);
        }

        const messageKey = desired
          ? (plugin.source === 'registry' && !plugin.installed ? 'plugin_manager.install_enable_success' : 'plugin_manager.enable_success')
          : 'plugin_manager.disable_success';

        this._setStatus(
          this.context.systems.l10n.t(messageKey, { name: plugin.name }),
          'info'
        );
      } catch (err) {
        this._setStatus(err.message, 'error');
      } finally {
        this._pendingPluginStates.delete(plugin.id);
      }
    });
  }


  _isProcessing() {
    return this._processingCount > 0;
  }


  _setStatus(text, kind = 'info') {
    this._statusText = String(text || '').trim();
    this._statusKind = kind;
  }


  _clearStatus() {
    this._statusText = '';
    this._statusKind = 'info';
  }


  _localizeTag(tag) {
    const l10n = this.context.systems.l10n;
    const raw = String(tag || '').trim();
    if (!raw) return '';
    const token = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const key = `plugin_manager.tags.${token}`;
    return l10n.t(key, { default: raw });
  }

}

