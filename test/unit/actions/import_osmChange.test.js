import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('actionImportOsmChange', () => {
  it('imports create/modify/delete features from an osmChange object', () => {
    const n1 = Rapid.osmNode({ id: 'n1', version: '2', loc: [0, 0] });
    const n2 = Rapid.osmNode({ id: 'n2', version: '1', loc: [1, 1] });
    const w1 = Rapid.osmWay({ id: 'w1', version: '3', nodes: ['n1', 'n2'], tags: { highway: 'service' } });
    const graph = new Rapid.Graph([n1, n2, w1]);

    const osmChange = {
      create: [
        { type: 'node', id: -1, lon: 8, lat: 9, tags: { amenity: 'bench' } },
        { type: 'way', id: -2, nodes: [-1], tags: { highway: 'path' } }
      ],
      modify: [
        { type: 'node', id: 1, version: 2, lon: 5, lat: 6, tags: { name: 'Updated Node' } }
      ],
      delete: [
        { type: 'way', id: 1, version: 3 }
      ]
    };

    const result = Rapid.actionImportOsmChange(osmChange, false)(graph);
    assert.ok(result instanceof Rapid.Graph);
    assert.deepEqual(result.entity('n1').loc, [5, 6]);
    assert.deepEqual(result.entity('n1').tags, { name: 'Updated Node' });
    assert.equal(result.hasEntity('w1'), undefined);

    const entities = [...result.local.entities.values()].filter(Boolean);
    const createdNode = entities.find(entity => entity.type === 'node' && entity.tags.amenity === 'bench');
    const createdWay = entities.find(entity => entity.type === 'way' && entity.tags.highway === 'path');

    assert.ok(createdNode);
    assert.ok(createdWay);
    assert.deepEqual(createdNode.loc, [8, 9]);
    assert.deepEqual(createdWay.nodes, [createdNode.id]);
  });


  it('throws on version conflicts when allowConflicts is false', () => {
    const n1 = Rapid.osmNode({ id: 'n1', version: '2', loc: [0, 0] });
    const graph = new Rapid.Graph([n1]);
    const osmChange = {
      create: [],
      modify: [{ type: 'node', id: 1, version: 9, lon: 1, lat: 1, tags: {} }],
      delete: []
    };

    assert.throws(
      () => Rapid.actionImportOsmChange(osmChange, false)(graph),
      /Conflicts on n1/
    );
  });


  it('allows imports with mismatched versions when allowConflicts is true', () => {
    const n1 = Rapid.osmNode({ id: 'n1', version: '2', loc: [0, 0] });
    const graph = new Rapid.Graph([n1]);
    const osmChange = {
      create: [],
      modify: [{ type: 'node', id: 1, version: 9, lon: 1, lat: 1, tags: { name: 'Force' } }],
      delete: []
    };

    const result = Rapid.actionImportOsmChange(osmChange, true)(graph);
    assert.deepEqual(result.entity('n1').loc, [1, 1]);
    assert.deepEqual(result.entity('n1').tags, { name: 'Force' });
  });


  it('skips delete entries whose entity is already gone', () => {
    const n1 = Rapid.osmNode({ id: 'n1', version: '1', loc: [0, 0] });
    const n2 = Rapid.osmNode({ id: 'n2', version: '1', loc: [1, 1], tags: { amenity: 'bench' } });
    const w1 = Rapid.osmWay({ id: 'w1', version: '1', nodes: ['n1', 'n2'] });
    const graph = new Rapid.Graph([n1, n2, w1]);

    const osmChange = {
      create: [],
      modify: [],
      delete: [
        { type: 'way', id: 1, version: 1 },
        { type: 'node', id: 1, version: 1 },
        { type: 'node', id: 1, version: 1 }
      ]
    };

    const result = Rapid.actionImportOsmChange(osmChange, false)(graph);
    assert.equal(result.hasEntity('w1'), undefined);
    assert.equal(result.hasEntity('n1'), undefined);
    assert.ok(result.hasEntity('n2'));
  });
});
