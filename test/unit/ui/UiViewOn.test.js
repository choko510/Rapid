import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import * as Rapid from '../../../modules/headless.js';
import { UiViewOn } from '../../../modules/ui/UiViewOn.js';


describe('UiViewOn', () => {

  describe('.findLastModifiedChild', () => {
    it('returns the latest timestamp from a way and its child nodes', () => {
      const n1 = Rapid.osmNode({ id: 'n1', timestamp: '2021-01-01T00:00:00Z' });
      const n2 = Rapid.osmNode({ id: 'n2', timestamp: '2023-01-01T00:00:00Z' });
      const way = Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], timestamp: '2022-01-01T00:00:00Z' });
      const graph = new Rapid.Graph([n1, n2, way]);

      const result = UiViewOn.findLastModifiedChild(graph, way);
      assert.equal(result, n2);
    });


    it('returns the latest timestamp from nested relation members', () => {
      const n1 = Rapid.osmNode({ id: 'n1', timestamp: '2020-01-01T00:00:00Z' });
      const n2 = Rapid.osmNode({ id: 'n2', timestamp: '2021-01-01T00:00:00Z' });
      const n3 = Rapid.osmNode({ id: 'n3', timestamp: '2022-01-01T00:00:00Z' });
      const way1 = Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2'], timestamp: '2022-12-31T00:00:00Z' });
      const way2 = Rapid.osmWay({ id: 'w2', nodes: ['n2', 'n3'], timestamp: '2024-01-01T00:00:00Z' });
      const inner = Rapid.osmRelation({
        id: 'r2',
        timestamp: '2023-01-01T00:00:00Z',
        members: [{ id: 'w2', type: 'way', role: 'outer' }]
      });
      const outer = Rapid.osmRelation({
        id: 'r1',
        timestamp: '2019-01-01T00:00:00Z',
        members: [
          { id: 'w1', type: 'way', role: 'outer' },
          { id: 'r2', type: 'relation', role: '' }
        ]
      });
      const graph = new Rapid.Graph([n1, n2, n3, way1, way2, inner, outer]);

      const result = UiViewOn.findLastModifiedChild(graph, outer);
      assert.equal(result, way2);
    });


    it('handles cyclical relation members without recursion overflow', () => {
      const relation1 = Rapid.osmRelation({
        id: 'r1',
        timestamp: '2021-01-01T00:00:00Z',
        members: [{ id: 'r2', type: 'relation', role: '' }]
      });
      const relation2 = Rapid.osmRelation({
        id: 'r2',
        timestamp: '2022-01-01T00:00:00Z',
        members: [{ id: 'r1', type: 'relation', role: '' }]
      });
      const graph = new Rapid.Graph([relation1, relation2]);

      const result = UiViewOn.findLastModifiedChild(graph, relation1);
      assert.equal(result, relation2);
    });


    it('considers node members inside relations', () => {
      const node = Rapid.osmNode({ id: 'n1', timestamp: '2025-01-01T00:00:00Z' });
      const relation = Rapid.osmRelation({
        id: 'r1',
        timestamp: '2024-01-01T00:00:00Z',
        members: [{ id: 'n1', type: 'node', role: 'label' }]
      });
      const graph = new Rapid.Graph([node, relation]);

      const result = UiViewOn.findLastModifiedChild(graph, relation);
      assert.equal(result, node);
    });
  });
});
