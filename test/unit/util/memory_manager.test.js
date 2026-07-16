import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { MemoryManager } from '../../../modules/core/MemoryManager.js';


if (!global.window) {
  global.window = {};
}
window.setTimeout ??= setTimeout;
window.clearTimeout ??= clearTimeout;
window.requestIdleCallback ??= callback => window.setTimeout(() => callback({ timeRemaining: () => 50 }), 0);
window.cancelIdleCallback ??= clearTimeout;


function makeContext() {
  return {};
}


describe('MemoryManager', () => {
  it('registers providers and collects stats', () => {
    const manager = new MemoryManager(makeContext());
    const provider = {
      getStats: () => ({ items: 3 }),
      evict: () => 0
    };

    manager.register('test', provider);

    assert.deepEqual(manager.stats(), { test: { items: 3 } });
    assert.equal(manager.getStats().providers, 1);
  });

  it('ignores invalid providers', () => {
    const manager = new MemoryManager(makeContext());
    manager.register('bad', {});
    assert.deepEqual(manager.stats(), {});
  });

  it('isolates provider stats failures', () => {
    const manager = new MemoryManager(makeContext());
    manager.register('bad', {
      getStats: () => { throw new Error('broken'); },
      evict: () => 0
    });
    assert.deepEqual(manager.stats(), { bad: null });
  });

  it('excludes manager telemetry provider from nested stats', () => {
    const manager = new MemoryManager(makeContext());
    manager.register('tiles', {
      getStats: () => ({ items: 2 }),
      evict: () => 0
    });
    assert.deepEqual(manager.stats('tiles'), {});
  });
});
