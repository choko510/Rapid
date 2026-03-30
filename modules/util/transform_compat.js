import { Transform } from '@rapid-sdk/math';

const PATCH_FLAG = '__rapidTransformCompatPatched__';


/**
 * utilPatchTransformCompat
 * Bridge @rapid-sdk/math Transform APIs used by Rapid code (`k`/`scale`)
 * to the newer Transform implementation (`z`/`zoom`).
 */
export function utilPatchTransformCompat() {
  const proto = Transform?.prototype;
  if (!proto || proto[PATCH_FLAG]) return;

  const propsDescriptor = Object.getOwnPropertyDescriptor(proto, 'props');
  if (!propsDescriptor?.get || !propsDescriptor?.set) return;

  const TAU = 2 * Math.PI;
  const safeScaleToZoom = (k) => Math.log(k * TAU) / Math.LN2 - 8;   // tileSize=256
  const safeZoomToScale = (z) => (256 * Math.pow(2, z)) / TAU;

  Object.defineProperty(proto, 'k', {
    get() {
      return safeZoomToScale(this.z);
    },
    set(val) {
      const k = +val;
      if (!isNaN(k) && isFinite(k) && k > 0) {
        this.props = { z: safeScaleToZoom(k) };
      }
    },
    configurable: true
  });

  Object.defineProperty(proto, 'scale', {
    get() {
      return this.k;
    },
    set(val) {
      this.k = val;
    },
    configurable: true
  });

  Object.defineProperty(proto, 'props', {
    get() {
      const props = propsDescriptor.get.call(this);
      return { ...props, k: safeZoomToScale(props.z) };
    },
    set(val = {}) {
      if (!val || typeof val !== 'object') {
        propsDescriptor.set.call(this, val);
        return;
      }

      const next = { ...val };

      if ((next.z === undefined || next.z === null) && next.k !== undefined && next.k !== null) {
        const k = +next.k;
        if (!isNaN(k) && isFinite(k) && k > 0) {
          next.z = safeScaleToZoom(k);
        }
      }

      if ((next.z === undefined || next.z === null) && next.scale !== undefined && next.scale !== null) {
        const scale = +next.scale;
        if (!isNaN(scale) && isFinite(scale) && scale > 0) {
          next.z = safeScaleToZoom(scale);
        }
      }

      delete next.k;
      delete next.scale;
      propsDescriptor.set.call(this, next);
    },
    configurable: true
  });

  Object.defineProperty(proto, PATCH_FLAG, {
    value: true,
    writable: false,
    configurable: false
  });
}


utilPatchTransformCompat();
