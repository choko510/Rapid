import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ImagerySystem } from '../../../modules/core/ImagerySystem.js';


class MockStorageSystem {
  constructor() {
    this._storage = new Map();
  }
  getItem(k) {
    return this._storage.get(k) ?? null;
  }
  setItem(k, v) {
    this._storage.set(k, v);
  }
}

class MockUrlHashSystem {
  constructor() {
    this.params = new Map();
  }
  setParam(k, v) {
    this.params.set(k, v);
  }
}

class MockContext {
  constructor() {
    this.inIntro = false;
    this.viewport = {
      visibleExtent: () => ({ rectangle: () => [0, 0, 0, 0] }),
      transform: { zoom: 16 }
    };

    this.systems = {
      storage: new MockStorageSystem(),
      urlhash: new MockUrlHashSystem()
    };

    this.services = {
      osm: {
        imageryBlocklists: []
      }
    };
  }
}

function makeSource(id, template = 'https://tiles.example.com/{zoom}/{x}/{y}.png', extra = {}) {
  return {
    id: id,
    key: id,
    template: template,
    offset: [0, 0],
    ...extra
  };
}

function setupImagerySystem(sources, options = {}) {
  const visibleSourceIDs = options.visibleSourceIDs ?? [];
  const context = new MockContext();
  const imagery = new ImagerySystem(context);

  imagery._imageryIndex = {
    features: new Map(),
    sources: new Map(sources.map(source => [source.id.toLowerCase(), source])),
    query: {
      bbox: () => visibleSourceIDs.map(id => ({ id }))
    }
  };

  return { context, imagery };
}


describe('ImagerySystem', () => {
  it('uses configured fallback source when the requested background source is missing', () => {
    const mapnik = makeSource('MAPNIK', 'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png');
    const bing = makeSource('Bing');
    const none = makeSource('none', '');

    const { context, imagery } = setupImagerySystem([mapnik, bing, none]);
    context.systems.storage.setItem('background-fallback-id', 'Bing');

    const currParams = new Map([['background', 'MissingMainMap']]);
    const prevParams = new Map();
    imagery._hashchange(currParams, prevParams);

    assert.equal(imagery.baseLayerSource().id, 'Bing');
    assert.equal(context.systems.urlhash.params.get('background'), 'Bing');
  });

  it('falls back to MAPNIK when no fallback source is configured', () => {
    const mapnik = makeSource('MAPNIK', 'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png');
    const bing = makeSource('Bing');
    const none = makeSource('none', '');

    const { context, imagery } = setupImagerySystem([mapnik, bing, none]);

    const currParams = new Map([['background', 'MissingMainMap']]);
    const prevParams = new Map();
    imagery._hashchange(currParams, prevParams);

    assert.equal(imagery.baseLayerSource().id, 'MAPNIK');
    assert.equal(context.systems.urlhash.params.get('background'), 'MAPNIK');
  });

  it('falls back to default imagery if MAPNIK is unavailable', () => {
    const bing = makeSource('Bing');
    const none = makeSource('none', '');

    const { imagery } = setupImagerySystem([bing, none]);

    imagery.chooseDefaultSource = () => bing;

    const currParams = new Map([['background', 'MissingMainMap']]);
    const prevParams = new Map();
    imagery._hashchange(currParams, prevParams);

    assert.equal(imagery.baseLayerSource().id, 'Bing');
  });

  it('uses MAPNIK when configured fallback is currently unavailable', () => {
    const mapnik = makeSource('MAPNIK', 'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png');
    const localOnly = makeSource('LocalOnly', undefined, {
      polygon: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]
    });
    const none = makeSource('none', '');

    const { context, imagery } = setupImagerySystem([mapnik, localOnly, none], { visibleSourceIDs: [] });
    context.systems.storage.setItem('background-fallback-id', 'LocalOnly');

    const currParams = new Map([['background', 'MissingMainMap']]);
    const prevParams = new Map();
    imagery._hashchange(currParams, prevParams);

    assert.equal(imagery.baseLayerSource().id, 'MAPNIK');
  });

  it('switches to available fallback when current source becomes unavailable', () => {
    const mapnik = makeSource('MAPNIK', 'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png');
    const localOnly = makeSource('LocalOnly', undefined, {
      polygon: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]
    });
    const none = makeSource('none', '');

    const { context, imagery } = setupImagerySystem([mapnik, localOnly, none], { visibleSourceIDs: [] });
    context.systems.storage.setItem('background-fallback-id', 'MAPNIK');
    imagery.baseLayerSource(localOnly);

    imagery._mapdraw();

    assert.equal(imagery.baseLayerSource().id, 'MAPNIK');
  });
});
