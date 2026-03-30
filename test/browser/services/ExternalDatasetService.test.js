describe('ExternalDatasetService', () => {
  let service;

  class MockGfxSystem {
    deferredRedraw() {}
  }

  class MockVectorTileService {
    constructor() {
      this._data = new Map();
      this.loaded = [];
    }
    initAsync() { return Promise.resolve(); }
    startAsync() { return Promise.resolve(); }
    loadTiles(url) { this.loaded.push(url); }
    getData(url) { return this._data.get(url) || []; }
    setData(url, data) { this._data.set(url, data); }
  }

  class MockContext {
    constructor() {
      this.systems = {
        gfx: new MockGfxSystem()
      };
      this.services = {
        vectortile: new MockVectorTileService()
      };
    }
  }

  beforeEach(() => {
    fetchMock.removeRoutes().clearHistory();
    service = new Rapid.ExternalDatasetService(new MockContext());
    return service.initAsync();
  });

  afterEach(() => {
    fetchMock.removeRoutes().clearHistory();
  });


  it('imports valid manifest entries and reports invalid ones', () => {
    const result = service.importManifest({
      datasets: [
        {
          id: 'external-roads',
          label: 'External Roads',
          categories: ['roads'],
          source: { type: 'geojson', url: 'https://example.com/roads.geojson' }
        },
        {
          id: 'invalid-one',
          label: 'Invalid',
          categories: ['roads'],
          source: { type: 'unknown', url: 'https://example.com/nope' }
        }
      ]
    });

    expect(result.datasets.map(d => d.id)).to.eql(['external-roads']);
    expect(result.errors.length).to.eql(1);
  });


  it('replaces dataset definition when importing duplicate id', () => {
    service.importManifest({
      datasets: [{
        id: 'dup-dataset',
        label: 'First Label',
        categories: ['roads'],
        source: { type: 'geojson', url: 'https://example.com/first.geojson' }
      }]
    });

    const result = service.importManifest({
      datasets: [{
        id: 'dup-dataset',
        label: 'Second Label',
        categories: ['roads', 'featured'],
        source: { type: 'geojson', url: 'https://example.com/second.geojson' }
      }]
    });

    expect(result.datasets.length).to.eql(1);
    expect(result.datasets[0].getLabel()).to.eql('Second Label');
  });


  it('loads geojson source and returns normalized features', done => {
    fetchMock.route('https://example.com/roads.geojson', {
      body: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { name: 'Main Street' },
          geometry: {
            type: 'LineString',
            coordinates: [[0, 0], [1, 0]]
          }
        }]
      },
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    service.importManifest({
      datasets: [{
        id: 'geojson-dataset',
        label: 'Geojson Dataset',
        categories: ['roads'],
        source: { type: 'geojson', url: 'https://example.com/roads.geojson' }
      }]
    });

    service.on('loadedData', () => {
      const data = service.getData('geojson-dataset');
      expect(data.length).to.eql(1);
      expect(data[0].properties['@name']).to.eql('Main Street');
      done();
    });

    service.loadTiles('geojson-dataset');
  });


  it('proxies vectortile loading and reading to VectorTileService', () => {
    const vtURL = 'https://example.com/roads.pmtiles';
    service.importManifest({
      datasets: [{
        id: 'vt-dataset',
        label: 'VT Dataset',
        categories: ['roads'],
        source: { type: 'vectortile', url: vtURL }
      }]
    });

    const vt = service.context.services.vectortile;
    vt.setData(vtURL, [{ geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} } }]);

    service.loadTiles('vt-dataset');
    expect(vt.loaded).to.eql([vtURL]);

    const data = service.getData('vt-dataset');
    expect(data.length).to.eql(1);
    expect(data[0].geometry.type).to.eql('Point');
  });
});

