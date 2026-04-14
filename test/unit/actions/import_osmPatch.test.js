import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('actionImportOsmPatch', () => {
  it('edits and moves an existing node', () => {
    const node = Rapid.osmNode({ id: 'n1', loc: [0, 0], tags: { existing: 'tag' } });
    const graph = new Rapid.Graph([node]);

    const osmPatch = {
      features: [
        {
          id: 'n1',
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { __action: 'edit', name: 'Imported Name' }
        },
        {
          id: 'n1',
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[0, 0], [2, 3]] },
          properties: { __action: 'move' }
        }
      ]
    };

    const result = Rapid.actionImportOsmPatch(osmPatch)(graph);
    assert.deepEqual(result.entity('n1').tags, { existing: 'tag', name: 'Imported Name' });
    assert.deepEqual(result.entity('n1').loc, [2, 3]);
  });


  it('deletes entities by OSM id prefix', () => {
    const n1 = Rapid.osmNode({ id: 'n1', loc: [0, 0] });
    const w1 = Rapid.osmWay({ id: 'w1', nodes: ['n1'] });
    const graph = new Rapid.Graph([n1, w1]);

    const osmPatch = {
      features: [
        {
          id: 'w1',
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [] },
          properties: { __action: 'delete' }
        }
      ]
    };

    const result = Rapid.actionImportOsmPatch(osmPatch)(graph);
    assert.equal(result.hasEntity('w1'), undefined);
  });


  it('throws if a move action targets a non-node', () => {
    const way = Rapid.osmWay({ id: 'w1', nodes: [] });
    const graph = new Rapid.Graph([way]);

    const osmPatch = {
      features: [
        {
          id: 'w1',
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
          properties: { __action: 'move' }
        }
      ]
    };

    assert.throws(
      () => Rapid.actionImportOsmPatch(osmPatch)(graph),
      /trying to move a non-node/
    );
  });


  it('skips delete actions for entities already deleted earlier in the patch', () => {
    const node = Rapid.osmNode({ id: 'n1', loc: [0, 0] });
    const graph = new Rapid.Graph([node]);

    const osmPatch = {
      features: [
        {
          id: 'n1',
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { __action: 'delete' }
        },
        {
          id: 'n1',
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { __action: 'delete' }
        }
      ]
    };

    const result = Rapid.actionImportOsmPatch(osmPatch)(graph);
    assert.equal(result.hasEntity('n1'), undefined);
  });


  it('updates only one matching relation member occurrence', () => {
    const node = Rapid.osmNode({ id: 'n1', loc: [0, 0] });
    const relation = Rapid.osmRelation({
      id: 'r1',
      tags: { type: 'route' },
      members: [
        { id: 'n1', type: 'node', role: 'stop' },
        { id: 'n1', type: 'node', role: 'platform' }
      ]
    });
    const graph = new Rapid.Graph([node, relation]);

    const osmPatch = {
      features: [
        {
          id: 'r1',
          type: 'Feature',
          geometry: { type: 'GeometryCollection', geometries: [] },
          properties: {
            __action: 'edit',
            __members: [{ type: 'node', ref: 1, role: 'via' }]
          }
        }
      ]
    };

    const result = Rapid.actionImportOsmPatch(osmPatch)(graph);
    assert.deepEqual(result.entity('r1').members, [
      { id: 'n1', type: 'node', role: 'via' },
      { id: 'n1', type: 'node', role: 'platform' }
    ]);
  });
});
