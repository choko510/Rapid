describe('StorageSystem', () => {
  let _storage;
  let _key;

  beforeEach(() => {
    _storage = new Rapid.StorageSystem({ systems: {} });
    _key = `storage_test_${Date.now()}`;
    return _storage.initAsync();
  });

  afterEach(() => {
    _storage.removeItem(_key);
    return _storage.removeItemAsync(_key);
  });

  describe('#setItemAsync / #getItemAsync / #hasItemAsync / #removeItemAsync', () => {
    it('stores and removes async values', () => {
      return _storage.setItemAsync(_key, 'value')
        .then(status => {
          expect(status).to.be.true;
          return _storage.hasItemAsync(_key);
        })
        .then(hasValue => {
          expect(hasValue).to.be.true;
          return _storage.getItemAsync(_key);
        })
        .then(value => {
          expect(value).to.eql('value');
          return _storage.removeItemAsync(_key);
        })
        .then(status => {
          expect(status).to.be.true;
          return _storage.hasItemAsync(_key);
        })
        .then(hasValue => {
          expect(hasValue).to.be.false;
        });
    });
  });

  describe('#migrateItemToAsync', () => {
    it('moves a localStorage value into async storage', () => {
      _storage.setItem(_key, 'legacy-value');

      return _storage.migrateItemToAsync(_key)
        .then(status => {
          expect(status).to.be.true;
          expect(_storage.hasItem(_key)).to.be.false;
          return _storage.getItemAsync(_key);
        })
        .then(value => {
          expect(value).to.eql('legacy-value');
        });
    });
  });
});
