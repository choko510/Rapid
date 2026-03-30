import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('Difference', () => {
  describe('constructor', () => {
    it('constructs a Difference between 2 Graphs', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff instanceof Rapid.Difference);
      assert.ok(diff.changes instanceof Map);
      assert.ok(diff.changes.has('n'));
    });

    it('constructs an empty Difference if base and head are the same', () => {
      const base = new Rapid.Graph();
      const diff = new Rapid.Difference(base, base);
      assert.ok(diff instanceof Rapid.Difference);
      assert.ok(diff.changes instanceof Map);
      assert.equal(diff.changes.size, 0);
    });
  });

  describe('#changes', () => {
    it('includes created entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.deepEqual(diff.changes.get('n'), { base: undefined, head: node });
    });

    it('includes undone created entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(head, base);
      assert.ok(diff.changes instanceof Map);
      assert.deepEqual(diff.changes.get('n'), { base: node, head: undefined });
    });

    it('includes modified entities', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.update({ tags: { yes: 'no' } });
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.deepEqual(diff.changes.get('n'), { base: n1, head: n2 });
    });

    it('includes undone modified entities', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.update({ tags: { yes: 'no' } });
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(head, base);
      assert.ok(diff.changes instanceof Map);
      assert.deepEqual(diff.changes.get('n'), { base: n2, head: n1 });
    });

    it('doesn\'t include updated but identical entities', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.update();
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.equal(diff.changes.size, 0);
    });

    it('includes deleted entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph([node]);
      const head = base.remove(node);
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.deepEqual(diff.changes.get('n'), { base: node, head: undefined });
    });

    it('includes undone deleted entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph([node]);
      const head = base.remove(node);
      const diff = new Rapid.Difference(head, base);
      assert.ok(diff.changes instanceof Map);
      assert.deepEqual(diff.changes.get('n'), { base: undefined, head: node });
    });

    it('doesn\'t include created entities that were subsequently deleted', () => {
      const node = Rapid.osmNode();
      const base = new Rapid.Graph();
      const head = base.replace(node).remove(node);
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.equal(diff.changes.size, 0);
    });

    it('doesn\'t include created entities that were subsequently reverted', () => {
      const node = Rapid.osmNode({ id: 'n-1' });
      const base = new Rapid.Graph();
      const head = base.replace(node).revert('n-1');
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.equal(diff.changes.size, 0);
    });

    it('doesn\'t include modified entities that were subsequently reverted', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.update({ tags: { yes: 'no' } });
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2).revert('n');
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.equal(diff.changes.size, 0);
    });

    it('doesn\'t include deleted entities that were subsequently reverted', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph([node]);
      const head = base.remove(node).revert('n');
      const diff = new Rapid.Difference(base, head);
      assert.ok(diff.changes instanceof Map);
      assert.equal(diff.changes.size, 0);
    });

    it('tracks geometry and property changes independently', () => {
      const n1 = Rapid.osmNode({ id: 'n', loc: [0, 0], tags: { amenity: 'bench' } });
      const n2 = n1.move([1, 1]);
      const n3 = n1.mergeTags({ amenity: 'cafe' });

      const base = new Rapid.Graph([n1]);
      const moved = base.replace(n2);
      const retagged = base.replace(n3);

      const movedDiff = new Rapid.Difference(base, moved);
      assert.equal(movedDiff.hasGeometryChange('n'), true);
      assert.equal(movedDiff.hasPropertyChange('n'), false);

      const retaggedDiff = new Rapid.Difference(base, retagged);
      assert.equal(retaggedDiff.hasGeometryChange('n'), false);
      assert.equal(retaggedDiff.hasPropertyChange('n'), true);
    });
  });


  describe('#created', () => {
    it('returns an array of created entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);
      assert.deepEqual(diff.created(), [node]);
    });

    it('returns a fresh array instance each call', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);
      const created1 = diff.created();
      const created2 = diff.created();
      assert.notEqual(created1, created2);
      assert.deepEqual(created1, created2);
    });
  });

  describe('#modified', () => {
    it('returns an array of modified entities', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      assert.deepEqual(diff.modified(), [n2]);
    });

    it('returns a fresh array instance each call', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const modified1 = diff.modified();
      const modified2 = diff.modified();
      assert.notEqual(modified1, modified2);
      assert.deepEqual(modified1, modified2);
    });
  });

  describe('#modifiedGeometry', () => {
    it('returns only entities with geometry changes', () => {
      const n1 = Rapid.osmNode({ id: 'n', loc: [0, 0], tags: { amenity: 'bench' } });
      const n2 = n1.move([1, 1]);
      const n3 = n1.mergeTags({ amenity: 'cafe' });

      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2).replace(n3);
      const diff = new Rapid.Difference(base, head);
      const modifiedGeometry = diff.modifiedGeometry();

      assert.deepEqual(modifiedGeometry, []);
    });

    it('includes moved entities and excludes tag-only entities', () => {
      const n1 = Rapid.osmNode({ id: 'n1', loc: [0, 0], tags: { amenity: 'bench' } });
      const n2 = Rapid.osmNode({ id: 'n2', loc: [0, 0], tags: { amenity: 'bench' } });
      const moved = n1.move([1, 1]);
      const retagged = n2.mergeTags({ amenity: 'cafe' });

      const base = new Rapid.Graph([n1, n2]);
      const head = base.replace(moved).replace(retagged);
      const diff = new Rapid.Difference(base, head);
      const modifiedGeometry = diff.modifiedGeometry();

      assert.deepEqual(modifiedGeometry, [moved]);
    });

    it('returns a fresh array instance each call', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const modified1 = diff.modifiedGeometry();
      const modified2 = diff.modifiedGeometry();
      assert.notEqual(modified1, modified2);
      assert.deepEqual(modified1, modified2);
    });
  });

  describe('#deleted', () => {
    it('returns an array of deleted entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph([node]);
      const head = base.remove(node);
      const diff = new Rapid.Difference(base, head);
      assert.deepEqual(diff.deleted(), [node]);
    });

    it('returns a fresh array instance each call', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph([node]);
      const head = base.remove(node);
      const diff = new Rapid.Difference(base, head);
      const deleted1 = diff.deleted();
      const deleted2 = diff.deleted();
      assert.notEqual(deleted1, deleted2);
      assert.deepEqual(deleted1, deleted2);
    });
  });

  describe('#summary', () => {
    const base = new Rapid.Graph([
      Rapid.osmNode({ id: 'a', tags: { crossing: 'marked' }}),
      Rapid.osmNode({ id: 'b' }),
      Rapid.osmNode({ id: 'v' }),
      Rapid.osmWay({ id: '-', nodes: ['a', 'b']})
    ]);

    it('reports a created way as created', () => {
      const way = Rapid.osmWay({ id: '+' });
      const head = base.replace(way);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('+'), { changeType: 'created', entity: way, graph: head });
    });

    it('reports a deleted way as deleted', () => {
      const way = base.entity('-');
      const head = base.remove(way);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'deleted', entity: way, graph: base });
    });

    it('reports a modified way as modified', () => {
      const way = base.entity('-').mergeTags({highway: 'primary' });
      const head = base.replace(way);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: way, graph: head });
    });

    it('reports a way as modified when a member vertex is moved', () => {
      const vertex = base.entity('b').move([0,3]);
      const head = base.replace(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: head.entity('-'), graph: head });
    });

    it('reports a way as modified when a member vertex is added', () => {
      const vertex = Rapid.osmNode({ id: 'c' });
      const way = base.entity('-').addNode('c');
      const head = base.replace(vertex).replace(way);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: way, graph: head });
    });

    it('reports a way as modified when a member vertex is removed', () => {
      const way = base.entity('-').removeNode('b');
      const head = base.replace(way);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: way, graph: head });
    });

    it('reports a created way containing a moved vertex as being created', () => {
      const vertex = base.entity('b').move([0,3]);
      const way = Rapid.osmWay({ id: '+', nodes: ['b']});
      const head = base.replace(way).replace(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('+'), { changeType: 'created', entity: way, graph: head });
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: head.entity('-'), graph: head });
    });

    it('reports a created way with a created vertex as being created', () => {
      const vertex = Rapid.osmNode({ id: 'c' });
      const way = Rapid.osmWay({ id: '+', nodes: ['c']});
      const head = base.replace(vertex).replace(way);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('+'), { changeType: 'created', entity: way, graph: head });
    });

    it('reports a vertex as modified when it has tags and they are changed', () => {
      const vertex = base.entity('a').mergeTags({highway: 'traffic_signals' });
      const head = base.replace(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('a'), { changeType: 'modified', entity: vertex, graph: head });
    });

    it('reports a vertex as modified when it has tags and is moved', () => {
      const vertex = base.entity('a').move([1, 2]);
      const head = base.replace(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: head.entity('-'), graph: head });
      assert.deepEqual(summary.get('a'), { changeType: 'modified', entity: vertex, graph: head });
    });

    it('does not report a vertex as modified when it is moved and has no-op tag changes', () => {
      const vertex = base.entity('b').update({tags: {}, loc: [1, 2]});
      const head = base.replace(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: head.entity('-'), graph: head });
    });

    it('reports a vertex as deleted when it had tags', () => {
      const vertex = base.entity('v');
      const head = base.remove(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('v'), { changeType: 'deleted', entity: vertex, graph: base });
    });

    it('reports a vertex as created when it has tags', () => {
      const vertex = Rapid.osmNode({ id: 'c', tags: {crossing: 'marked' }});
      const way = base.entity('-').addNode('c');
      const head = base.replace(way).replace(vertex);
      const diff = new Rapid.Difference(base, head);
      const summary = diff.summary();
      assert.ok(summary instanceof Map);
      assert.deepEqual(summary.get('-'), { changeType: 'modified', entity: way, graph: head });
      assert.deepEqual(summary.get('c'), { changeType: 'created', entity: vertex, graph: head });
    });

    it('returns a fresh map instance each call', () => {
      const way = Rapid.osmWay({ id: '+' });
      const head = base.replace(way);
      const diff = new Rapid.Difference(base, head);
      const summary1 = diff.summary();
      const summary2 = diff.summary();
      assert.notEqual(summary1, summary2);
      assert.deepEqual([...summary1.entries()], [...summary2.entries()]);
    });
  });

  describe('#complete', () => {
    it('includes created entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), node);
    });

    it('includes modified entities', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const base = new Rapid.Graph([n1]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), n2);
    });

    it('includes deleted entities', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph([node]);
      const head = base.remove(node);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), undefined);
    });

    it('includes nodes added to a way', () => {
      const n1 = Rapid.osmNode({ id: 'n1' });
      const n2 = Rapid.osmNode({ id: 'n2' });
      const w1 = Rapid.osmWay({ id: 'w', nodes: ['n1']});
      const w2 = w1.addNode('n2');
      const base = new Rapid.Graph([n1, n2, w1]);
      const head = base.replace(w2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('w'), w2);
      assert.equal(complete.get('n1'), n1);
      assert.equal(complete.get('n2'), n2);
    });

    it('includes nodes removed from a way', () => {
      const n1 = Rapid.osmNode({ id: 'n1' });
      const n2 = Rapid.osmNode({ id: 'n2' });
      const w1 = Rapid.osmWay({ id: 'w', nodes: ['n1', 'n2']});
      const w2 = w1.removeNode('n2');
      const base = new Rapid.Graph([n1, n2, w1]);
      const head = base.replace(w2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('w'), w2);
      assert.equal(complete.get('n1'), n1);
      assert.equal(complete.get('n2'), n2);
    });

    it('includes multipolygon members', () => {
      const w1 = Rapid.osmWay({ id: 'w1' });
      const w2 = Rapid.osmWay({ id: 'w2' });
      const r1 = Rapid.osmRelation({
        id: 'r',
        tags: { type: 'multipolygon' },
        members: [{role: 'outer', id: 'w1', type: 'way' }, {role: '', id: 'w2', type: 'way' }]
      });
      const r2 = r1.updateMember({role: 'inner', id: 'w2', type: 'way' }, 1);
      const base = new Rapid.Graph([w1, w2, r1]);
      const head = base.replace(r2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('r'), r2);
      assert.equal(complete.get('w1'), w1);
      assert.equal(complete.get('w2'), w2);
    });

    it('includes parent ways of modified nodes', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const w = Rapid.osmWay({ id: 'w', nodes: ['n']});
      const base = new Rapid.Graph([n1, w]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), n2);
      assert.equal(complete.get('w'), w);
    });

    it('includes parent relations of modified entities', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const r = Rapid.osmRelation({ id: 'r', members: [{ id: 'n' }]});
      const base = new Rapid.Graph([n1, r]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), n2);
      assert.equal(complete.get('r'), r);
    });

    it('includes parent relations of modified entities, recursively', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const r1 = Rapid.osmRelation({ id: 'r1', members: [{ id: 'n' }]});
      const r2 = Rapid.osmRelation({ id: 'r2', members: [{ id: 'r1' }]});
      const base = new Rapid.Graph([n1, r1, r2]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), n2);
      assert.equal(complete.get('r1'), r1);
      assert.equal(complete.get('r2'), r2);
    });

    it('includes parent relations of parent ways of modified nodes', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const w = Rapid.osmWay({ id: 'w', nodes: ['n']});
      const r = Rapid.osmRelation({ id: 'r', members: [{ id: 'w' }]});
      const base = new Rapid.Graph([n1, w, r]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), n2);
      assert.equal(complete.get('w'), w);
      assert.equal(complete.get('r'), r);
    });

    it('copes with recursive relations', () => {
      const n1 = Rapid.osmNode({ id: 'n' });
      const n2 = n1.move([1, 2]);
      const r1 = Rapid.osmRelation({ id: 'r1', members: [{ id: 'n' }, { id: 'r2' }]});
      const r2 = Rapid.osmRelation({ id: 'r2', members: [{ id: 'r1' }]});
      const base = new Rapid.Graph([n1, r1, r2]);
      const head = base.replace(n2);
      const diff = new Rapid.Difference(base, head);
      const complete = diff.complete();
      assert.ok(complete instanceof Map);
      assert.equal(complete.get('n'), n2);
      assert.equal(complete.get('r1'), r1);
      assert.equal(complete.get('r2'), r2);
    });

    it('returns a fresh map instance each call', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);
      const complete1 = diff.complete();
      const complete2 = diff.complete();
      assert.notEqual(complete1, complete2);
      assert.deepEqual([...complete1.entries()], [...complete2.entries()]);
    });

  });

  describe('#completeEntityIDs', () => {
    it('returns the complete set of affected ids', () => {
      const n1 = Rapid.osmNode({ id: 'n1' });
      const n2 = Rapid.osmNode({ id: 'n2' });
      const w1 = Rapid.osmWay({ id: 'w1', nodes: ['n1'] });
      const w2 = w1.addNode('n2');
      const base = new Rapid.Graph([n1, n2, w1]);
      const head = base.replace(w2);
      const diff = new Rapid.Difference(base, head);

      const ids = diff.completeEntityIDs();
      assert.ok(ids instanceof Set);
      assert.deepEqual([...ids].sort(), ['n1', 'n2', 'w1']);
    });

    it('returns a fresh set instance each call', () => {
      const node = Rapid.osmNode({ id: 'n' });
      const base = new Rapid.Graph();
      const head = base.replace(node);
      const diff = new Rapid.Difference(base, head);

      const ids1 = diff.completeEntityIDs();
      const ids2 = diff.completeEntityIDs();
      assert.notEqual(ids1, ids2);
      assert.deepEqual([...ids1], [...ids2]);
    });
  });
});
