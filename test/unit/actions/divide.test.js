import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('divideRectangle', () => {
  it('splits a quadrilateral into a grid', () => {
    const [A, B, C, D] = [[0, 2], [3, 5], [5, 3], [2, 0]];
    const result = Rapid.divideRectangle(2, 3, [A, B, C, D]);

    assert.equal(result.isValid, true);
    assert.equal(result.newShapes.length, 6);
    assert.equal(result.outerRing.length, 10);
  });
});


describe('actionDivide', () => {
  const viewport = {
    project: loc => loc,
    unproject: point => point
  };

  it('returns disabled states for unsupported ways', () => {
    let graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0] }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmWay({ id: 'w', nodes: ['a', 'b', 'c'] })
    ]);

    const action = Rapid.actionDivide('w', viewport);
    assert.equal(action.disabled(graph), 'not_closed');

    graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0] }),
      Rapid.osmNode({ id: 'c', loc: [1, 1] }),
      Rapid.osmWay({ id: 'w', nodes: ['a', 'b', 'c', 'a'], tags: { area: 'yes' } })
    ]);
    assert.equal(action.disabled(graph), 'less_than_four_nodes');
  });

  it('divides a 4-corner area and preserves tags', () => {
    const tags = { amenity: 'parking_space' };
    let graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [2, 0] }),
      Rapid.osmNode({ id: 'c', loc: [2, 2] }),
      Rapid.osmNode({ id: 'd', loc: [0, 2] }),
      Rapid.osmWay({ id: 'w', nodes: ['a', 'b', 'c', 'd', 'a'], tags: tags })
    ]);

    const action = Rapid.actionDivide('w', viewport);
    graph = action(2, 2)(graph);

    const createdWayIDs = action.getCreatedWayIDs();
    assert.equal(createdWayIDs.length, 4);

    for (const wayID of createdWayIDs) {
      const way = graph.entity(wayID);
      assert.equal(way.type, 'way');
      assert.equal(way.nodes[0], way.nodes[way.nodes.length - 1]);
      assert.deepEqual(way.tags, tags);
    }
  });
});
