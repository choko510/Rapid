import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';


describe('Field', () => {
  it('does not attempt to resolve non-string references', () => {
    const field = new Rapid.Field({}, 'leaf_type_singular', {
      key: 'leaf_type',
      type: 'combo',
      icons: { broadleaved: 'temaki-tree_broadleaved' }
    }, {});

    assert.equal(field._resolveReference('icons'), field);
  });

  it('resolves string cross references to other fields', () => {
    const allFields = {};
    const referenced = new Rapid.Field({}, 'leaf_type', {
      key: 'leaf_type',
      type: 'combo'
    }, allFields);
    allFields.leaf_type = referenced;

    const field = new Rapid.Field({}, 'leaf_type_singular', {
      key: 'leaf_type',
      type: 'combo',
      icons: '{leaf_type}'
    }, allFields);

    assert.equal(field._resolveReference('icons'), referenced);
  });
});
