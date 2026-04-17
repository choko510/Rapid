/**
 * utilLRUSetAdd
 * Add a value to a Set and mark it as most recently used.
 * @param   {Set}  set
 * @param   {*}    value
 * @return  {Set}
 */
export function utilLRUSetAdd(set, value) {
  if (set.has(value)) {
    set.delete(value);
  }
  set.add(value);
  return set;
}


/**
 * utilLRUSetTrim
 * Trim a Set down to `maxSize`, evicting least-recently-used entries.
 * @param   {Set}        set
 * @param   {number}     maxSize
 * @param   {Function?}  onEvict  callback(value)
 * @return  {Array}      evicted values
 */
export function utilLRUSetTrim(set, maxSize, onEvict) {
  if (!(set instanceof Set)) return [];
  if (!Number.isFinite(maxSize) || maxSize < 0) return [];

  const evicted = [];
  while (set.size > maxSize) {
    const value = set.values().next().value;
    set.delete(value);
    evicted.push(value);
    if (onEvict) onEvict(value);
  }
  return evicted;
}


/**
 * utilLRUMapSet
 * Set a key/value in a Map and mark the key as most recently used.
 * @param   {Map}  map
 * @param   {*}    key
 * @param   {*}    value
 * @return  {Map}
 */
export function utilLRUMapSet(map, key, value) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  return map;
}


/**
 * utilLRUMapTrim
 * Trim a Map down to `maxSize`, evicting least-recently-used entries.
 * @param   {Map}        map
 * @param   {number}     maxSize
 * @param   {Function?}  onEvict  callback(value, key)
 * @return  {Array}      evicted keys
 */
export function utilLRUMapTrim(map, maxSize, onEvict) {
  if (!(map instanceof Map)) return [];
  if (!Number.isFinite(maxSize) || maxSize < 0) return [];

  const evicted = [];
  while (map.size > maxSize) {
    const first = map.entries().next().value;
    if (!first) break;
    const [key, value] = first;
    map.delete(key);
    evicted.push(key);
    if (onEvict) onEvict(value, key);
  }
  return evicted;
}
