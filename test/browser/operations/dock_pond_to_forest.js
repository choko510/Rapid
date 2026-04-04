describe('operationDockPondToForest', () => {
  let _graph;
  let _performCalls;
  let _commitCalls;
  let _enterCalls;


  function getAllEntities(graph) {
    const entities = new Map(graph.base.entities);
    for (const [entityID, entity] of graph.local.entities) {
      if (entity === undefined) {
        entities.delete(entityID);
      } else {
        entities.set(entityID, entity);
      }
    }
    return [...entities.values()].filter(Boolean);
  }


  class MockEditSystem {
    constructor() {}
    get staging() { return { graph: _graph }; }
    beginTransaction() {}
    endTransaction() {}
    intersects(extent) {
      return getAllEntities(_graph).filter(entity => entity.intersects(extent, _graph));
    }
    perform(...actions) {
      _performCalls.push(...actions);
      for (const action of actions) {
        _graph = action(_graph);
      }
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


  class MockContext {
    constructor() {
      this.systems = {
        editor: new MockEditSystem(),
        l10n: new MockLocalizationSystem()
      };
    }
    hasHiddenConnections() { return false; }
    enter(mode, opts) {
      _enterCalls.push({ mode, opts });
    }
  }


  let context;

  beforeEach(() => {
    _performCalls = [];
    _commitCalls = [];
    _enterCalls = [];
    context = new MockContext();
  });


  describe('#available', () => {
    it('is available for a selected pond way', () => {
      _graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
        Rapid.osmNode({ id: 'n2', loc: [0.001, 0] }),
        Rapid.osmNode({ id: 'n3', loc: [0.001, 0.001] }),
        Rapid.osmNode({ id: 'n4', loc: [0, 0.001] }),
        Rapid.osmWay({
          id: 'wP',
          nodes: ['n1', 'n2', 'n3', 'n4', 'n1'],
          tags: { natural: 'water', water: 'pond' }
        })
      ]);

      const operation = Rapid.operationDockPondToForest(context, ['wP']);
      expect(operation.available()).to.be.true;
    });

    it('is not available for non-pond features', () => {
      _graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
        Rapid.osmNode({ id: 'n2', loc: [0.001, 0] }),
        Rapid.osmNode({ id: 'n3', loc: [0.001, 0.001] }),
        Rapid.osmNode({ id: 'n4', loc: [0, 0.001] }),
        Rapid.osmWay({
          id: 'wF',
          nodes: ['n1', 'n2', 'n3', 'n4', 'n1'],
          tags: { landuse: 'forest' }
        })
      ]);

      const operation = Rapid.operationDockPondToForest(context, ['wF']);
      expect(operation.available()).to.be.false;
    });
  });


  describe('#disabled', () => {
    it('returns no_containing_forest if no containing forest exists', () => {
      _graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
        Rapid.osmNode({ id: 'n2', loc: [0.001, 0] }),
        Rapid.osmNode({ id: 'n3', loc: [0.001, 0.001] }),
        Rapid.osmNode({ id: 'n4', loc: [0, 0.001] }),
        Rapid.osmWay({
          id: 'wP',
          nodes: ['n1', 'n2', 'n3', 'n4', 'n1'],
          tags: { natural: 'water', water: 'pond' }
        })
      ]);

      const operation = Rapid.operationDockPondToForest(context, ['wP']);
      expect(operation.disabled()).to.eql('no_containing_forest');
    });
  });


  describe('#operation', () => {
    it('creates forest outer + pond inner and docks nearby nodes', () => {
      _graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'nF1', loc: [-0.01, -0.01] }),
        Rapid.osmNode({ id: 'nF2', loc: [0.01, -0.01] }),
        Rapid.osmNode({ id: 'nF3', loc: [0.01, 0.01] }),
        Rapid.osmNode({ id: 'nF4', loc: [-0.01, 0.01] }),
        Rapid.osmWay({
          id: 'wF',
          nodes: ['nF1', 'nF2', 'nF3', 'nF4', 'nF1'],
          tags: { landuse: 'forest' }
        }),
        Rapid.osmNode({ id: 'nP1', loc: [-0.009999, -0.009999] }),
        Rapid.osmNode({ id: 'nP2', loc: [-0.008, -0.009999] }),
        Rapid.osmNode({ id: 'nP3', loc: [-0.008, -0.008] }),
        Rapid.osmNode({ id: 'nP4', loc: [-0.009999, -0.008] }),
        Rapid.osmWay({
          id: 'wP',
          nodes: ['nP1', 'nP2', 'nP3', 'nP4', 'nP1'],
          tags: { natural: 'water', water: 'pond' }
        })
      ]);

      const operation = Rapid.operationDockPondToForest(context, ['wP']);
      expect(operation.disabled()).to.be.false;

      operation();

      expect(_performCalls.length).to.be.greaterThan(1);
      expect(_commitCalls.length).to.eql(1);
      expect(_enterCalls.length).to.eql(1);
      expect(_enterCalls[0].mode).to.eql('select-osm');

      const relation = getAllEntities(_graph).find(entity =>
        entity.type === 'relation' &&
        entity.tags.type === 'multipolygon' &&
        entity.tags.landuse === 'forest'
      );

      expect(relation).to.exist;

      const forestMember = relation.members.find(member => member.id === 'wF');
      const pondMember = relation.members.find(member => member.id === 'wP');

      expect(forestMember.role).to.eql('outer');
      expect(pondMember.role).to.eql('inner');

      const updatedPond = _graph.entity('wP');
      expect(updatedPond.nodes.includes('nF1')).to.be.true;
      expect(_graph.hasEntity('nP1')).to.be.undefined;
    });
  });
});

