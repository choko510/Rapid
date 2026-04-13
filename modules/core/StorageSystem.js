import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

import { AbstractSystem } from './AbstractSystem.js';

/**
 * `StorageSystem` is a wrapper around `window.localStorage`
 * It is used to store user preferences (good)
 * and some fallback data used during migration.
 *
 * n.b.:  `localStorage` is a _synchronous_ API.
 * For larger and frequent writes (like edit-history backups),
 * prefer the async `indexedDB` helpers below.
 */
export class StorageSystem extends AbstractSystem {

  /**
   * @constructor
   * @param  context  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'storage';   // was: 'prefs'
    this.dependencies = new Set();

    this._storage = null;

    // Note that accessing localStorage may throw a `SecurityError`, so wrap in a try/catch.
    try {
      this._storage = window.localStorage;
    } catch (e) {
      this._mock = new Map();
      this._storage = {
        isMocked: true,
        hasItem: (k) => this._mock.has(k),
        getItem: (k) => this._mock.get(k),
        setItem: (k, v) => this._mock.set(k, v),
        removeItem: (k) => this._mock.delete(k),
        clear: () => this._mock.clear()
      };
    }
  }


  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    for (const id of this.dependencies) {
      if (!this.context.systems[id]) {
        return Promise.reject(`Cannot init:  ${this.id} requires ${id}`);
      }
    }
    return Promise.resolve();
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    this._started = true;
    return Promise.resolve();
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    return Promise.resolve();
  }


  /**
   * hasItem
   * @param   k  String key to check for existance
   * @return  `true` if the key is set, `false` if not
   */
  hasItem(k) {
    return !!this._storage.getItem(k);
  }


  /**
   * getItem
   * @param   k  String key to get the value for
   * @return  The stored value, or `null` if not found
   */
  getItem(k) {
    return this._storage.getItem(k);
  }


  /**
   * setItem
   * @param   k  String key to set the value for
   * @param   v  String value to set
   * @return  `true` if the write to `localStorage` succeeded, `false` if it failed
   */
  setItem(k, v) {
    try {
      this._storage.setItem(k, v);
      return !this._storage.isMocked;
    } catch (e) {
      console.error('localStorage quota exceeded');  // eslint-disable-line no-console
    }
    return false;
  }


  /**
   * removeItem
   * @param   k  String key to remove from storage
   */
  removeItem(k) {
    this._storage.removeItem(k);
  }


  /**
   * clear
   * Clears all values from the storage
   */
  clear() {
    this._storage.clear();
  }


  /**
   * hasItemAsync
   * @param   k  String key to check for existance
   * @param   options  Optional settings
   * @return  Promise resolving `true` if the key is set, `false` if not
   */
  async hasItemAsync(k, options = {}) {
    return (await this.getItemAsync(k, options)) !== null;
  }


  /**
   * getItemAsync
   * @param   k  String key to get the value for
   * @param   options  Optional settings
   * @return  Promise resolving to the stored value, or `null` if not found
   */
  async getItemAsync(k, options = {}) {
    const preferIndexedDB = options.preferIndexedDB === true;
    if (preferIndexedDB) {
      try {
        const val = await idbGet(k);
        if (val !== undefined && val !== null) {
          return val;
        }
      } catch (e) {
        console.error('indexedDB read failed');   // eslint-disable-line no-console
      }
    }

    return this.getItem(k);
  }


  /**
   * setItemAsync
   * @param   k  String key to set the value for
   * @param   v  Value to set
   * @param   options  Optional settings
   * @return  Promise resolving `true` if the write to `indexedDB` succeeded, `false` if it failed
   */
  async setItemAsync(k, v, options = {}) {
    const preferIndexedDB = options.preferIndexedDB === true;
    if (preferIndexedDB) {
      try {
        await idbSet(k, v);
        return true;
      } catch (e) {
        console.error('indexedDB write failed');  // eslint-disable-line no-console
        return false;
      }
    }

    return this.setItem(k, v);
  }


  /**
   * removeItemAsync
   * @param   k  String key to remove from storage
   * @param   options  Optional settings
   * @return  Promise resolving `true` if removal succeeded, `false` if it failed
   */
  async removeItemAsync(k, options = {}) {
    const preferIndexedDB = options.preferIndexedDB === true;
    if (preferIndexedDB) {
      try {
        await idbDel(k);
      } catch (e) {
        console.error('indexedDB delete failed');  // eslint-disable-line no-console
      }
    }
    this.removeItem(k);
    return true;
  }


  /**
   * migrateItemToAsync
   * Migrate a key from sync localStorage into async indexedDB.
   * @param   k  String key to migrate
   * @return  Promise resolving `true` when a key was migrated successfully, otherwise `false`
   */
  async migrateItemToAsync(k) {
    const val = this.getItem(k);
    if (val === null) return false;

    const status = await this.setItemAsync(k, val, { preferIndexedDB: true });
    if (status) {
      this.removeItem(k);
    }

    return status;
  }
}
