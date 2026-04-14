import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { StyleSystem } from '../../../modules/core/StyleSystem.js';


describe('StyleSystem', () => {
  it('styles landuse=basin as blue water fill', () => {
    const styles = new StyleSystem({ systems: {} });
    const style = styles.styleMatch({ landuse: 'basin' });

    assert.equal(style.fill.color, styles.STYLE_DECLARATIONS.blue.fill.color);
  });

  it('styles shared foot+bicycle paths differently', () => {
    const styles = new StyleSystem({ systems: {} });
    const base = styles.styleMatch({ highway: 'path' });
    const shared = styles.styleMatch({ highway: 'path', foot: 'designated', bicycle: 'designated' });

    assert.notEqual(shared.stroke.color, base.stroke.color);
  });

  it('styles expressways slightly thicker', () => {
    const styles = new StyleSystem({ systems: {} });
    const base = styles.styleMatch({ highway: 'trunk' });
    const express = styles.styleMatch({ highway: 'trunk', expressway: 'yes' });

    assert.equal(express.casing.width, base.casing.width + 1);
    assert.equal(express.stroke.width, base.stroke.width + 1);
  });
});
