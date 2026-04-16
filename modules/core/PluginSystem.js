import { AbstractSystem } from './AbstractSystem.js';
import { utilFetchResponse } from '../util/index.js';

const PLUGIN_STATE_STORAGE_KEY = 'rapid-plugin-state-v1';
const DEFAULT_PLUGIN_REGISTRY_URL = 'https://raw.githubusercontent.com/choko510/customRapid-plugin/main/registry.json';
const DEFAULT_TRUSTED_KEY_ID = 'rapid-official-2026';
const DEFAULT_TRUSTED_KEYS = new Map([
  [DEFAULT_TRUSTED_KEY_ID, {
    kty: 'EC',
    crv: 'P-256',
    x: 'LyMtwm8wVVMcYX_H3l5_RL7FYZnHNTOSdxaM43n9ta8',
    y: '5s2nUNGxNjkMMB2uvChR2CMHgrfp1fhVmyxFTfaojz4'
  }]
]);

const ALLOWED_PLUGIN_KINDS = new Set(['data', 'ui', 'operation']);


/**
 * `PluginSystem`
 * Manages plugin lifecycle (install/enable/disable/uninstall), registry loading,
 * signature verification (when metadata is provided), extension point registration,
 * permission prompts, and revocation handling.
 *
 * Events:
 *  `pluginschange`  Fired whenever plugin state or plugin contributions change.
 */
