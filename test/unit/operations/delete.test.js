import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import * as Rapid from '../../../modules/headless.js';
import { operationDelete } from '../../../modules/operations/delete.js';


describe('operationDelete', () => {
  let graph;
  let allowLargeEdits;
  let visibleExtent;
  let performCalls;
  let commitCalls;
  let enterCalls;
  let confirmCalls;
  let confirmResult;
  let origWindow;
  let origNavigator;

  function makeContext() {
    const editor = {
      get staging() { return { graph: graph }; },
      perform(action) {
        performCalls.push(action);
        graph = action(graph);
      },
      commit(opts) {
        commitCalls.push(opts);
      }
    };

    return {
      viewport: {
        visibleExtent: () => visibleExtent
      },
      systems: {
        editor: editor,
        l10n: { t: id => id },
        map: { centerEase() {} },
        storage: {
          getItem(key) {
            if (key === 'rapid-internal-feature.allowLargeEdits') {
              return allowLargeEdits ? 'true' : 'false';
            }
            return null;
          }
        }
      },
      services: {},
      inIntro: false,
      hasHiddenConnections() { return false; },
      loadTileAtLoc() {},
      enter(mode) {
        enterCalls.push(mode);
      }
    };
  }

  function makeLargeAreaGraph() {
    return new Rapid.Graph([
      Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
      Rapid.osmNode({ id: 'n2', loc: [10, 0] }),
      Rapid.osmNode({ id: 'n3', loc: [10, 10] }),
      Rapid.osmNode({ id: 'n4', loc: [0, 10] }),
      Rapid.osmWay({ id: 'wArea', nodes: ['n1', 'n2', 'n3', 'n4', 'n1'], tags: { area: 'yes' } })
    ]);
  }

  function makeLargeLineGraph() {
    return new Rapid.Graph([
      Rapid.osmNode({ id: 'n1', loc: [0, 0] }),
      Rapid.osmNode({ id: 'n2', loc: [10, 10] }),
      Rapid.osmWay({ id: 'wLine', nodes: ['n1', 'n2'], tags: { highway: 'residential' } })
    ]);
  }

  beforeEach(() => {
    allowLargeEdits = false;
    visibleExtent = new Rapid.sdk.Extent([0, 0], [0.1, 0.1]);
    performCalls = [];
    commitCalls = [];
    enterCalls = [];
    confirmCalls = [];
    confirmResult = true;

    origWindow = globalThis.window;
    origNavigator = globalThis.navigator;
    globalThis.window = {
      mocha: true,
      top: {
        location: {
          origin: 'http://localhost:9876',
          pathname: '/index.html'
        }
      },
      location: {
        origin: 'http://localhost:9876',
        pathname: '/index.html'
      },
      matchMedia() {
        return { matches: false };
      },
      confirm(message) {
        confirmCalls.push(message);
        return confirmResult;
      }
    };

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        userAgent: 'Mozilla/5.0 Chrome/146.0.0.0',
        appName: 'Netscape',
        appVersion: '5.0',
        languages: ['en-US']
      }
    });
  });

  afterEach(() => {
    if (origWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = origWindow;
    }

    if (origNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: origNavigator
      });
    }
  });


  describe('#disabled', () => {
    it('still blocks too-large non-area deletes', () => {
      graph = makeLargeLineGraph();

      const context = makeContext();
      const result = operationDelete(context, ['wLine']).disabled();

      assert.equal(result, 'too_large');
    });

    it('allows too-large area deletes', () => {
      graph = makeLargeAreaGraph();

      const context = makeContext();
      const result = operationDelete(context, ['wArea']).disabled();

      assert.equal(result, false);
    });
  });


  describe('#operation', () => {
    it('does nothing if large-area delete is not confirmed', () => {
      confirmResult = false;
      graph = makeLargeAreaGraph();

      const context = makeContext();
      const operation = operationDelete(context, ['wArea']);
      operation();

      assert.deepEqual(confirmCalls, ['operations.delete.confirm_too_large']);
      assert.equal(performCalls.length, 0);
      assert.equal(commitCalls.length, 0);
      assert.equal(enterCalls.length, 0);
    });

    it('deletes when large-area delete is confirmed', () => {
      confirmResult = true;
      graph = makeLargeAreaGraph();

      const context = makeContext();
      const operation = operationDelete(context, ['wArea']);
      operation();

      assert.deepEqual(confirmCalls, ['operations.delete.confirm_too_large']);
      assert.equal(performCalls.length, 1);
      assert.equal(commitCalls.length, 1);
      assert.deepEqual(enterCalls, ['browse']);
    });
  });
});
