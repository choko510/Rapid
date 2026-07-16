import { AbstractSystem } from './AbstractSystem.js';

const DEFAULT_IDLE_BUDGET_MS = 4;
const DEFAULT_PRESSURE_RATIO = 1.25;


/**
 * MemoryManager coordinates low-priority cache eviction.
 * It only runs work during idle time and never evicts synchronously from a render path.
 */
export class MemoryManager extends AbstractSystem {

  constructor(context) {
    super(context);
    this.id = 'memory';
    this.dependencies = new Set();

    this._providers = new Map();
    this._idleCallbackId = null;
    this._scheduled = false;
    this._lastStats = null;
  }


  initAsync() {
    return Promise.resolve();
  }


  startAsync() {
    this._started = true;
    this._schedule();
    return Promise.resolve();
  }


  resetAsync() {
    this._cancel();
    this._lastStats = null;
    this._schedule();
    return Promise.resolve();
  }


  register(id, provider, priority = 0) {
    if (!id || !provider || typeof provider.getStats !== 'function' || typeof provider.evict !== 'function') {
      return this;
    }

    this._providers.set(id, { provider, priority });
    this._schedule();
    return this;
  }


  unregister(id) {
    this._providers.delete(id);
    return this;
  }


  stats(excludeID = null) {
    const result = {};
    for (const [id, entry] of this._providers) {
      if (id === excludeID) continue;
      try {
        result[id] = entry.provider.getStats();
      } catch {
        result[id] = null;
      }
    }
    return result;
  }


  getStats() {
    return {
      providers: this._providers.size,
      lastStats: this._lastStats
    };
  }


  evict() {
    return 0;
  }


  schedule() {
    this._schedule();
    return this;
  }


  _schedule() {
    if (!this._started || this._scheduled || !this._providers.size) return;
    this._scheduled = true;

    const run = deadline => {
      this._scheduled = false;
      this._idleCallbackId = null;
      this._lastStats = this.stats();

      const start = performance.now();
      const budget = deadline?.timeRemaining ?
        Math.max(1, Math.min(DEFAULT_IDLE_BUDGET_MS, deadline.timeRemaining())) : DEFAULT_IDLE_BUDGET_MS;
      const entries = [...this._providers.values()].sort((a, b) => b.priority - a.priority);

      for (const { provider } of entries) {
        if (performance.now() - start >= budget) break;
        provider.evict({
          maxMs: Math.max(1, budget - (performance.now() - start)),
          pressureRatio: DEFAULT_PRESSURE_RATIO
        });
      }

      this._schedule();
    };

    if (typeof window.requestIdleCallback === 'function') {
      this._idleCallbackId = window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      this._idleCallbackId = window.setTimeout(() => run(null), 1000);
    }
  }


  _cancel() {
    if (this._idleCallbackId === null) return;

    if (typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this._idleCallbackId);
    } else {
      window.clearTimeout(this._idleCallbackId);
    }
    this._idleCallbackId = null;
    this._scheduled = false;
  }
}
