describe('operationAutoAlignRoads', () => {
  let _graph;
  let _reshapeResult;
  let _prepareResult;
  let _performCalls;
  let _commitCalls;
  let _enterCalls;

  class MockEditSystem {
    constructor() {}
    get staging() { return { graph: _graph }; }
    beginTransaction() {}
    endTransaction() {}
    perform(action) {
      _performCalls.push(action);
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

  class MockStorageSystem {
    constructor() {}
    getItem() { return 'true'; }
  }

  class MockRoadAlignmentService {
    prepareForWays() {
      return _prepareResult;
    }
    reshapeForWays() {
      return _reshapeResult;
    }
  }

  class MockContext {
    constructor() {
      this.viewport = new Rapid.sdk.Viewport();
      this.systems = {
        editor: new MockEditSystem(),
        l10n: new MockLocalizationSystem(),
        storage: new MockStorageSystem()
      };
      this.services = {
        roadAlignment: new MockRoadAlignmentService()
      };
    }
    hasHiddenConnections() { return false; }
    loadTileAtLoc() {}
    enter(mode, opts) {
      _enterCalls.push({ mode, opts });
    }
  }

  const context = new MockContext();

  beforeEach(() => {
    _prepareResult = { status: 'ready', lines: [{}] };
    _reshapeResult = { ok: true, moveNodeLocs: new Map([['n1', [0.0002, 0]]]), insertions: [], removals: [] };
    _performCalls = [];
    _commitCalls = [];
    _enterCalls = [];

    _graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
      Rapid.osmNode({ id: 'n2', loc: [0.001, 0] }),
      Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } }),
      Rapid.osmNode({ id: 'p1', loc: [0, 0] })
    ]);
  });


  describe('#available', () => {
    it('is available for selected highway ways', () => {
      const result = Rapid.operationAutoAlignRoads(context, ['w1']).available();
      expect(result).to.be.ok;
    });

    it('is not available for non-way selection', () => {
      const result = Rapid.operationAutoAlignRoads(context, ['p1']).available();
      expect(result).to.not.be.ok;
    });
  });


  describe('#disabled', () => {
    it('returns false when reshape plan is ready', () => {
      const result = Rapid.operationAutoAlignRoads(context, ['w1']).disabled();
      expect(result).to.be.false;
    });

    it('returns loading state while reference tiles are loading', () => {
      _prepareResult = { status: 'loading', reason: 'reference_loading', lines: [] };
      const result = Rapid.operationAutoAlignRoads(context, ['w1']).disabled();
      expect(result).to.eql('reference_loading');
    });

    it('returns alignment failure reason when reshape fails', () => {
      _reshapeResult = { ok: false, reason: 'not_enough_matches' };
      const result = Rapid.operationAutoAlignRoads(context, ['w1']).disabled();
      expect(result).to.eql('not_enough_matches');
    });
  });


  describe('#operation', () => {
    it('performs edit actions + commit when reshape succeeds', () => {
      const operation = Rapid.operationAutoAlignRoads(context, ['w1']);
      operation();

      expect(_performCalls.length).to.eql(1);
      expect(_commitCalls.length).to.eql(1);
      expect(_commitCalls[0].selectedIDs).to.eql(['w1']);
      expect(_enterCalls.length).to.eql(1);
      expect(_enterCalls[0].mode).to.eql('select-osm');
    });

    it('does nothing when reshape is not ok', () => {
      _reshapeResult = { ok: false, reason: 'already_aligned' };
      const operation = Rapid.operationAutoAlignRoads(context, ['w1']);
      operation();

      expect(_performCalls.length).to.eql(0);
      expect(_commitCalls.length).to.eql(0);
      expect(_enterCalls.length).to.eql(0);
    });

    it('adds and removes nodes when reshape plan requests it', () => {
      _reshapeResult = {
        ok: true,
        moveNodeLocs: new Map([['n1', [0.0002, 0]]]),
        insertions: [{ wayID: 'w1', index: 1, loc: [0.0005, 0] }],
        removals: ['n2']
      };

      const operation = Rapid.operationAutoAlignRoads(context, ['w1']);
      operation();

      expect(_performCalls.length).to.eql(5); // move existing + addEntity + addVertex + move inserted + deleteNode
      expect(_commitCalls.length).to.eql(1);
    });
  });
});
