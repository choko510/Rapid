describe('UiPluginManagerModal', () => {
  let body, container, modal;
  let toggleCalls, refreshCalls, addRegistryCalls, setActiveRegistryCalls, removeRegistryCalls;
  const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/choko510/customRapid-plugin/main/registry.json';
  const EXTRA_REGISTRY = 'https://example.com/external/registry.json';

  class MockPluginsSystem {
    constructor() {
      this._registries = [DEFAULT_REGISTRY, EXTRA_REGISTRY];
      this._active = DEFAULT_REGISTRY;
      this._staleCatalog = false;
      this._catalog = [
        {
          id: 'rapid-layer-tools',
          source: 'registry',
          name: 'Rapid Layer Tools',
          description: 'Toggle Rapid AI layers',
          usage: [
            'Enable the plugin and use the AI button in the top toolbar.',
            'You can also run the command from the command palette.'
          ],
          docsURL: 'https://example.com/docs/rapid-layer-tools',
          pluginVersion: '1.0.0',
          kinds: ['ui', 'operation'],
          tags: ['rapid', 'layers'],
          capabilities: ['ui.toolbar', 'map.layers'],
          installed: true,
          enabled: true,
          trusted: false,
          revoked: false
        },
        {
          id: 'issues-pane-tools',
          source: 'registry',
          name: 'Issues Pane Tools',
          description: 'Open QA issue workflows',
          pluginVersion: '1.0.0',
          kinds: ['ui', 'operation'],
          tags: ['qa', 'issues'],
          capabilities: ['ui.commandPalette', 'ui.panes.issues'],
          installed: false,
          enabled: false,
          trusted: false,
          revoked: false
        }
      ];
    }
    on() { return this; }
    setPermissionPromptHandler() { return this; }
    getRegistryState() {
      return {
        url: this._active,
        activeURL: this._active,
        registries: [...this._registries],
        fetchedAt: null,
        error: null
      };
    }
    getBundledPlugins() { return []; }
    getRegistryPlugins() { return this._catalog.filter(d => d.installed); }
    getRegistryCatalog() { return this._catalog; }
    setRegistryPluginEnabled(pluginID, enabled) {
      toggleCalls.push([pluginID, enabled]);
      const item = this._catalog.find(d => d.id === pluginID);
      if (item && !this._staleCatalog) {
        if (enabled) item.installed = true;
        item.enabled = enabled;
      }
      return Promise.resolve(item || null);
    }
    refreshRegistryAsync(options = {}) {
      if (options.registryURL) this._active = options.registryURL;
      refreshCalls.push(options.registryURL || this._active);
      return Promise.resolve({ entries: this._catalog.length, revoked: 0 });
    }
    addRegistry(url) {
      if (!this._registries.includes(url)) this._registries.push(url);
      this._active = url;
      addRegistryCalls.push(url);
    }
    setActiveRegistry(url) {
      this._active = url;
      setActiveRegistryCalls.push(url);
    }
    removeRegistry(url) {
      this._registries = this._registries.filter(d => d !== url);
      this._active = this._registries[0];
      removeRegistryCalls.push(url);
    }
  }

  class MockContext {
    constructor() {
      this.systems = {
        l10n: {
          on: () => {},
          t: (key, options = {}) => {
            if (key === 'plugin_manager.registry_status') {
              return `Registry: ${options.url}\nLast updated: ${options.updated}`;
            }
            return options.default || key;
          }
        },
        plugins: new MockPluginsSystem()
      };
    }
    container() {
      return container;
    }
  }

  beforeEach(() => {
    toggleCalls = [];
    refreshCalls = [];
    addRegistryCalls = [];
    setActiveRegistryCalls = [];
    removeRegistryCalls = [];
    body = d3.select('body');
    container = body.append('div').attr('class', 'container');
    modal = new Rapid.UiPluginManagerModal(new MockContext());
    modal.show();
  });

  afterEach(() => {
    container.remove();
  });


  it('renders catalog controls and advanced button', () => {
    expect(container.selectAll('.modal-plugin-manager').size()).to.eql(1);
    expect(container.selectAll('.plugin-advanced-warning').size()).to.eql(0);
    expect(container.selectAll('.plugin-catalog-search').size()).to.eql(1);
    expect(container.selectAll('.plugin-catalog-tag-filter').size()).to.eql(1);
    expect(container.selectAll('.plugin-advanced-controls-open').size()).to.eql(1);
    expect(container.selectAll('.plugin-list-registry .plugin-row').size()).to.eql(2);
  });


  it('toggles registry plugin without advanced confirmation', done => {
    container.selectAll('.plugin-list-registry .plugin-switch-input')
      .filter(d => d.id === 'issues-pane-tools')
      .property('checked', true)
      .dispatch('change');

    window.setTimeout(() => {
      expect(toggleCalls).to.eql([['issues-pane-tools', true]]);
      expect(container.selectAll('.plugin-list-registry .plugin-switch-input')
        .filter(d => d.id === 'issues-pane-tools')
        .property('checked')).to.eql(true);
      done();
    }, 25);
  });


  it('keeps toggle state in sync when disabling plugin', done => {
    container.selectAll('.plugin-list-registry .plugin-switch-input')
      .filter(d => d.id === 'rapid-layer-tools')
      .property('checked', false)
      .dispatch('change');

    window.setTimeout(() => {
      expect(toggleCalls).to.eql([['rapid-layer-tools', false]]);
      expect(container.selectAll('.plugin-list-registry .plugin-switch-input')
        .filter(d => d.id === 'rapid-layer-tools')
        .property('checked')).to.eql(false);
      done();
    }, 25);
  });


  it('keeps toggle UI state even if catalog payload is stale', done => {
    modal.context.systems.plugins._staleCatalog = true;

    container.selectAll('.plugin-list-registry .plugin-switch-input')
      .filter(d => d.id === 'issues-pane-tools')
      .property('checked', true)
      .dispatch('change');

    window.setTimeout(() => {
      expect(toggleCalls).to.eql([['issues-pane-tools', true]]);
      expect(container.selectAll('.plugin-list-registry .plugin-switch-input')
        .filter(d => d.id === 'issues-pane-tools')
        .property('checked')).to.eql(true);
      done();
    }, 25);
  });


  it('keeps advanced registry actions gated until confirmed', done => {
    happen.click(container.select('.plugin-advanced-controls-open').node());
    expect(container.selectAll('.plugin-advanced-wrap .plugin-advanced-warning').size()).to.eql(1);

    const addInput = container.select('.plugin-advanced-wrap .plugin-registry-add-url');
    addInput.property('value', 'https://plugins.example.org/registry.json');
    addInput.dispatch('input');
    happen.click(container.select('.plugin-advanced-wrap .plugin-add-registry-button').node());

    window.setTimeout(() => {
      expect(addRegistryCalls).to.eql([]);
      done();
    }, 25);
  });


  it('filters catalog by search text and tag', () => {
    container.select('.plugin-catalog-search')
      .property('value', 'Rapid Layer')
      .dispatch('input');

    expect(container.selectAll('.plugin-list-registry .plugin-row').size()).to.eql(1);

    container.select('.plugin-catalog-tag-filter')
      .property('value', 'qa')
      .dispatch('change');

    expect(container.selectAll('.plugin-list-registry .plugin-row').size()).to.eql(0);
  });


  it('opens plugin details modal with usage and capability info', () => {
    happen.click(container.selectAll('.plugin-list-registry .plugin-detail-button')
      .filter(d => d.id === 'rapid-layer-tools')
      .node());

    expect(container.selectAll('.plugin-detail-wrap .plugin-detail-content').size()).to.eql(1);
    expect(container.selectAll('.plugin-detail-wrap .plugin-detail-usage-list .plugin-detail-item').size()).to.be.greaterThan(0);
    expect(container.selectAll('.plugin-detail-wrap .plugin-detail-capability-list .plugin-detail-capability').size()).to.eql(2);
    expect(container.selectAll('.plugin-detail-wrap .plugin-detail-doc-link').size()).to.eql(1);
  });


  it('adds, switches, and removes registries from advanced controls', done => {
    happen.click(container.select('.plugin-advanced-controls-open').node());

    container.select('.plugin-advanced-wrap .plugin-advanced-confirm-input')
      .property('checked', true)
      .dispatch('change');

    const addInput = container.select('.plugin-advanced-wrap .plugin-registry-add-url');
    addInput.property('value', 'https://plugins.example.org/registry.json');
    addInput.dispatch('input');
    happen.click(container.select('.plugin-advanced-wrap .plugin-add-registry-button').node());

    window.setTimeout(() => {
      const select = container.select('.plugin-advanced-wrap .plugin-registry-select');
      select.property('value', EXTRA_REGISTRY);
      select.dispatch('change');

      window.setTimeout(() => {
        happen.click(container.select('.plugin-advanced-wrap .plugin-remove-registry-button').node());

        window.setTimeout(() => {
          expect(addRegistryCalls).to.eql(['https://plugins.example.org/registry.json']);
          expect(setActiveRegistryCalls.length).to.be.greaterThan(0);
          expect(removeRegistryCalls.length).to.be.greaterThan(0);
          done();
        }, 80);
      }, 80);
    }, 60);
  });


  it('applies plugin manager styles inside advanced modal content', () => {
    happen.click(container.select('.plugin-advanced-controls-open').node());
    expect(container.selectAll('.plugin-advanced-wrap .plugin-advanced-content.plugin-manager-content').size()).to.eql(1);
  });
});
