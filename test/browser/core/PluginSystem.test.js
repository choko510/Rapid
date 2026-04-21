describe('PluginSystem', () => {
  const REGISTRY_URL = 'https://registry.test/registry.json';
  const PLUGIN_STATE_STORAGE_KEY = 'rapid-plugin-state-v1';

  class MockStorageSystem {
    constructor(initial = {}) {
      this._data = new Map(Object.entries(initial));
    }
    initAsync() { return Promise.resolve(); }
    getItem(key) { return this._data.get(key) ?? null; }
    setItem(key, val) {
      this._data.set(key, val);
      return true;
    }
  }

  class MockL10nSystem {
    initAsync() { return Promise.resolve(); }
    t(key, replacements = {}) {
      if (key === 'plugin_manager.permissions.prompt') {
        return `Plugin "${replacements.name}" requests: ${replacements.capabilities}`;
      }
      if (key === 'plugin_manager.permissions.capabilities.default_label') {
        return replacements.capability;
      }
      if (key === 'plugin_manager.permissions.capabilities.default_description') {
        return `Can use ${replacements.capability}`;
      }
      if (key === 'plugin_manager.permissions.capabilities.ui_toolbar.label') {
        return 'Toolbar controls';
      }
      if (key === 'plugin_manager.permissions.capabilities.ui_toolbar.description') {
        return 'Can add toolbar buttons';
      }
      if (key === 'plugin_manager.permissions.capabilities.map_layers.label') {
        return 'Map layer control';
      }
      if (key === 'plugin_manager.permissions.capabilities.map_layers.description') {
        return 'Can toggle map layers';
      }
      return key;
    }
  }

  class MockUrlHashSystem {
    constructor(registryURL = REGISTRY_URL) {
      this._registryURL = registryURL;
    }
    initAsync() { return Promise.resolve(); }
    getParam(key) {
      if (key === 'plugin_registry') return this._registryURL;
      return null;
    }
  }

  class MockRapidSystem {
    constructor(options = {}) {
      this.autoStart = options.autoStart ?? true;
      this.started = options.started ?? false;
      this.startCalls = 0;
    }
    startAsync() {
      this.startCalls++;
      this.started = true;
      return Promise.resolve();
    }
  }

  class MockContext {
    constructor(options = {}) {
      this.systems = {
        l10n: new MockL10nSystem(),
        storage: new MockStorageSystem(options.storage || {}),
        urlhash: new MockUrlHashSystem(options.registryURL || REGISTRY_URL),
        rapid: options.rapid || new MockRapidSystem()
      };
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  async function sha256Base64(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToBase64(new Uint8Array(digest));
  }

  async function signPayloadBase64(privateKey, payload) {
    const bytes = new TextEncoder().encode(payload);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes);
    return bytesToBase64(new Uint8Array(signature));
  }

  let confirmStub;

  beforeEach(() => {
    fetchMock.removeRoutes().clearHistory();
    confirmStub = sinon.stub(window, 'confirm').returns(true);
  });

  afterEach(() => {
    confirmStub.restore();
    fetchMock.removeRoutes().clearHistory();
  });


  it('has no bundled plugins by default', async () => {
    const plugins = new Rapid.PluginSystem(new MockContext());
    await plugins.initAsync();
    await plugins.startAsync();

    const bundled = plugins.getBundledPlugins();
    expect(bundled).to.eql([]);
  });


  it('installs a registry plugin after signature verification', async () => {
    const pluginID = 'registry-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const manifest = {
      version: 1,
      id: pluginID,
      name: 'Registry Plugin',
      description: 'Signed plugin',
      pluginVersion: '1.0.0',
      kinds: ['ui'],
      capabilities: ['ui.commandPalette'],
      entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`
    };
    const manifestText = JSON.stringify(manifest);
    const manifestHash = await sha256Base64(manifestText);

    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJWK = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const payload = `${pluginID}\n${manifestURL}\n${manifestHash}`;
    const signature = await signPayloadBase64(keyPair.privateKey, payload);

    fetchMock.route(REGISTRY_URL, {
      body: {
        version: 1,
        plugins: [{
          id: pluginID,
          manifestURL: manifestURL,
          manifestHash: manifestHash,
          signature: signature,
          keyID: 'test-key'
        }],
        revoked: []
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    fetchMock.route(manifestURL, {
      body: manifestText,
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext());
    plugins.setTrustedPublicKeys({ 'test-key': publicJWK });

    await plugins.initAsync();
    await plugins.startAsync();
    await plugins.installFromRegistry(pluginID);

    const installed = plugins.getRegistryPlugins();
    expect(installed.length).to.eql(1);
    expect(installed[0].id).to.eql(pluginID);
    expect(installed[0].trusted).to.be.true;
    expect(installed[0].tags).to.include('ui');
  });


  it('parses registry index served as text/plain', async () => {
    const pluginID = 'plain-text-registry-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const manifest = {
      version: 1,
      id: pluginID,
      name: 'Plain Text Registry Plugin',
      description: 'Registry served as text/plain',
      pluginVersion: '1.0.0',
      kinds: ['ui'],
      tags: ['qa'],
      capabilities: ['ui.commandPalette'],
      docsURL: 'https://plugins.example.org/docs/plain-text-registry-plugin',
      usage: [
        'Open the command palette and run the plugin command.'
      ],
      entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`
    };

    fetchMock.route(REGISTRY_URL, {
      body: JSON.stringify({
        version: 1,
        plugins: [{ id: pluginID, manifestURL }],
        revoked: []
      }),
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });

    fetchMock.route(manifestURL, {
      body: JSON.stringify(manifest),
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext());
    await plugins.initAsync();
    await plugins.startAsync();

    const state = plugins.getRegistryState();
    expect(state.error).to.eql(null);
    const catalog = plugins.getRegistryCatalog();
    const plugin = catalog.find(d => d.id === pluginID);
    expect(plugin).to.not.eql(undefined);
    expect(plugin.docsURL).to.eql('https://plugins.example.org/docs/plain-text-registry-plugin');
    expect(plugin.usage).to.eql(['Open the command palette and run the plugin command.']);
  });


  it('immediately marks installed registry plugins as revoked', async () => {
    const pluginID = 'registry-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const manifest = {
      version: 1,
      id: pluginID,
      name: 'Registry Plugin',
      description: 'Unsigned plugin',
      pluginVersion: '1.0.0',
      kinds: ['ui'],
      capabilities: ['ui.commandPalette'],
      entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`
    };

    fetchMock.route(REGISTRY_URL, {
      body: {
        version: 1,
        plugins: [{
          id: pluginID,
          manifestURL: manifestURL
        }],
        revoked: []
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    fetchMock.route(manifestURL, {
      body: JSON.stringify(manifest),
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext());
    await plugins.initAsync();
    await plugins.startAsync();
    await plugins.installFromRegistry(pluginID);
    plugins._plugins.get(pluginID).enabled = true;

    fetchMock.removeRoutes().clearHistory();
    fetchMock.route(REGISTRY_URL, {
      body: {
        version: 1,
        plugins: [{ id: pluginID, manifestURL: manifestURL }],
        revoked: [{ id: pluginID, reason: 'security' }]
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    await plugins.refreshRegistryAsync();

    const plugin = plugins.getRegistryPlugins().find(d => d.id === pluginID);
    expect(plugin.enabled).to.be.false;
    expect(plugin.revoked).to.be.true;
  });


  it('supports adding external registries and installing unsigned plugins', async () => {
    const externalRegistryURL = 'https://plugins.example.org/registry.json';
    const pluginID = 'external-plugin';
    const manifestURL = `https://plugins.example.org/plugins/${pluginID}/manifest.json`;
    const manifest = {
      version: 1,
      id: pluginID,
      name: 'External Plugin',
      description: 'External unsigned plugin',
      pluginVersion: '1.0.0',
      kinds: ['ui'],
      capabilities: ['ui.toolbar'],
      entrypoint: `https://plugins.example.org/plugins/${pluginID}/index.mjs`
    };

    fetchMock.route(REGISTRY_URL, {
      body: { version: 1, plugins: [], revoked: [] },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    fetchMock.route(externalRegistryURL, {
      body: {
        version: 1,
        plugins: [{
          id: pluginID,
          manifestURL: manifestURL
        }],
        revoked: []
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    fetchMock.route(manifestURL, {
      body: JSON.stringify(manifest),
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext());
    await plugins.initAsync();
    await plugins.startAsync();

    plugins.addRegistry(externalRegistryURL);
    await plugins.refreshRegistryAsync({ registryURL: externalRegistryURL });
    await plugins.installFromRegistry(pluginID, { registryURL: externalRegistryURL });

    const state = plugins.getRegistryState();
    expect(state.activeURL).to.eql(externalRegistryURL);
    expect(state.registries).to.include(externalRegistryURL);

    const installed = plugins.getRegistryPlugins();
    expect(installed.length).to.eql(1);
    expect(installed[0].id).to.eql(pluginID);
    expect(installed[0].trusted).to.be.false;
    expect(installed[0].registryURL).to.eql(externalRegistryURL);
  });


  it('enables registry plugins from catalog toggle flow', async () => {
    const pluginID = 'toggle-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const manifest = {
      version: 1,
      id: pluginID,
      name: 'Toggle Plugin',
      description: 'Toggle test plugin',
      pluginVersion: '1.0.0',
      kinds: ['ui'],
      tags: ['qa', 'tools'],
      capabilities: ['ui.commandPalette'],
      entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`
    };

    fetchMock.route(REGISTRY_URL, {
      body: {
        version: 1,
        plugins: [{ id: pluginID, manifestURL }],
        revoked: []
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    fetchMock.route(manifestURL, {
      body: JSON.stringify(manifest),
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext());
    await plugins.initAsync();
    await plugins.startAsync();
    sinon.stub(plugins, '_loadPluginModule').callsFake(record => {
      const current = plugins._plugins.get(record.id);
      if (!current) return;
      current.module = {};
      current.enableFn = () => {};
      current.disableFn = () => {};
      current.disposeFn = () => {};
    });

    const before = plugins.getRegistryCatalog().find(d => d.id === pluginID);
    expect(before.installed).to.be.false;
    expect(before.tags).to.include('qa');

    await plugins.setRegistryPluginEnabled(pluginID, true);
    const afterEnable = plugins.getRegistryCatalog().find(d => d.id === pluginID);
    expect(afterEnable.installed).to.be.true;
    expect(afterEnable.enabled).to.be.true;

    await plugins.setRegistryPluginEnabled(pluginID, false);
    const afterDisable = plugins.getRegistryCatalog().find(d => d.id === pluginID);
    expect(afterDisable.enabled).to.be.false;
  });


  it('uses custom permission prompt handler with readable capability descriptions', async () => {
    const pluginID = 'permission-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const manifest = {
      version: 1,
      id: pluginID,
      name: 'Permission Plugin',
      description: 'Permission test plugin',
      pluginVersion: '1.0.0',
      kinds: ['ui'],
      capabilities: ['ui.toolbar', 'map.layers'],
      entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`
    };

    fetchMock.route(REGISTRY_URL, {
      body: {
        version: 1,
        plugins: [{ id: pluginID, manifestURL }],
        revoked: []
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    fetchMock.route(manifestURL, {
      body: JSON.stringify(manifest),
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext());
    await plugins.initAsync();
    await plugins.startAsync();
    await plugins.installFromRegistry(pluginID);
    sinon.stub(plugins, '_loadPluginModule').callsFake(record => {
      const current = plugins._plugins.get(record.id);
      if (!current) return;
      current.module = {};
      current.enableFn = () => {};
      current.disableFn = () => {};
      current.disposeFn = () => {};
    });

    const promptHandler = sinon.stub().resolves(true);
    plugins.setPermissionPromptHandler(promptHandler);

    await plugins.setPluginEnabled(pluginID, true);
    expect(promptHandler.calledOnce).to.be.true;

    const details = promptHandler.firstCall.args[0];
    expect(details.pluginID).to.eql(pluginID);
    expect(details.capabilities[0].label).to.eql('Toolbar controls');
    expect(details.capabilities[1].label).to.eql('Map layer control');

    const enabled = plugins.getRegistryPlugins().find(d => d.id === pluginID);
    expect(enabled.enabled).to.be.true;
  });


  it('waits for rapid startup before restoring enabled plugins', async () => {
    const pluginID = 'rapid-assist-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const rapid = new MockRapidSystem({ started: false });
    const storageState = {
      enabledPluginIDs: [pluginID],
      grantedCapabilities: { [pluginID]: [] },
      registryPlugins: [{
        id: pluginID,
        version: 1,
        name: 'Rapid Assist',
        description: 'Depends on rapid startup',
        pluginVersion: '1.0.0',
        kinds: ['ui'],
        tags: ['rapid'],
        capabilities: [],
        docsURL: '',
        usage: [],
        jaUsage: [],
        entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`,
        registryURL: REGISTRY_URL,
        manifestURL: manifestURL,
        manifestHash: '',
        signature: '',
        keyID: '',
        installedAt: '2026-01-01T00:00:00.000Z'
      }],
      registryURLs: [REGISTRY_URL],
      activeRegistryURL: REGISTRY_URL
    };

    fetchMock.route(REGISTRY_URL, {
      body: { version: 1, plugins: [], revoked: [] },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const plugins = new Rapid.PluginSystem(new MockContext({
      rapid: rapid,
      storage: { [PLUGIN_STATE_STORAGE_KEY]: JSON.stringify(storageState) }
    }));

    sinon.stub(plugins, '_loadPluginModule').callsFake(record => {
      const current = plugins._plugins.get(record.id);
      if (!current) return;
      current.module = {};
      current.enableFn = host => {
        if (!host.context.systems.rapid.started) {
          throw new Error('Rapid must be started before enabling plugin');
        }
      };
      current.disableFn = () => {};
      current.disposeFn = () => {};
    });

    await plugins.initAsync();
    await plugins.startAsync();

    const restored = plugins.getRegistryPlugins().find(d => d.id === pluginID);
    expect(rapid.startCalls).to.be.greaterThan(0);
    expect(restored?.enabled).to.be.true;
  });


  it('keeps enabled plugin preference when restore fails', async () => {
    const pluginID = 'flaky-plugin';
    const manifestURL = `https://registry.test/plugins/${pluginID}/manifest.json`;
    const storageState = {
      enabledPluginIDs: [pluginID],
      grantedCapabilities: { [pluginID]: [] },
      registryPlugins: [{
        id: pluginID,
        version: 1,
        name: 'Flaky Plugin',
        description: 'Fails during startup restore',
        pluginVersion: '1.0.0',
        kinds: ['ui'],
        tags: ['qa'],
        capabilities: [],
        docsURL: '',
        usage: [],
        jaUsage: [],
        entrypoint: `https://registry.test/plugins/${pluginID}/index.mjs`,
        registryURL: REGISTRY_URL,
        manifestURL: manifestURL,
        manifestHash: '',
        signature: '',
        keyID: '',
        installedAt: '2026-01-01T00:00:00.000Z'
      }],
      registryURLs: [REGISTRY_URL],
      activeRegistryURL: REGISTRY_URL
    };

    fetchMock.route(REGISTRY_URL, {
      body: { version: 1, plugins: [], revoked: [] },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    const context = new MockContext({
      storage: { [PLUGIN_STATE_STORAGE_KEY]: JSON.stringify(storageState) }
    });
    const plugins = new Rapid.PluginSystem(context);

    sinon.stub(plugins, '_loadPluginModule').callsFake(record => {
      const current = plugins._plugins.get(record.id);
      if (!current) return;
      current.module = {};
      current.enableFn = () => {
        throw new Error('startup failure');
      };
      current.disableFn = () => {};
      current.disposeFn = () => {};
    });

    await plugins.initAsync();
    await plugins.startAsync();

    const persisted = JSON.parse(context.systems.storage.getItem(PLUGIN_STATE_STORAGE_KEY));
    expect(persisted.enabledPluginIDs).to.include(pluginID);
  });
});
