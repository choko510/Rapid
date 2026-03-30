describe('RoadAlignmentService', () => {
  let service;
  let _restoreMocha;

  class MockContext {
    constructor() {
      this.systems = {};
      this.services = {};
      this.viewport = new Rapid.sdk.Viewport();
    }
  }

  beforeEach(() => {
    _restoreMocha = window.mocha;
    window.mocha = true;
    fetchMock.removeRoutes().clearHistory();
    service = new Rapid.RoadAlignmentService(new MockContext());
    return service.initAsync();
  });

  afterEach(() => {
    window.mocha = _restoreMocha;
    fetchMock.removeRoutes().clearHistory();
  });


  describe('#loadTilesForExtent', () => {
    it('loads and normalizes LineString / MultiLineString data', done => {
      const payload = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [[0.0000, 0.0000], [0.0010, 0.0000]]
            }
          },
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'MultiLineString',
              coordinates: [
                [[0.0000, 0.0002], [0.0010, 0.0002]]
              ]
            }
          }
        ]
      };

      fetchMock.route(/localhost:8080\/tile\/\d+\/\d+\/\d+\.geojson/, {
        body: JSON.stringify(payload),
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

      const extent = new Rapid.sdk.Extent([0, -0.0005], [0.001, 0.0005]);
      const first = service.loadTilesForExtent(extent);
      expect(first.status).to.eql('loading');

      window.setTimeout(() => {
        const second = service.loadTilesForExtent(extent);
        expect(second.status).to.eql('ready');

        const lines = service.getReferenceLines(extent);
        expect(lines.length).to.be.at.least(2);
        done();
      }, 30);
    });

    it('treats 404 tiles as empty but successful', done => {
      fetchMock.route(/localhost:8080\/tile\/\d+\/\d+\/\d+\.geojson/, 404);

      const extent = new Rapid.sdk.Extent([135, 34], [135.001, 34.001]);
      service.loadTilesForExtent(extent);

      window.setTimeout(() => {
        const state = service.loadTilesForExtent(extent);
        expect(state.status).to.eql('ready');

        const lines = service.getReferenceLines(extent);
        expect(lines).to.eql([]);
        done();
      }, 30);
    });

  });


  describe('#estimateForWays', () => {
    it('estimates positive offset for shifted selected roads', () => {
      const graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0.0000, 0.0000] }),
        Rapid.osmNode({ id: 'n2', loc: [0.0010, 0.0000] }),
        Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } })
      ]);
      const ways = [graph.entity('w1')];

      const referenceLines = [{
        coords: [[0.0000, 0.0001], [0.0010, 0.0001]],
        extent: new Rapid.sdk.Extent([0.0000, 0.0001], [0.0010, 0.0001]),
        bbox: { minX: 0.0000, minY: 0.0001, maxX: 0.0010, maxY: 0.0001 }
      }];

      const result = service.estimateForWays(ways, graph, referenceLines);
      expect(result.ok).to.be.true;
      expect(Math.abs(result.delta[0])).to.be.lessThan(1e-6);
      expect(result.delta[1]).to.be.greaterThan(0);
      expect(result.matchCount).to.be.greaterThan(5);
    });

    it('returns not_enough_matches when no nearby reference roads', () => {
      const graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0.0000, 0.0000] }),
        Rapid.osmNode({ id: 'n2', loc: [0.0010, 0.0000] }),
        Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } })
      ]);
      const ways = [graph.entity('w1')];

      const referenceLines = [{
        coords: [[1.0, 1.0], [1.1, 1.1]],
        extent: new Rapid.sdk.Extent([1.0, 1.0], [1.1, 1.1]),
        bbox: { minX: 1.0, minY: 1.0, maxX: 1.1, maxY: 1.1 }
      }];

      const result = service.estimateForWays(ways, graph, referenceLines);
      expect(result.ok).to.be.false;
      expect(result.reason).to.eql('not_enough_matches');
    });
  });


  describe('#reshapeForWays', () => {
    it('returns move plan for nearby shifted nodes', () => {
      const graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0.0000, 0.0000] }),
        Rapid.osmNode({ id: 'n2', loc: [0.0010, 0.0000] }),
        Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } })
      ]);
      const ways = [graph.entity('w1')];

      const referenceLines = [{
        coords: [[0.0000, 0.00008], [0.0010, 0.00008]],
        extent: new Rapid.sdk.Extent([0.0000, 0.00008], [0.0010, 0.00008]),
        bbox: { minX: 0.0000, minY: 0.00008, maxX: 0.0010, maxY: 0.00008 }
      }];

      const result = service.reshapeForWays(ways, graph, referenceLines);
      expect(result.ok).to.be.true;
      expect(result.moveNodeLocs.size).to.be.at.least(2);
      expect(result.matchedNodeCount).to.be.at.least(2);
    });

    it('plans insertion for curved reference shape', () => {
      const graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0.0000, 0.0000] }),
        Rapid.osmNode({ id: 'n2', loc: [0.0010, 0.0000] }),
        Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } })
      ]);
      const ways = [graph.entity('w1')];

      const referenceLines = [{
        coords: [[0.0000, 0.0000], [0.0005, 0.0002], [0.0010, 0.0000]],
        extent: new Rapid.sdk.Extent([0.0000, 0.0000], [0.0010, 0.0002]),
        bbox: { minX: 0.0000, minY: 0.0000, maxX: 0.0010, maxY: 0.0002 }
      }];

      const result = service.reshapeForWays(ways, graph, referenceLines);
      expect(result.ok).to.be.true;
      expect(result.insertions.length).to.be.greaterThan(0);
    });

    it('avoids backtracking insertions that would create spike artifacts', () => {
      const graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0.0000, 0.0000] }),
        Rapid.osmNode({ id: 'n2', loc: [0.0010, 0.0000] }),
        Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } })
      ]);
      const ways = [graph.entity('w1')];

      // These references are just beyond each endpoint and can attract samples
      // into reverse-direction insertions if we don't guard against them.
      const referenceLines = [
        {
          coords: [[-0.0002, -0.0003], [-0.0002, 0.0003]],
          extent: new Rapid.sdk.Extent([-0.0002, -0.0003], [-0.0002, 0.0003]),
          bbox: { minX: -0.0002, minY: -0.0003, maxX: -0.0002, maxY: 0.0003 }
        },
        {
          coords: [[0.0012, -0.0003], [0.0012, 0.0003]],
          extent: new Rapid.sdk.Extent([0.0012, -0.0003], [0.0012, 0.0003]),
          bbox: { minX: 0.0012, minY: -0.0003, maxX: 0.0012, maxY: 0.0003 }
        }
      ];

      const result = service.reshapeForWays(ways, graph, referenceLines);
      expect(result.ok).to.be.true;
      expect(result.matchedNodeCount).to.be.at.least(2);
      expect(result.insertions).to.eql([]);
      expect(result.moveNodeLocs.size).to.be.at.least(1);
    });
  });
});
