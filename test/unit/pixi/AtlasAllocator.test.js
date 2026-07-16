import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { AtlasAllocator } from '../../../modules/pixi/lib/AtlasAllocator.js';


describe('AtlasAllocator stats', () => {
  it('starts empty', () => {
    const allocator = new AtlasAllocator('test', 64);
    assert.deepEqual(allocator.getStats(), { slabs: 0, items: 0, size: 64 });
  });

  it('evicts empty overflow slabs', () => {
    const allocator = new AtlasAllocator('test', 64);
    assert.equal(allocator.evict(), 0);
  });

  it('reports allocator size after no-op eviction', () => {
    const allocator = new AtlasAllocator('test', 128);
    allocator.evict();
    assert.deepEqual(allocator.getStats(), { slabs: 0, items: 0, size: 128 });
  });
});
