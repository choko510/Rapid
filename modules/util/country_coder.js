let _countryCoderPromise;


function loadCountryCoderAsync() {
  if (!_countryCoderPromise) {
    _countryCoderPromise = import('@rapideditor/country-coder');
  }
  return _countryCoderPromise;
}


export function iso1A2CodeAsync(loc, options) {
  return loadCountryCoderAsync().then(mod => mod.iso1A2Code(loc, options));
}


export function roadSpeedUnitAsync(loc) {
  return loadCountryCoderAsync().then(mod => mod.roadSpeedUnit(loc));
}
