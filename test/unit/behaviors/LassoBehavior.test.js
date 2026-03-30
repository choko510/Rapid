import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { LassoBehavior } from '../../../modules/behaviors/LassoBehavior.js';


function makeContext(pref = 'false', modifiers = new Set()) {
  return {
    systems: {
      storage: {
        getItem: () => pref
      },
      gfx: {
        events: {
          pointerOverRenderer: true,
          modifierKeys: modifiers,
          on: () => {},
          off: () => {}
        }
      },
      map: {
        mouseLoc: () => [0, 0]
      }
    }
  };
}


describe('LassoBehavior', () => {
  it('reports lasso mode inactive while disabled', () => {
    const behavior = new LassoBehavior(makeContext('true'));
    assert.equal(behavior.isLassoModeActive(), false);
  });

  it('reports lasso mode active while enabled and preference is on', () => {
    const behavior = new LassoBehavior(makeContext('true'));
    behavior.enable();
    assert.equal(behavior.isLassoModeActive(), true);
  });

  it('does not start lasso from pointerdown when preference is off and shift is not pressed', () => {
    const behavior = new LassoBehavior(makeContext('false'));
    behavior.enable();
    behavior._pointerdown();
    assert.equal(behavior._lassoing, false);
  });

  it('starts lasso from pointerdown when preference is on and shift is not pressed', () => {
    const behavior = new LassoBehavior(makeContext('true'));
    behavior.enable();
    behavior._pointerdown();
    assert.equal(behavior._lassoing, true);
  });

  it('still starts lasso from pointerdown when shift is pressed', () => {
    const behavior = new LassoBehavior(makeContext('false', new Set(['Shift'])));
    behavior.enable();
    behavior._pointerdown();
    assert.equal(behavior._lassoing, true);
  });
});
