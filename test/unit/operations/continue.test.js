import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import * as Rapid from '../../../modules/headless.js';
import { operationContinue } from '../../../modules/operations/continue.js';


describe('operationContinue', () => {
  let graph;
  let origWindow;

  function makeContext() {
    return {
      systems: {
        editor: {
          get staging() { return { graph: graph }; }
        },
        filters: {
          hasHiddenConnections() { return false; }
        },
        l10n: {
          t: id => id
        }
      },
      enter() {}
    };
  }

  function makeLineGraph(vertexAttrs = {}) {
    return new Rapid.Graph([
      Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
      Rapid.osmNode({ id: 'n2', loc: [1, 0], ...vertexAttrs }),
      Rapid.osmNode({ id: 'n3', loc: [2, 0] }),
      Rapid.osmWay({ id: 'w1', nodes: ['n1', 'n2', 'n3'], tags: { highway: 'residential' } })
    ]);
  }

  beforeEach(() => {
    origWindow = globalThis.window;
    globalThis.window = { mocha: true };
  });

  afterEach(() => {
    if (origWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = origWindow;
    }
  });


  it('disables continuing from an interior node with interesting tags', () => {
    graph = makeLineGraph({ tags: { highway: 'traffic_signals' } });
    const context = makeContext();

    const operation = operationContinue(context, ['n2']);
    assert.equal(operation.disabled(), 'not_eligible');
  });


  it('disables continuing from an interior node in a relation', () => {
    graph = makeLineGraph();
    const relation = Rapid.osmRelation({
      id: 'r1',
      tags: { type: 'route' },
      members: [{ id: 'n2', type: 'node', role: 'via' }]
    });
    graph = graph.replace(relation);

    const context = makeContext();
    const operation = operationContinue(context, ['n2']);
    assert.equal(operation.disabled(), 'not_eligible');
  });


  it('allows continuing from an interior node without semantic data', () => {
    graph = makeLineGraph();
    const context = makeContext();

    const operation = operationContinue(context, ['n2']);
    assert.equal(operation.disabled(), false);
  });
});