export class PluginSystem extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'plugins';
    this.dependencies = new Set(['l10n', 'storage', 'urlhash']);

    this._plugins = new Map();          // Map(pluginID -> record)
    this._commands = new Map();         // Map(commandID -> command contribution)
    this._toolbarButtons = new Map();   // Map(buttonID -> toolbar contribution)
    this._trustedKeys = new Map(DEFAULT_TRUSTED_KEYS);

    this._registryURLs = [DEFAULT_PLUGIN_REGISTRY_URL];
    this._activeRegistryURL = DEFAULT_PLUGIN_REGISTRY_URL;
    this._registryEntries = new Map();  // Map(pluginID -> registry entry)
    this._registryCatalog = new Map();  // Map(pluginID -> catalog metadata)
    this._revokedPlugins = new Map();   // Map(pluginID -> revoke message)
    this._registryError = null;
    this._registryFetchedAt = null;

    this._enabledFromStorage = new Set();
    this._grantedFromStorage = new Map();   // Map(pluginID -> Set(capability))
    this._verifiedThisSession = new Set();
    this._permissionPromptHandler = null;

    this._initPromise = null;
    this._startPromise = null;
  }


  /**
   * initAsync
   * @return {Promise}
   */
  initAsync() {
    if (this._initPromise) return this._initPromise;

    for (const id of this.dependencies) {
      if (!this.context.systems[id]) {
        return Promise.reject(`Cannot init:  ${this.id} requires ${id}`);
      }
    }

    const context = this.context;
    const l10n = context.systems.l10n;
    const storage = context.systems.storage;
    const urlhash = context.systems.urlhash;

    const prereq = Promise.all([
      l10n.initAsync(),
      storage.initAsync(),
      urlhash.initAsync()
    ]);

    return this._initPromise = prereq
      .then(() => {
        this._restorePluginState();

        const configuredRegistry = urlhash.getParam('plugin_registry');
        if (configuredRegistry && this._isValidURL(configuredRegistry)) {
          if (!this._registryURLs.includes(configuredRegistry)) {
            this._registryURLs.push(configuredRegistry);
          }
          this._activeRegistryURL = configuredRegistry;
        }
      });
  }


  /**
   * startAsync
   * @return {Promise}
   */
  startAsync() {
    if (this._startPromise) return this._startPromise;

    return this._startPromise = Promise.resolve()
      .then(() => this.refreshRegistryAsync({ silent: true }).catch(err => {
        this._registryError = err.message;
      }))
      .then(() => this._restoreEnabledPlugins())
      .then(() => {
        this._started = true;
        this.emit('pluginschange');
      });
  }


  /**
   * resetAsync
   * @return {Promise}
   */
  async resetAsync() {
    const enabledPlugins = Array.from(this._plugins.values()).filter(plugin => plugin.enabled);
    const results = await Promise.allSettled(enabledPlugins.map(plugin => this._disablePluginRecord(plugin, { quiet: true })));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this._notify(`Plugin "${enabledPlugins[index].id}" could not be disabled: ${result.reason?.message || result.reason}`, 'error');
      }
    }
    this._commands.clear();
    this._toolbarButtons.clear();
    this._verifiedThisSession.clear();
    this.emit('pluginschange');
    return Promise.resolve();
  }


  /**
   * Sets trusted verification keys. Intended for deployment or tests.
   * @param   {Object|Map} keysByID
   * @return  {PluginSystem}
   */
  setTrustedPublicKeys(keysByID) {
    const next = new Map();
    const entries = keysByID instanceof Map ? keysByID.entries() : Object.entries(keysByID ?? {});
    for (const [keyID, jwk] of entries) {
      if (!keyID || !jwk) continue;
      next.set(keyID, jwk);
    }
    this._trustedKeys = next;
    return this;
  }


  /**
   * Sets a custom permission prompt handler used when enabling plugins.
   * @param   {Function|null} handler
   * @return  {PluginSystem}
   */
  setPermissionPromptHandler(handler) {
    this._permissionPromptHandler = (typeof handler === 'function') ? handler : null;
    return this;
  }


  /**
   * @return {Array<Object>}
   */
  getPlugins() {
    return this._collectPublicPlugins();
  }


  /**
   * @return {Array<Object>}
   */
  getBundledPlugins() {
    return this._collectPublicPlugins('bundled');
  }


  /**
   * @return {Array<Object>}
   */
  getRegistryPlugins() {
    return this._collectPublicPlugins('registry');
  }


  /**
   * @return {Array<Object>}
   */
  getRegistryCatalog() {
    const installedPlugins = new Map(
      this._collectPublicPlugins('registry', false).map(plugin => [plugin.id, plugin])
    );
    const ids = new Set([
      ...this._registryEntries.keys(),
      ...this._registryCatalog.keys(),
      ...installedPlugins.keys()
    ]);

    const rows = [];
    for (const id of ids) {
      const catalog = this._registryCatalog.get(id) ?? {};
      const installed = installedPlugins.get(id);
      const kinds = installed?.kinds?.length ? installed.kinds : (catalog.kinds ?? []);
      const tags = installed?.tags?.length
        ? installed.tags
        : ((catalog.tags?.length ? catalog.tags : kinds) ?? []);
      const revokedMessage = this._revokedPlugins.get(id) || installed?.revocationMessage || null;

      rows.push({
        id: id,
        source: 'registry',
        name: this._localizedPluginText(installed?.name || catalog.name || id, installed?.jaName || catalog.jaName),
        description: this._localizedPluginText(installed?.description || catalog.description || '', installed?.jaDescription || catalog.jaDescription),
        pluginVersion: installed?.pluginVersion || catalog.pluginVersion || '1.0.0',
        kinds: [...kinds],
        tags: [...tags],
        capabilities: installed?.capabilities?.length ? installed.capabilities : (catalog.capabilities ?? []),
        registryURL: installed?.registryURL || catalog.registryURL || this._activeRegistryURL,
        installed: Boolean(installed),
        enabled: Boolean(installed?.enabled),
        trusted: (installed?.trusted ?? catalog.trusted) ?? false,
        revoked: Boolean(revokedMessage),
        revocationMessage: revokedMessage
      });
    }

    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }


  _collectPublicPlugins(source = null, sortByName = true) {
    const rows = [];
    for (const record of this._plugins.values()) {
      if (source && record.source !== source) continue;
      rows.push(this._toPublicPlugin(record));
    }

    if (sortByName) {
      rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    return rows;
  }


  /**
   * @return {Array<Object>}
   */
  getCommands() {
    return Array.from(this._commands.values()).map(d => ({
      id: d.id,
      label: d.label,
      keywords: d.keywords,
      shortcut: d.shortcut,
      run: d.run
    }));
  }


  /**
   * @return {Array<Object>}
   */
  getToolbarButtons() {
    return Array.from(this._toolbarButtons.values()).map(d => ({
      id: d.id,
      label: d.label,
      title: d.title,
      run: d.run
    }));
  }


  /**
   * @return {Object}
   */
  getRegistryState() {
    return {
      url: this._activeRegistryURL,
      activeURL: this._activeRegistryURL,
      registries: [...this._registryURLs],
      fetchedAt: this._registryFetchedAt,
      error: this._registryError
    };
  }


  /**
   * addRegistry
   * @param   {string} registryURL
   * @param   {Object} options
   * @return  {Object}
   */
  addRegistry(registryURL, options = {}) {
    const { setActive = true, persist = true } = options;
    const url = this._cleanString(registryURL);
    if (!this._isValidURL(url)) {
      throw new Error('Registry URL must be a valid absolute URL');
    }

    if (!this._registryURLs.includes(url)) {
      this._registryURLs.push(url);
    }

    if (setActive) {
      this._activeRegistryURL = url;
    }

    if (persist) {
      this._rememberPluginState();
      this.emit('pluginschange');
    }

    return this.getRegistryState();
  }


  /**
   * removeRegistry
   * @param   {string} registryURL
   * @return  {Object}
   */
  removeRegistry(registryURL) {
    const url = this._cleanString(registryURL);
    if (!url) throw new Error('Registry URL is required');
    if (this._registryURLs.length <= 1) {
      throw new Error('At least one registry must remain configured');
    }

    const index = this._registryURLs.indexOf(url);
    if (index === -1) {
      throw new Error('Registry URL is not configured');
    }

    this._registryURLs.splice(index, 1);
    if (this._activeRegistryURL === url) {
      this._activeRegistryURL = this._registryURLs[0];
      this._registryEntries = new Map();
      this._registryCatalog = new Map();
      this._revokedPlugins = new Map();
      this._registryError = null;
      this._registryFetchedAt = null;
    }

    this._rememberPluginState();
    this.emit('pluginschange');
    return this.getRegistryState();
  }


  /**
   * setActiveRegistry
   * @param   {string} registryURL
   * @return  {Object}
   */
  setActiveRegistry(registryURL) {
    const url = this._cleanString(registryURL);
    if (!url) throw new Error('Registry URL is required');
    if (!this._registryURLs.includes(url)) {
      throw new Error('Registry URL is not configured');
    }

    if (this._activeRegistryURL !== url) {
      this._activeRegistryURL = url;
      this._registryEntries = new Map();
      this._registryCatalog = new Map();
      this._revokedPlugins = new Map();
      this._registryError = null;
      this._registryFetchedAt = null;
      this._rememberPluginState();
      this.emit('pluginschange');
    }

    return this.getRegistryState();
  }


  /**
   * refreshRegistryAsync
   * @param   {Object} options
   * @return  {Promise<Object>}
   */
  async refreshRegistryAsync(options = {}) {
    const { silent = false, registryURL } = options;
    const url = this._cleanString(registryURL) || this._activeRegistryURL;
    if (!this._isValidURL(url)) {
      throw new Error('Registry URL must be a valid absolute URL');
    }

    if (url !== this._activeRegistryURL) {
      this.setActiveRegistry(url);
    }

    try {
      const raw = await fetch(this._activeRegistryURL).then(utilFetchResponse);
      const payload = this._normalizeRegistryPayload(raw);
      const nextEntries = this._normalizeRegistryEntries(payload?.plugins ?? [], this._activeRegistryURL);
      const nextRevoked = this._normalizeRevocations(payload?.revoked ?? []);

      this._registryEntries = nextEntries;
      await this._refreshRegistryCatalog(nextEntries);
      this._revokedPlugins = nextRevoked;
      this._registryFetchedAt = new Date().toISOString();
      this._registryError = null;

      await this._applyRevocations();
      this._rememberPluginState();
      this.emit('pluginschange');

      return {
        url: this._activeRegistryURL,
        fetchedAt: this._registryFetchedAt,
        entries: this._registryEntries.size,
        revoked: this._revokedPlugins.size
      };
    } catch (err) {
      this._registryError = err.message;
      if (!silent) {
        this.emit('pluginschange');
      }
      throw err;
    }
  }


  /**
   * installFromRegistry
   * @param   {string} pluginID
   * @param   {Object} options
   * @return  {Promise<Object>}
   */
  async installFromRegistry(pluginID, options = {}) {
    const id = this._cleanString(pluginID);
    const registryURL = this._cleanString(options?.registryURL) || this._activeRegistryURL;
    if (!id) throw new Error('Plugin ID is required');
    if (!this._isValidURL(registryURL)) throw new Error('Registry URL must be a valid absolute URL');

    if (registryURL !== this._activeRegistryURL || !this._registryEntries.size) {
      if (registryURL !== this._activeRegistryURL) {
        this.setActiveRegistry(registryURL);
      }
      await this.refreshRegistryAsync({ registryURL: this._activeRegistryURL });
    }

    const entry = this._registryEntries.get(id);
    if (!entry) throw new Error(`Plugin "${id}" was not found in the selected registry`);
    if (this._revokedPlugins.has(id)) throw new Error(`Plugin "${id}" has been revoked and cannot be installed`);

    const record = await this._createRegistryPluginRecord(entry);
    const existing = this._plugins.get(id);
    if (existing?.enabled) {
      await this._disablePluginRecord(existing, { quiet: true });
    }

    record.grantedCapabilities = existing?.grantedCapabilities ?? this._grantedFromStorage.get(id) ?? new Set();
    this._plugins.set(id, record);
    this._rememberPluginState();
    this.emit('pluginschange');
    return this._toPublicPlugin(record);
  }


  /**
   * setRegistryPluginEnabled
   * Enables/disables a registry plugin from catalog. Enabling installs if needed.
   * @param   {string} pluginID
   * @param   {boolean} enabled
   * @param   {Object} options
   * @return  {Promise<Object|null>}
   */
  async setRegistryPluginEnabled(pluginID, enabled = true, options = {}) {
    const id = this._cleanString(pluginID);
    if (!id) throw new Error('Plugin ID is required');

    const shouldEnable = Boolean(enabled);
    if (shouldEnable) {
      if (!this._plugins.has(id)) {
        await this.installFromRegistry(id, options);
      }
      return this.setPluginEnabled(id, true, options);
    }

    if (!this._plugins.has(id)) return null;
    return this.setPluginEnabled(id, false, options);
  }


  /**
   * uninstallPlugin
   * @param   {string} pluginID
   * @return  {Promise<void>}
   */
  async uninstallPlugin(pluginID) {
    const id = this._cleanString(pluginID);
    const record = this._plugins.get(id);
    if (!record) throw new Error(`Plugin "${id}" is not installed`);
    if (record.source === 'bundled') throw new Error('Bundled plugins cannot be uninstalled');

    if (record.enabled) {
      await this._disablePluginRecord(record, { quiet: true });
    }

    this._plugins.delete(id);
    this._grantedFromStorage.delete(id);
    this._enabledFromStorage.delete(id);
    this._verifiedThisSession.delete(id);
    this._rememberPluginState();
    this.emit('pluginschange');
  }


  /**
   * setPluginEnabled
   * @param   {string} pluginID
   * @param   {boolean} enabled
   * @param   {Object} options
   * @return  {Promise<Object>}
   */
  async setPluginEnabled(pluginID, enabled = true, options = {}) {
    const id = this._cleanString(pluginID);
    const record = this._plugins.get(id);
    if (!record) throw new Error(`Plugin "${id}" is not installed`);

    const shouldEnable = Boolean(enabled);
    if (shouldEnable) {
      if (record.revoked) {
        throw new Error(`Plugin "${record.id}" has been revoked and cannot be enabled`);
      }

      if (record.source === 'registry') {
        await this._verifyRegistryPluginRecord(record);
      }

      const granted = await this._ensureCapabilitiesGranted(record, options);
      if (!granted) {
        throw new Error('Permission request was denied');
      }

      await this._enablePluginRecord(record);
      this._enabledFromStorage.add(record.id);
    } else {
      await this._disablePluginRecord(record, options);
      this._enabledFromStorage.delete(record.id);
    }

    this._rememberPluginState();
    this.emit('pluginschange');
    return this._toPublicPlugin(record);
  }


  _restorePluginState() {
    const storage = this.context.systems.storage;
    const raw = storage?.getItem(PLUGIN_STATE_STORAGE_KEY);
    if (!raw) return;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const enabledPluginIDs = Array.isArray(parsed?.enabledPluginIDs) ? parsed.enabledPluginIDs : [];
    this._enabledFromStorage = new Set(enabledPluginIDs.filter(id => typeof id === 'string' && id.length));

    const grantedCapabilities = parsed?.grantedCapabilities ?? {};
    this._grantedFromStorage = new Map();
    for (const [pluginID, capabilities] of Object.entries(grantedCapabilities)) {
      if (!Array.isArray(capabilities)) continue;
      this._grantedFromStorage.set(pluginID, new Set(capabilities.filter(cap => typeof cap === 'string' && cap.length)));
    }

    const registryURLs = Array.isArray(parsed?.registryURLs)
      ? parsed.registryURLs.map(url => this._cleanString(url)).filter(url => this._isValidURL(url))
      : [];

    if (registryURLs.length) {
      this._registryURLs = [...new Set(registryURLs)];
    } else {
      this._registryURLs = [DEFAULT_PLUGIN_REGISTRY_URL];
    }

    const activeRegistryURL = this._cleanString(parsed?.activeRegistryURL);
    this._activeRegistryURL = this._registryURLs.includes(activeRegistryURL)
      ? activeRegistryURL
      : this._registryURLs[0];

    const registryPlugins = Array.isArray(parsed?.registryPlugins) ? parsed.registryPlugins : [];
    for (const stored of registryPlugins) {
      try {
        const manifest = this._normalizePluginManifest({
          version: stored?.version,
          id: stored?.id,
          name: stored?.name,
          'ja-name': stored?.jaName,
          description: stored?.description,
          'ja-description': stored?.jaDescription,
          pluginVersion: stored?.pluginVersion,
          kinds: stored?.kinds,
          tags: stored?.tags,
          capabilities: stored?.capabilities,
          entrypoint: stored?.entrypoint
        }, 'registry');

        const record = {
          id: manifest.id,
          source: 'registry',
          trusted: Boolean(this._cleanString(stored?.signature) && this._cleanString(stored?.keyID)),
          enabled: false,
          revoked: false,
          revocationMessage: null,
          installedAt: stored?.installedAt || null,
          registryURL: this._cleanString(stored?.registryURL) || this._activeRegistryURL,
          manifestURL: this._cleanString(stored?.manifestURL),
          manifestHash: this._cleanString(stored?.manifestHash),
          signature: this._cleanString(stored?.signature),
          keyID: this._cleanString(stored?.keyID),
          manifest: manifest,
          module: null,
          enableFn: null,
          disableFn: null,
          disposeFn: null,
          grantedCapabilities: this._grantedFromStorage.get(manifest.id) ?? new Set()
        };

        if (!record.manifestURL) {
          continue;
        }

        this._plugins.set(manifest.id, record);
      } catch {
        continue;  // skip invalid stored plugin records
      }
    }

    for (const record of this._plugins.values()) {
      record.grantedCapabilities = this._grantedFromStorage.get(record.id) ?? new Set();
    }
  }


  async _restoreEnabledPlugins() {
    const ids = Array.from(this._enabledFromStorage);
    await Promise.all(ids.map(async pluginID => {
      let record = this._plugins.get(pluginID);
      if (!record) {
        const entry = this._registryEntries.get(pluginID);
        if (entry) {
          try {
            record = await this._createRegistryPluginRecord(entry);
            record.grantedCapabilities = this._grantedFromStorage.get(pluginID) ?? new Set();
            this._plugins.set(pluginID, record);
          } catch (err) {
            this._enabledFromStorage.delete(pluginID);
            this._notify(`Plugin "${pluginID}" could not be migrated from registry: ${err.message}`, 'error');
            return;
          }
        } else {
          this._enabledFromStorage.delete(pluginID);
          return;
        }
      }

      if (record.revoked) {
        this._enabledFromStorage.delete(pluginID);
        return;
      }

      try {
        await this.setPluginEnabled(pluginID, true, { skipPermissionPrompt: true, quiet: true });
      } catch (err) {
        this._enabledFromStorage.delete(pluginID);
        this._notify(`Plugin "${pluginID}" could not be enabled: ${err.message}`, 'error');
      }
    }));
    this._rememberPluginState();
  }


  _rememberPluginState() {
    const storage = this.context.systems.storage;
    if (!storage) return;

    const enabledPluginIDs = [];
    const grantedCapabilities = {};
    const registryPlugins = [];

    for (const record of this._plugins.values()) {
      if (record.enabled) {
        enabledPluginIDs.push(record.id);
      }

      if (record.grantedCapabilities?.size) {
        grantedCapabilities[record.id] = [...record.grantedCapabilities];
      }

      if (record.source === 'registry') {
        registryPlugins.push({
          id: record.id,
          version: record.manifest.version,
          name: record.manifest.name,
          jaName: record.manifest.jaName,
          description: record.manifest.description,
          jaDescription: record.manifest.jaDescription,
          pluginVersion: record.manifest.pluginVersion,
          kinds: [...record.manifest.kinds],
          tags: [...record.manifest.tags],
          capabilities: [...record.manifest.capabilities],
          entrypoint: record.manifest.entrypoint,
          registryURL: record.registryURL,
          manifestURL: record.manifestURL,
          manifestHash: record.manifestHash,
          signature: record.signature,
          keyID: record.keyID,
          installedAt: record.installedAt
        });
      }
    }

    storage.setItem(PLUGIN_STATE_STORAGE_KEY, JSON.stringify({
      enabledPluginIDs,
      grantedCapabilities,
      registryPlugins,
      registryURLs: [...this._registryURLs],
      activeRegistryURL: this._activeRegistryURL
    }));
  }


  async _createRegistryPluginRecord(entry) {
    const response = await fetch(entry.manifestURL);
    if (!response.ok) throw new Error(`Could not fetch manifest for plugin "${entry.id}"`);
    const manifestText = await response.text();
    const manifestHash = await this._sha256Base64(this._stringToBytes(manifestText));
    if (entry.manifestHash && manifestHash !== entry.manifestHash) {
      throw new Error(`Manifest integrity check failed for plugin "${entry.id}"`);
    }

    const expectedManifestHash = entry.manifestHash || manifestHash;
    let trusted = false;
    if (entry.signature && entry.keyID) {
      const signedData = this._buildSignaturePayload(entry.id, entry.manifestURL, expectedManifestHash);
      const verified = await this._verifySignature(signedData, entry.signature, entry.keyID);
      if (!verified) {
        throw new Error(`Signature verification failed for plugin "${entry.id}"`);
      }
      trusted = true;
    }

    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestText);
    } catch {
      throw new Error(`Manifest JSON is invalid for plugin "${entry.id}"`);
    }

    const manifest = this._normalizePluginManifest(parsedManifest, 'registry');
    if (manifest.id !== entry.id) {
      throw new Error(`Manifest ID mismatch for plugin "${entry.id}"`);
    }

    return {
      id: manifest.id,
      source: 'registry',
      trusted: trusted,
      enabled: false,
      revoked: false,
      revocationMessage: null,
      installedAt: new Date().toISOString(),
      registryURL: entry.registryURL || this._activeRegistryURL,
      manifestURL: entry.manifestURL,
      manifestHash: expectedManifestHash,
      signature: entry.signature || null,
      keyID: entry.keyID || null,
      manifest: manifest,
      module: null,
      enableFn: null,
      disableFn: null,
      disposeFn: null,
      grantedCapabilities: new Set()
    };
  }


  async _verifyRegistryPluginRecord(record) {
    if (record.source !== 'registry') return true;
    if (this._verifiedThisSession.has(record.id)) return true;

    if (!record.manifestURL) {
      throw new Error(`Plugin "${record.id}" is missing manifest metadata`);
    }

    if (!record.manifestHash || !record.signature || !record.keyID) {
      return true;
    }

    const response = await fetch(record.manifestURL);
    if (!response.ok) throw new Error(`Could not fetch manifest for plugin "${record.id}"`);
    const manifestText = await response.text();
    const manifestHash = await this._sha256Base64(this._stringToBytes(manifestText));
    if (manifestHash !== record.manifestHash) {
      throw new Error(`Manifest integrity check failed for plugin "${record.id}"`);
    }

    const signedData = this._buildSignaturePayload(record.id, record.manifestURL, record.manifestHash);
    const verified = await this._verifySignature(signedData, record.signature, record.keyID);
    if (!verified) {
      throw new Error(`Signature verification failed for plugin "${record.id}"`);
    }

    this._verifiedThisSession.add(record.id);
    return true;
  }


  async _enablePluginRecord(record) {
    if (record.enabled) return;
    const pluginID = record.id;
    await this._loadPluginModule(record);
    const current = this._plugins.get(pluginID);
    if (!current) return;

    const host = this._createHostAPI(current);
    if (typeof current.enableFn === 'function') {
      await current.enableFn(host, current.manifest);
    }
    current.enabled = true;
  }


  async _disablePluginRecord(record, options = {}) {
    if (!record.enabled) return;
    const pluginID = record.id;
    const { quiet = false } = options;

    if (typeof record.disableFn === 'function') {
      await record.disableFn(this._createHostAPI(record), record.manifest);
    }

    this._removeContributions(pluginID);
    const current = this._plugins.get(pluginID);
    if (current) {
      current.enabled = false;
    }

    if (!quiet) {
      this.emit('pluginschange');
    }
  }


  async _loadPluginModule(record) {
    if (record.module) return;
    let loadedModule;
    if (record.source === 'registry') {
      loadedModule = await this._loadRegistryModule(record.manifest.entrypoint);
    } else {
      throw new Error(`Unsupported plugin source "${record.source}"`);
    }

    const defaultExport = loadedModule?.default;
    const enableFn = this._pickEnableFn(loadedModule, defaultExport);
    const disableFn = this._pickDisableFn(loadedModule, defaultExport);
    const disposeFn = this._pickDisposeFn(loadedModule, defaultExport);

    if (!enableFn) {
      throw new Error(`Plugin "${record.id}" does not export an enable function`);
    }

    const current = this._plugins.get(record.id);
    if (!current) return;
    current.module = loadedModule;
    current.enableFn = enableFn;
    current.disableFn = disableFn;
    current.disposeFn = disposeFn;
  }


  async _loadRegistryModule(entrypointURL) {
    let url;
    try {
      url = new URL(entrypointURL);
    } catch {
      throw new Error(`Plugin entrypoint URL is invalid: ${entrypointURL}`);
    }

    // raw.githubusercontent.com serves .mjs as text/plain, so import() fails MIME checks.
    // Use fetch+blob import directly to avoid noisy console errors and failed toggles.
    if (url.hostname === 'raw.githubusercontent.com') {
      return this._loadRegistryModuleFromFetch(entrypointURL);
    }

    try {
      return await import(entrypointURL);
    } catch (importErr) {
      return this._loadRegistryModuleFromFetch(entrypointURL, importErr);
    }
  }


  async _loadRegistryModuleFromFetch(entrypointURL, importErr = null) {
    try {
      const response = await fetch(entrypointURL);
      if (!response.ok) {
        throw new Error(`Could not fetch plugin module: ${response.status} ${response.statusText}`);
      }

      const moduleCode = await response.text();
      const blob = new Blob([moduleCode], { type: 'text/javascript' });
      const blobURL = URL.createObjectURL(blob);
      try {
        return await import(blobURL);
      } finally {
        URL.revokeObjectURL(blobURL);
      }
    } catch (fallbackErr) {
      if (importErr) {
        throw new Error(`${importErr.message} (fallback failed: ${fallbackErr.message})`);
      }
      throw fallbackErr;
    }
  }


  _pickEnableFn(mod, defaultExport) {
    if (typeof mod?.enable === 'function') return mod.enable;
    if (typeof defaultExport === 'function') return defaultExport;
    if (typeof defaultExport?.enable === 'function') return defaultExport.enable;
    return null;
  }


  _pickDisableFn(mod, defaultExport) {
    if (typeof mod?.disable === 'function') return mod.disable;
    if (typeof defaultExport?.disable === 'function') return defaultExport.disable;
    return null;
  }


  _pickDisposeFn(mod, defaultExport) {
    if (typeof mod?.dispose === 'function') return mod.dispose;
    if (typeof defaultExport?.dispose === 'function') return defaultExport.dispose;
    return null;
  }


  _createHostAPI(record) {
    const context = this.context;
    const l10n = context.systems.l10n;

    return {
      context: context,
      manifest: record.manifest,
      t: (stringID, replacements) => l10n.t(stringID, replacements),

      registerCommand: spec => this._registerCommand(record.id, spec),
      registerOperation: spec => this._registerCommand(record.id, spec),
      registerToolbarButton: spec => this._registerToolbarButton(record.id, spec),

      registerDatasetManifest: manifest => {
        const rapid = context.systems.rapid;
        if (!rapid) throw new Error('Rapid system is unavailable');
        return rapid.importExternalManifest(manifest);
      },

      notify: (message, kind = 'info') => this._notify(message, kind)
    };
  }


  _registerCommand(pluginID, spec = {}) {
    const localID = this._cleanString(spec.id);
    const label = this._cleanString(spec.label);
    const run = spec.run;
    if (!localID) throw new Error(`Plugin "${pluginID}" command is missing an id`);
    if (!label) throw new Error(`Plugin "${pluginID}" command "${localID}" is missing a label`);
    if (typeof run !== 'function') throw new Error(`Plugin "${pluginID}" command "${localID}" is missing a run callback`);

    const fullID = `${pluginID}/${localID}`;
    this._commands.set(fullID, {
      id: fullID,
      pluginID: pluginID,
      label: label,
      keywords: this._cleanString(spec.keywords),
      shortcut: spec.shortcut || '',
      run: run
    });
    this.emit('pluginschange');
    return () => {
      this._commands.delete(fullID);
      this.emit('pluginschange');
    };
  }


  _registerToolbarButton(pluginID, spec = {}) {
    const localID = this._cleanString(spec.id);
    const label = this._cleanString(spec.label);
    const run = spec.run;
    if (!localID) throw new Error(`Plugin "${pluginID}" toolbar button is missing an id`);
    if (!label) throw new Error(`Plugin "${pluginID}" toolbar button "${localID}" is missing a label`);
    if (typeof run !== 'function') throw new Error(`Plugin "${pluginID}" toolbar button "${localID}" is missing a run callback`);

    const fullID = `${pluginID}/${localID}`;
    this._toolbarButtons.set(fullID, {
      id: fullID,
      pluginID: pluginID,
      label: label,
      title: this._cleanString(spec.title) || label,
      run: run
    });
    this.emit('pluginschange');
    return () => {
      this._toolbarButtons.delete(fullID);
      this.emit('pluginschange');
    };
  }


  _removeContributions(pluginID) {
    for (const [id, entry] of this._commands) {
      if (entry.pluginID === pluginID) {
        this._commands.delete(id);
      }
    }
    for (const [id, entry] of this._toolbarButtons) {
      if (entry.pluginID === pluginID) {
        this._toolbarButtons.delete(id);
      }
    }
  }


  async _ensureCapabilitiesGranted(record, options = {}) {
    const { skipPermissionPrompt = false } = options;
    const required = new Set(record.manifest.capabilities);
    const granted = record.grantedCapabilities ?? new Set();

    const missing = [];
    for (const capability of required) {
      if (!granted.has(capability)) {
        missing.push(capability);
      }
    }

    if (!missing.length) return true;
    if (skipPermissionPrompt) {
      for (const cap of missing) {
        granted.add(cap);
      }
      record.grantedCapabilities = granted;
      return true;
    }

    const capabilities = missing.map(capability => this._describeCapability(capability));
    const l10n = this.context.systems.l10n;
    let accepted;

    if (typeof this._permissionPromptHandler === 'function') {
      const pluginName = this._localizedPluginText(record.manifest.name, record.manifest.jaName);
      accepted = await this._permissionPromptHandler({
        pluginID: record.id,
        pluginName: pluginName,
        capabilities: capabilities
      });
    } else {
      const pluginName = this._localizedPluginText(record.manifest.name, record.manifest.jaName);
      const summary = capabilities
        .map(item => `${item.label}: ${item.description}`)
        .join('\n');

      const message = l10n.t('plugin_manager.permissions.prompt', {
        name: pluginName,
        capabilities: summary
      });
      accepted = window.confirm(message);
    }

    if (!accepted) return false;

    for (const cap of missing) {
      granted.add(cap);
    }
    record.grantedCapabilities = granted;
    this._grantedFromStorage.set(record.id, granted);
    return true;
  }


  async _applyRevocations() {
    const records = Array.from(this._plugins.values());
    const results = await Promise.allSettled(records.map(async record => {
      const message = this._revokedPlugins.get(record.id) || null;
      const wasRevoked = record.revoked;
      record.revoked = Boolean(message);
      record.revocationMessage = message;

      if (record.revoked && record.enabled) {
        await this._disablePluginRecord(record, { quiet: true });
        this._enabledFromStorage.delete(record.id);
        this._notify(
          this.context.systems.l10n.t('plugin_manager.revoked_notice', {
            name: this._localizedPluginText(record.manifest.name, record.manifest.jaName)
          }),
          'error'
        );
      }

      if (!record.revoked && wasRevoked) {
        record.revocationMessage = null;
      }
    }));
    for (const result of results) {
      if (result.status === 'rejected') {
        this._notify(result.reason?.message || String(result.reason), 'error');
      }
    }
  }


  _normalizeRegistryEntries(entries, registryURL = '') {
    const next = new Map();
    for (const entry of entries) {
      const id = this._cleanString(entry?.id);
      const manifestURL = this._cleanString(entry?.manifestURL);
      const manifestHash = this._cleanString(entry?.manifestHash);
      const signature = this._cleanString(entry?.signature);
      const keyID = this._cleanString(entry?.keyID);

      if (!id || !manifestURL) continue;
      if (!this._isValidURL(manifestURL)) continue;

      next.set(id, {
        id: id,
        registryURL: this._cleanString(registryURL) || this._activeRegistryURL,
        manifestURL: manifestURL,
        manifestHash: manifestHash || null,
        signature: signature || null,
        keyID: keyID || null,
        name: this._cleanString(entry?.name) || id,
        jaName: this._cleanString(entry?.['ja-name']),
        description: this._cleanString(entry?.description),
        jaDescription: this._cleanString(entry?.['ja-description']),
        pluginVersion: this._cleanString(entry?.pluginVersion || entry?.versionName || '1.0.0'),
        kinds: this._cleanStringArray(entry?.kinds).filter(kind => ALLOWED_PLUGIN_KINDS.has(kind)),
        tags: this._cleanStringArray(entry?.tags),
        capabilities: this._cleanStringArray(entry?.capabilities)
      });
    }
    return next;
  }


  _normalizeRegistryPayload(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw;
    }

    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Registry payload must be a JSON object');
        }
        return parsed;
      } catch (err) {
        throw new Error(`Registry payload is not valid JSON: ${err.message}`);
      }
    }

    throw new Error('Registry payload has an unsupported format');
  }


  async _refreshRegistryCatalog(entries = this._registryEntries) {
    const nextCatalog = new Map();

    await Promise.all(Array.from(entries.values()).map(async entry => {
      const catalog = {
        id: entry.id,
        registryURL: entry.registryURL || this._activeRegistryURL,
        name: entry.name || entry.id,
        jaName: entry.jaName || '',
        description: entry.description || '',
        jaDescription: entry.jaDescription || '',
        pluginVersion: entry.pluginVersion || '1.0.0',
        kinds: [...(entry.kinds ?? [])],
        tags: [...(entry.tags ?? [])],
        capabilities: [...(entry.capabilities ?? [])],
        trusted: Boolean(entry.manifestHash && entry.signature && entry.keyID)
      };

      try {
        const response = await fetch(entry.manifestURL);
        if (response.ok) {
          const manifestText = await response.text();
          const parsedManifest = JSON.parse(manifestText);
          const manifest = this._normalizePluginManifest(parsedManifest, 'registry');
          catalog.name = manifest.name;
          catalog.jaName = manifest.jaName;
          catalog.description = manifest.description;
          catalog.jaDescription = manifest.jaDescription;
          catalog.pluginVersion = manifest.pluginVersion;
          catalog.kinds = [...manifest.kinds];
          catalog.tags = [...manifest.tags];
          catalog.capabilities = [...manifest.capabilities];
        }
      } catch {
        // Keep fallback metadata from registry entry
      }

      nextCatalog.set(entry.id, catalog);
    }));

    this._registryCatalog = nextCatalog;
  }


  _normalizeRevocations(entries) {
    const next = new Map();
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const id = this._cleanString(entry);
        if (!id) continue;
        next.set(id, 'Revoked by plugin registry');
        continue;
      }

      const id = this._cleanString(entry?.id);
      if (!id) continue;
      const message = this._cleanString(entry?.message) || this._cleanString(entry?.reason) || 'Revoked by plugin registry';
      next.set(id, message);
    }
    return next;
  }


  _normalizePluginManifest(raw, source) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Plugin manifest must be an object');
    }

    const id = this._cleanString(raw.id);
    const name = this._cleanString(raw.name);
    const jaName = this._cleanString(raw['ja-name']);
    const description = this._cleanString(raw.description);
    const jaDescription = this._cleanString(raw['ja-description']);
    const pluginVersion = this._cleanString(raw.pluginVersion || raw.versionName || '1.0.0');
    const kinds = new Set((Array.isArray(raw.kinds) ? raw.kinds : ['ui']).map(kind => this._cleanString(kind)).filter(Boolean));
    const tags = new Set((Array.isArray(raw.tags) ? raw.tags : [...kinds]).map(tag => this._cleanString(tag)).filter(Boolean));
    const capabilities = new Set((Array.isArray(raw.capabilities) ? raw.capabilities : []).map(cap => this._cleanString(cap)).filter(Boolean));

    if (!id) throw new Error('Plugin manifest is missing "id"');
    if (!name) throw new Error(`Plugin "${id}" is missing "name"`);
    if (!kinds.size) throw new Error(`Plugin "${id}" has no kinds`);

    for (const kind of kinds) {
      if (!ALLOWED_PLUGIN_KINDS.has(kind)) {
        throw new Error(`Plugin "${id}" has unsupported kind "${kind}"`);
      }
    }

    let entrypoint = this._cleanString(raw.entrypoint);
    if (source === 'registry') {
      if (!entrypoint || !this._isValidURL(entrypoint)) {
        throw new Error(`Plugin "${id}" manifest is missing a valid "entrypoint" URL`);
      }
    } else {
      entrypoint = entrypoint || '';
    }

    return {
      version: Number(raw.version) || 1,
      id: id,
      name: name,
      jaName: jaName,
      description: description,
      jaDescription: jaDescription,
      pluginVersion: pluginVersion,
      kinds: kinds,
      tags: tags,
      capabilities: capabilities,
      entrypoint: entrypoint
    };
  }


  _toPublicPlugin(record) {
    return {
      id: record.id,
      source: record.source,
      trusted: record.trusted,
      enabled: record.enabled,
      revoked: record.revoked,
      revocationMessage: record.revocationMessage,
      installedAt: record.installedAt,
      registryURL: record.registryURL || null,
      name: this._localizedPluginText(record.manifest.name, record.manifest.jaName),
      description: this._localizedPluginText(record.manifest.description, record.manifest.jaDescription),
      jaName: record.manifest.jaName,
      jaDescription: record.manifest.jaDescription,
      pluginVersion: record.manifest.pluginVersion,
      kinds: [...record.manifest.kinds],
      tags: [...record.manifest.tags],
      capabilities: [...record.manifest.capabilities],
      grantedCapabilities: [...record.grantedCapabilities]
    };
  }


  _notify(message, kind = 'info') {
    const ui = this.context.systems.ui;
    if (!ui?.Flash || typeof ui.Flash !== 'function') return;

    const iconClass = (kind === 'error') ? 'disabled' : '';
    ui.Flash
      .duration(4000)
      .iconClass(iconClass)
      .label(this._cleanString(message) || '')();
  }


  _buildSignaturePayload(id, manifestURL, manifestHash) {
    return `${id}\n${manifestURL}\n${manifestHash}`;
  }


  _localizedPluginText(defaultText = '', jaText = '') {
    const l10n = this.context.systems.l10n;
    const locale = this._cleanString(l10n?.localeCode?.() || l10n?.languageCode?.()).toLowerCase();
    if (locale.startsWith('ja')) {
      return jaText || defaultText || '';
    }
    return defaultText || '';
  }


  _describeCapability(capability) {
    const l10n = this.context.systems.l10n;
    const id = this._cleanString(capability);
    const token = id.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const labelKey = `plugin_manager.permissions.capabilities.${token}.label`;
    const descriptionKey = `plugin_manager.permissions.capabilities.${token}.description`;
    const defaultLabelKey = 'plugin_manager.permissions.capabilities.default_label';
    const defaultDescriptionKey = 'plugin_manager.permissions.capabilities.default_description';

    let label = l10n.t(labelKey);
    if (label === labelKey) {
      label = l10n.t(defaultLabelKey, { capability: id });
      if (label === defaultLabelKey) {
        label = id;
      }
    }

    let description = l10n.t(descriptionKey);
    if (description === descriptionKey) {
      description = l10n.t(defaultDescriptionKey, { capability: id });
      if (description === defaultDescriptionKey) {
        description = id;
      }
    }

    return { id, label, description };
  }


  async _verifySignature(payload, signatureB64, keyID) {
    const jwk = this._trustedKeys.get(keyID);
    if (!jwk) {
      throw new Error(`No trusted key is available for keyID "${keyID}"`);
    }

    if (!globalThis.crypto?.subtle) {
      throw new Error('WebCrypto is unavailable in this environment');
    }

    const key = await globalThis.crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    const signature = this._base64ToBytes(signatureB64);
    const data = this._stringToBytes(payload);

    return globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      data
    );
  }


  async _sha256Base64(bytes) {
    if (!globalThis.crypto?.subtle) {
      throw new Error('WebCrypto is unavailable in this environment');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return this._bytesToBase64(new Uint8Array(digest));
  }


  _stringToBytes(str) {
    return new TextEncoder().encode(str);
  }


  _bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }


  _base64ToBytes(base64) {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      throw new Error('Signature is not valid base64');
    }
  }


  _isValidURL(urlString) {
    try {
      const url = new URL(urlString);
      if (!url) return false;
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }


  _cleanString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }


  _cleanStringArray(values) {
    if (!Array.isArray(values)) return [];
    return values
      .map(value => this._cleanString(value))
      .filter(Boolean);
  }

}
