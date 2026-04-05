describe('RapidSystem', () => {
  const STORAGE_KEY = 'rapid-external-manifest-urls';

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
    startAsync() { return Promise.resolve(); }
    getAvailableDatasets() { return []; }
  }

  class MockContext {
    constructor(options = {}) {
      const initialStorage = {};
      if (options.storedURLs) {
        initialStorage[STORAGE_KEY] = JSON.stringify(options.storedURLs);
      }

      this.systems = {
        assets: new MockSimpleSystem(),
        editor: new MockSimpleSystem(),
        l10n: new MockSimpleSystem(),
        map: new MockSimpleSystem(),
        storage: new MockStorageSystem(initialStorage),
        urlhash: new MockUrlHashSystem(new Map([['datasets', 'initial']]))
      };

      this.services = {
        esri: new MockDataService(),
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

    await rapid.initAsync();
    await rapid.startAsync();

    expect(context.services.external.calls).to.eql([urlA, urlB]);
    expect(rapid.catalog.has('external-a')).to.be.true;
    expect(rapid.catalog.has('external-b')).to.be.true;
    expect(rapid.datasets.get('external-a').enabled).to.be.true;
    expect(rapid.datasets.get('external-b').enabled).to.be.true;
  });
});
