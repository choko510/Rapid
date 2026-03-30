describe('operationCreateWaterFromReference', () => {
  let _graph;
  let _performCalls;
  let _commitCalls;
  let _enterCalls;
  let _mode;
  let _viewport;
  let _flashCalls;

  class MockEditSystem {
    constructor() {}
    get staging() { return { graph: _graph }; }
    perform(...actions) {
      _performCalls.push(...actions);
      return null;
    }
    commit(opts) {
      _commitCalls.push(opts);
    }
  }

  class MockLocalizationSystem {
    constructor() {}
    t(id) { return id; }
  }

  class MockUiSystem {
    constructor() {
      this.redrawCount = 0;
      this.Flash = {
        duration: () => this.Flash,
        iconName: () => this.Flash,
        iconClass: () => this.Flash,
        label: (val) => {
          _flashCalls.push(val);
          return () => {};
        }
      };
    }
    redrawEditMenu() {
      this.redrawCount++;
    }
  }

  class MockContext {
    constructor() {
      this.systems = {
        editor: new MockEditSystem(),
        l10n: new MockLocalizationSystem(),
        ui: new MockUiSystem()
      };
      this.viewport = _viewport;
      this.mode = _mode;
    }
    enter(mode, opts) {
      _enterCalls.push({ mode, opts });
    }
  }

  let context;

  beforeEach(() => {
    _performCalls = [];
    _commitCalls = [];
    _enterCalls = [];
    _flashCalls = [];
    _mode = { id: 'browse' };
    _viewport = new Rapid.sdk.Viewport();

    _graph = new Rapid.Graph([]);
    fetchMock.removeRoutes().clearHistory();
    context = new MockContext();
  });

  afterEach(() => {
    fetchMock.removeRoutes().clearHistory();
  });


  describe('#available', () => {
    it('is available in browse mode', () => {
      const operation = Rapid.operationCreateWaterFromReference(context);
      expect(operation.available()).to.be.true;
    });

    it('is not available outside browse mode', () => {
      context.mode = { id: 'select-osm' };
      const operation = Rapid.operationCreateWaterFromReference(context);
      expect(operation.available()).to.be.false;
    });
  });


  describe('#disabled', () => {
    it('is disabled before receiving anchor point', () => {
      const operation = Rapid.operationCreateWaterFromReference(context);
      expect(operation.disabled()).to.eql('no_anchor_point');
    });
  });


  describe('#operation', () => {
    it('creates a closed water way when reference polygon contains the click location', done => {
      fetchMock.route(/\/geojson\?/, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-0.01, -0.01],
                [0.01, -0.01],
                [0.01, 0.01],
                [-0.01, 0.01],
                [-0.01, -0.01]
              ]]
            },
            properties: {}
          }]
        })
      });

      const operation = Rapid.operationCreateWaterFromReference(context);
      operation.point(_viewport.project([0, 0]));

      window.setTimeout(() => {
        expect(operation.disabled()).to.be.false;
        operation();

        expect(_performCalls.length).to.be.greaterThan(0);
        expect(_commitCalls.length).to.eql(1);
        expect(_enterCalls.length).to.eql(1);
        expect(_enterCalls[0].mode).to.eql('select-osm');
        expect(_commitCalls[0].selectedIDs.length).to.eql(1);
        done();
      }, 30);
    });

    it('creates a multipolygon relation when polygon has inner ring', done => {
      fetchMock.route(/\/geojson\?/, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02], [-0.02, -0.02]],
                [[-0.005, -0.005], [0.005, -0.005], [0.005, 0.005], [-0.005, 0.005], [-0.005, -0.005]]
              ]
            },
            properties: {}
          }]
        })
      });

      const operation = Rapid.operationCreateWaterFromReference(context);
      operation.point(_viewport.project([0, 0]));

      window.setTimeout(() => {
        expect(operation.disabled()).to.be.false;
        operation();

        const selectedIDs = _commitCalls[0].selectedIDs;
        expect(selectedIDs).to.have.length(1);
        expect(selectedIDs[0][0]).to.eql('r');  // relation
        done();
      }, 30);
    });

    it('stays disabled when no containing polygon exists', done => {
      fetchMock.route(/\/geojson\?/, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [1.0, 1.0],
                [1.1, 1.0],
                [1.1, 1.1],
                [1.0, 1.1],
                [1.0, 1.0]
              ]]
            },
            properties: {}
          }]
        })
      });

      const operation = Rapid.operationCreateWaterFromReference(context);
      operation.point(_viewport.project([0, 0]));

      window.setTimeout(() => {
        expect(operation.disabled()).to.eql('no_containing_water');
        done();
      }, 30);
    });

    it('stays disabled when reference fetch fails', done => {
      fetchMock.route(/\/geojson\?/, 500);

      const operation = Rapid.operationCreateWaterFromReference(context);
      operation.point(_viewport.project([0, 0]));

      window.setTimeout(() => {
        expect(operation.disabled()).to.eql('reference_fetch_failed');
        done();
      }, 30);
    });
  });
});
