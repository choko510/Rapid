import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('cache_policy', () => {
  it('utilLRUSetAdd marks existing values as most recent', () => {
    const set = new Set(['a', 'b', 'c']);
    Rapid.utilLRUSetAdd(set, 'b');
    assert.deepEqual([...set], ['a', 'c', 'b']);
  });

  it('utilLRUSetTrim evicts least recent values first', () => {
    const set = new Set(['a', 'b', 'c', 'd']);
    const evicted = [];
    const trimmed = Rapid.utilLRUSetTrim(set, 2, val => evicted.push(val));

    assert.deepEqual(trimmed, ['a', 'b']);
    assert.deepEqual(evicted, ['a', 'b']);
    assert.deepEqual([...set], ['c', 'd']);
  });

  it('utilLRUMapSet marks existing keys as most recent', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ]);

    Rapid.utilLRUMapSet(map, 'b', 20);
    assert.deepEqual([...map.entries()], [['a', 1], ['c', 3], ['b', 20]]);
  });

  it('utilLRUMapTrim evicts least recent keys first', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4]
    ]);
    const evicted = [];
    const trimmed = Rapid.utilLRUMapTrim(map, 2, (value, key) => evicted.push([key, value]));

    assert.deepEqual(trimmed, ['a', 'b']);
    assert.deepEqual(evicted, [['a', 1], ['b', 2]]);
    assert.deepEqual([...map.entries()], [['c', 3], ['d', 4]]);
  });
});
