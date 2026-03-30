describe('UiRapidCatalog', () => {
  let body, container, shaded, parentModal, catalog;

  class MockDataset {
    constructor(props = {}) {
      this.id = props.id || 'dataset-1';
      this.service = props.service || 'mapwithai';
      this.categories = new Set(props.categories || ['roads']);
      this.tags = new Set();
      this.color = props.color || '#da26d3';
      this.dataUsed = [];
      this.itemUrl = props.itemUrl || '';
      this.licenseUrl = props.licenseUrl || '';
      this.thumbnailUrl = props.thumbnailUrl || 'https://example.com/thumb.png';
      this.added = props.added ?? false;
      this.beta = props.beta ?? false;
      this.enabled = props.enabled ?? false;
      this.featured = props.featured ?? false;
      this.filtered = false;
      this.hidden = props.hidden ?? false;
      this._label = props.label || 'Dataset';
      this._description = props.description || 'Description';
    }
    getLabel() { return this._label; }
    getDescription() { return this._description; }
  }

  class MockContext {
    constructor() {
      this.systems = {
        l10n: {
          t: (key, options = {}) => {
            if (key === 'rapid_menu.import_result_summary') {
              return `Imported: ${options.imported}, Failed: ${options.failed}`;
            }
            if (key.startsWith('rapid_menu.category.')) return key.split('.').at(-1);
            return key;
          },
          on: () => {}
        },
        storage: {
          getItem: () => 'false'
        },
        rapid: {
          catalog: new Map([
            ['dataset-1', new MockDataset({ id: 'dataset-1', label: 'Dataset One', description: 'Road data', added: true, enabled: true, categories: ['roads', 'featured'] })],
            ['dataset-2', new MockDataset({ id: 'dataset-2', label: 'Preview Dataset', description: 'Preview data', beta: true, categories: ['roads', 'preview'] })]
          ]),
          categories: new Set(['roads', 'featured', 'preview']),
          datasets: new Map([
            ['dataset-1', new MockDataset({ id: 'dataset-1', label: 'Dataset One', added: true, enabled: true })]
          ]),
          removeDatasets: () => {},
          enableDatasets: () => {},
          importExternalManifestFromURL: () => Promise.resolve({ datasets: [], errors: [] }),
          importExternalManifestFromFile: () => Promise.resolve({ datasets: [], errors: [] })
        }
      };
    }
    container() { return container; }
    enter() {}
  }

  beforeEach(() => {
    body = d3.select('body');
    container = body.append('div').attr('class', 'container');
    shaded = container.append('div').attr('class', 'shaded');
    parentModal = { close: () => {} };
    catalog = new Rapid.UiRapidCatalog(new MockContext(), parentModal);
    catalog.show();
  });

  afterEach(() => {
    container.remove();
  });


  it('renders import controls in the catalog modal', () => {
    const urlInput = shaded.select('.rapid-catalog-import-url');
    const urlButton = shaded.select('.rapid-catalog-import-url-button');
    const fileInput = shaded.select('.rapid-catalog-import-file');

    expect(urlInput.empty()).to.be.false;
    expect(urlButton.empty()).to.be.false;
    expect(fileInput.empty()).to.be.false;
  });


  it('hides preview datasets when preview feature flag is off', () => {
    const names = [];
    shaded.selectAll('.rapid-catalog-dataset-name').each(function() {
      names.push(d3.select(this).text());
    });

    expect(names).to.include('Dataset One');
    expect(names).to.not.include('Preview Dataset');
  });


  it('shows import result summary after URL import with errors', done => {
    catalog.context.systems.rapid.importExternalManifestFromURL = () => Promise.resolve({
      datasets: [new MockDataset({ id: 'x', label: 'X' })],
      errors: [{ id: 'bad-dataset', message: 'Invalid source URL' }]
    });

    const input = shaded.select('.rapid-catalog-import-url');
    input.property('value', 'https://example.com/manifest.json');
    input.dispatch('input');

    const button = shaded.select('.rapid-catalog-import-url-button').node();
    happen.click(button);

    window.setTimeout(() => {
      const result = shaded.select('.rapid-catalog-import-result');
      expect(result.text()).to.contain('Imported: 1, Failed: 1');
      expect(result.text()).to.contain('bad-dataset: Invalid source URL');
      done();
    }, 30);
  });
});

