import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { StyleSystem } from '../../../modules/core/StyleSystem.js';


describe('StyleSystem', () => {
  it('styles landuse=basin as blue water fill', () => {
    const styles = new StyleSystem({ systems: {} });
    const style = styles.styleMatch({ landuse: 'basin' });

    assert.equal(style.fill.color, styles.STYLE_DECLARATIONS.blue.fill.color);
  });
});
