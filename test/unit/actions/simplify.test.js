import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('actionSimplify', () => {
  const viewport = new Rapid.sdk.Viewport();

  describe('#disabled', () => {
    it('returns "nothing_to_simplify" for ways without simplifiable vertices', () => {
      const graph = new Rapid.Graph([
        Rapid.osmNode({ id: 'a', loc: [0, 0] }),
        Rapid.osmNode({ id: 'b', loc: [1, 0] }),
        Rapid.osmWay({ id: '-', nodes: ['a', 'b'] })
      ]);

      assert.equal(Rapid.actionSimplify('-', viewport).disabled(graph), 'nothing_to_simplify');
    });
  });


  it('removes nearly-collinear intermediate nodes from a line', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0.01] }),
      Rapid.osmNode({ id: 'c', loc: [2, -0.01] }),
      Rapid.osmNode({ id: 'd', loc: [3, 0] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c', 'd'] })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'd']);
    assert.equal(result.hasEntity('b'), undefined);
    assert.equal(result.hasEntity('c'), undefined);
  });


  it('does not remove mildly bent nodes by default', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0.07] }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c'] })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'b', 'c']);
    assert.ok(result.hasEntity('b'));
  });


  it('does not remove non-collinear nodes', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 1] }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c'] })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'b', 'c']);
    assert.ok(result.hasEntity('b'));
  });


  it('does not remove tagged nodes', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0.01], tags: { foo: 'bar' } }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c'] })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'b', 'c']);
    assert.ok(result.hasEntity('b'));
  });


  it('does not remove nodes connected to other ways', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0.01] }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c'] }),
      Rapid.osmWay({ id: '=', nodes: ['b'] })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'b', 'c']);
    assert.ok(result.hasEntity('b'));
  });


  it('does not remove nodes that are relation members', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0.01] }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c'] }),
      Rapid.osmRelation({
        id: 'r',
        members: [{ id: 'b', type: 'node', role: 'via' }]
      })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'b', 'c']);
    assert.ok(result.hasEntity('b'));
  });


  it('removes nearly-collinear nodes from closed ways', () => {
    const graph = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', loc: [0, 0] }),
      Rapid.osmNode({ id: 'b', loc: [1, 0] }),
      Rapid.osmNode({ id: 'c', loc: [2, 0] }),
      Rapid.osmNode({ id: 'd', loc: [2, 1] }),
      Rapid.osmNode({ id: 'e', loc: [0, 1] }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b', 'c', 'd', 'e', 'a'], tags: { area: 'yes' } })
    ]);

    const result = Rapid.actionSimplify('-', viewport)(graph);
    assert.deepEqual(result.entity('-').nodes, ['a', 'c', 'd', 'e', 'a']);
    assert.equal(result.hasEntity('b'), undefined);
  });
});
