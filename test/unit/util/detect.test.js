import { before, after, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as Rapid from '../../../modules/headless.js';

if (!global.window) {  // mock window for Node
  global.window = {};
}

describe('utilDetect', () => {
  let origNavigator;

  function setNavigator(value) {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      writable: true,
      value: value
    });
  }

  before(() => {
    origNavigator = global.navigator;
  });

  after(() => {
    if (typeof origNavigator === 'undefined') {
      delete global.navigator;
    } else {
      setNavigator(origNavigator);
    }
  });

  beforeEach(() => {
    const mock = {
      languages: ['en-US', 'en'],
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    };
    // Copy the original navigator, so we can safely change things.
    setNavigator(Object.assign({}, mock, origNavigator || {}));

    global.window = {
      devicePixelRatio: 1,
      top: {
        location: {
          origin: 'http://example.com',
          pathname: '/path/to/page',
          protocol: 'http:',
          host: 'example.com'
        }
      },
      location: {
        origin: 'http://fallback.example',
        pathname: '/fallback/page',
        protocol: 'http:',
        host: 'fallback.example'
      },
      matchMedia: () => ({ matches: false })
    };
  });

  it('should detect the browser and version', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3';
    global.navigator.userAgent = ua;
    const detected = Rapid.utilDetect(true);
    assert.strictEqual(detected.browser, 'Chrome');
    assert.strictEqual(detected.version, '58.0');
  });

  it('does not include a legacy support flag', () => {
    const detected = Rapid.utilDetect(true);
    assert.strictEqual(detected.support, undefined);
  });

  it('should detect the os and platform', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3';
    global.navigator.userAgent = ua;
    const detected = Rapid.utilDetect(true);
    assert.strictEqual(detected.os, 'win');
    assert.strictEqual(detected.platform, 'Windows');
  });

  it('should detect the locale', () => {
    global.navigator.languages = ['es'];
    const detected = Rapid.utilDetect(true);
    assert.ok(detected.locales.includes('es'));
  });

  it('uses window.top.location for host when available', () => {
    const detected = Rapid.utilDetect(true);
    assert.strictEqual(detected.host, 'http://example.com/path/to/page');
  });

  it('falls back to window.location when window.top.location is inaccessible', () => {
    const fallback = {
      origin: 'https://fallback.example',
      pathname: '/embedded'
    };
    global.window.location = fallback;

    Object.defineProperty(global.window, 'top', {
      configurable: true,
      get() {
        throw new Error('cross-origin frame');
      }
    });

    const detected = Rapid.utilDetect(true);
    assert.strictEqual(detected.host, 'https://fallback.example/embedded');
  });

  it('builds host from protocol and host when origin is unavailable', () => {
    global.window.top.location = {
      protocol: 'https:',
      host: 'embed.example',
      pathname: '/viewer'
    };

    const detected = Rapid.utilDetect(true);
    assert.strictEqual(detected.host, 'https://embed.example/viewer');
  });
});
