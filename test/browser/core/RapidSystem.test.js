describe('RapidSystem', () => {
  const STORAGE_KEY = 'rapid-external-manifest-urls';
  const DATASET_STATE_STORAGE_KEY = 'rapid-dataset-state-v1';

  function makeDataset(id, categories = ['buildings']) {
    return {
      id: id,
      categories: new Set(categories),
      color: '#da26d3',
      added: false,
      enabled: false
    };
  }

  class MockStorageSystem {
    constructor(initial = {}) {
      this._data = new Map(Object.entries(initial));
    }
    getItem(key) {
      return this._data.get(key) ?? null;
    }
    setItem(key, val) {
      this._data.set(key, val);
      return true;
    }
  }

  class MockSimpleSystem {
    initAsync() { return Promise.resolve(); }
    on() { return this; }
  }

  class MockUrlHashSystem extends MockSimpleSystem {
    constructor(initialHashParams = new Map()) {
      super();
      this.initialHashParams = initialHashParams;
      this.params = new Map();
    }
    setParam(key, val) {
      this.params.set(key, val);
    }
  }

  class MockExternalService {
    constructor(resultsByURL = new Map()) {
      this._resultsByURL = resultsByURL;
      this.calls = [];
    }
    startAsync() { return Promise.resolve(); }
    getAvailableDatasets() { return []; }
    importFromURL(url) {
      this.calls.push(url);
      const result = this._resultsByURL.get(url);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? { datasets: [], errors: [] });
    }
    importFromFile() { return Promise.resolve({ datasets: [], errors: [] }); }
    importManifest() { return { datasets: [], errors: [] }; }
  }

  class MockDataService {
    constructor(datasets = []) {
      this._datasets = datasets;
    }
    startAsync() { return Promise.resolve(); }
    getAvailableDatasets() { return this._datasets; }
  }

  class MockContext {
    constructor(options = {}) {
      const initialStorage = {};
      if (options.storedURLs) {
        initialStorage[STORAGE_KEY] = JSON.stringify(options.storedURLs);
      }
      if (options.storedDatasetState) {
        initialStorage[DATASET_STATE_STORAGE_KEY] = JSON.stringify(options.storedDatasetState);
      }

      this.systems = {
        assets: new MockSimpleSystem(),
        editor: new MockSimpleSystem(),
        l10n: new MockSimpleSystem(),
        map: new MockSimpleSystem(),
        storage: new MockStorageSystem(initialStorage),
        urlhash: new MockUrlHashSystem(options.initialHashParams ?? new Map([['datasets', 'initial']]))
      };

      const availableDatasets = options.availableDatasets ?? [];

      this.services = {
        esri: new MockDataService(availableDatasets),
        external: new MockExternalService(options.externalResults),
        mapwithai: new MockDataService(),
        overture: new MockDataService()
      };
    }
  }


  it('persists imported external manifest URLs', async () => {
    const url = 'https://example.com/manifest.json';
    const extDataset = makeDataset('external-a');
    const context = new MockContext({
      externalResults: new Map([
        [url, { datasets: [extDataset], errors: [] }]
      ])
    });
    const rapid = new Rapid.RapidSystem(context);

    await rapid.initAsync();
    await rapid.startAsync();

    await rapid.importExternalManifestFromURL(url);
    expect(JSON.parse(context.systems.storage.getItem(STORAGE_KEY))).to.eql([url]);

    await rapid.importExternalManifestFromURL(url);
    expect(JSON.parse(context.systems.storage.getItem(STORAGE_KEY))).to.eql([url]);
  });


  it('restores persisted external manifest URLs at startup', async () => {
    const urlA = 'https://example.com/a.json';
    const urlB = 'https://example.com/b.json';
    const datasetA = makeDataset('external-a');
    const datasetB = makeDataset('external-b');
    const context = new MockContext({
      storedURLs: [urlA, urlA, urlB],
      externalResults: new Map([
        [urlA, { datasets: [datasetA], errors: [] }],
        [urlB, { datasets: [datasetB], errors: [] }]
      ])
    });
    const rapid = new Rapid.RapidSystem(context);
    const requestIdleStub = window.requestIdleCallback
      ? sinon.stub(window, 'requestIdleCallback').callsFake(callback => window.setTimeout(callback, 0))
      : null;

    await rapid.initAsync();
    await rapid.startAsync();
    await new Promise(resolve => { window.setTimeout(resolve, 0); });
    requestIdleStub?.restore();

    expect(context.services.external.calls).to.eql([urlA, urlB]);
    expect(rapid.catalog.has('external-a')).to.be.true;
    expect(rapid.catalog.has('external-b')).to.be.true;
    expect(rapid.datasets.get('external-a').enabled).to.be.true;
    expect(rapid.datasets.get('external-b').enabled).to.be.true;
  });


  it('restores stored dataset state when datasets hash is absent', async () => {
    const context = new MockContext({
      initialHashParams: new Map(),
      availableDatasets: [makeDataset('ml-buildings-overture')],
      storedDatasetState: {
        addedDatasetIDs: ['ml-buildings-overture'],
        enabledDatasetIDs: []
      }
    });
    const rapid = new Rapid.RapidSystem(context);

    await rapid.initAsync();
    await rapid.startAsync();

    expect(rapid.datasets.get('ml-buildings-overture').added).to.be.true;
    expect(rapid.datasets.get('ml-buildings-overture').enabled).to.be.false;
    expect(context.systems.urlhash.params.get('datasets')).to.be.null;
  });


  it('keeps disabled datasets disabled after reload when no datasets hash is present', async () => {
    const defaultDatasetIDs = ['fbRoads', 'esri-buildings', 'ml-buildings-overture', 'omdFootways', 'tomtom-roads'];
    const makeDefaultDatasets = () => defaultDatasetIDs.map(id => makeDataset(id));

    const context1 = new MockContext({
      initialHashParams: new Map(),
      availableDatasets: makeDefaultDatasets()
    });
    const rapid1 = new Rapid.RapidSystem(context1);

    await rapid1.initAsync();
    await rapid1.startAsync();
    rapid1.disableDatasets('ml-buildings-overture');

    const storedDatasetState = JSON.parse(context1.systems.storage.getItem(DATASET_STATE_STORAGE_KEY));

    const context2 = new MockContext({
      initialHashParams: new Map(),
      availableDatasets: makeDefaultDatasets(),
      storedDatasetState: storedDatasetState
    });
    const rapid2 = new Rapid.RapidSystem(context2);

    await rapid2.initAsync();
    await rapid2.startAsync();

    expect(rapid2.datasets.get('ml-buildings-overture').enabled).to.be.false;
  });
});
