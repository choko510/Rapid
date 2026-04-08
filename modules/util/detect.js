let _cached;

/**
 * `utilDetect` detects things from the user's browser.
 * It returns an object with the following:
 * {
 *   browser: "Chrome",               // e.g. 'Edge','Opera','Chrome','Safari','Firefox'
 *   version: "133.0",                // reported browser version
 *   locales: ['en-US'],              // Array sourced from `navigator.languages`
 *   host: "http://127.0.0.1:8080/",
 *   os: "mac",
 *   platform: "Macintosh",
 *   prefersColorScheme: 'light',         // 'light' or 'dark'
 *   prefersContrast: null,               // 'more', 'less', or `null`
 *   prefersReducedMotion: false,         // `true` or `false`
 *   prefersReducedTransparency: false    // `true` or `false`
 * }
 */
export function utilDetect(refresh) {
  if (_cached && !refresh) return _cached;
  _cached = {};

  const ua = navigator.userAgent;
  let m = ua.match(/(edg|opr|opera|chrome|safari|firefox)\/?\s*(\.?\d+(\.\d+)*)/i);

  /* Browser */
  if (m !== null) {
    const name = m[1].toLowerCase();
    if (name === 'edg') {
      _cached.browser = 'Edge';
    } else if (name === 'opr') {
      _cached.browser = 'Opera';
    } else {
      _cached.browser = name.charAt(0).toUpperCase() + name.slice(1);
    }

    _cached.version = m[2];

    if (_cached.browser === 'Safari') {
      m = ua.match(/version\/([\.\d]+)/i);
      if (m !== null) _cached.version = m[1];
    }
  } else {
    _cached.browser = navigator.appName;
    _cached.version = navigator.appVersion;
  }

  // Keep major.minor version only..
  _cached.version = _cached.version.split(/\W/).slice(0, 2).join('.');

  /* Platform */
  if (/Win/.test(ua)) {
    _cached.os = 'win';
    _cached.platform = 'Windows';
  } else if (/Mac/.test(ua)) {
    _cached.os = 'mac';
    _cached.platform = 'Macintosh';
  } else if (/X11/.test(ua) || /Linux/.test(ua)) {
    _cached.os = 'linux';
    _cached.platform = 'Linux';
  } else {
    _cached.os = 'win';
    _cached.platform = 'Unknown';
  }

  /* Locale */
  const locales = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
  _cached.locales = locales.filter(Boolean).slice();

  /* Host */
  let loc, origin, pathname;
  try {
    loc = window.top.location;
    origin = loc.origin;
    pathname = loc.pathname;
  } catch {
    loc = window.location;
    origin = loc.origin;
    pathname = loc.pathname;
  }

  origin = origin || (loc.protocol + '//' + loc.host);
  _cached.host = origin + pathname;

  _cached.prefersColorScheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  _cached.prefersContrast = window.matchMedia?.('(prefers-contrast: more)').matches ? 'more'
    : window.matchMedia?.('(prefers-contrast: less)').matches ? 'less' : null;
  _cached.prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  _cached.prefersReducedTransparency = window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches;

  return _cached;
}
