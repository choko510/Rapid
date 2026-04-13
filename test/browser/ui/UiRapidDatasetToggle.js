describe('UiRapidDatasetToggle', () => {
  let context;
  let toggle;
  let dataset;
  let enterCalls;
  let toggledDatasets;
  let dirtyLayerCalls;
  let redrawCalls;

  class MockDataset {
    constructor(props = {}) {
      this.id = props.id || 'dataset-1';
      this.color = props.color || '#da26d3';
      this.added = props.added ?? true;
      this.enabled = props.enabled ?? true;
      this.beta = props.beta ?? false;
    }
    getLabel() {
      return 'Dataset One';
    }
  }

  class MockContext {
    constructor() {
      enterCalls = [];
      toggledDatasets = [];
      dirtyLayerCalls = [];
      redrawCalls = [];

      dataset = new MockDataset({ id: 'dataset-1' });
      this.mode = { id: 'browse', selectedData: [] };

      this.systems = {
        l10n: {
          t: key => key,
          on: () => {},
          isRTL: () => false
        },
        gfx: {
          immediateRedraw: () => redrawCalls.push(true),
          scene: {
            on: () => {},
            dirtyLayers: layers => dirtyLayerCalls.push(layers),
            toggleLayers: () => {},
            layers: new Map([['rapid', { enabled: true }]])
          }
        },
        map: {
          extent: () => {}
        },
        rapid: {
          datasets: new Map([['dataset-1', dataset]]),
          toggleDatasets: id => toggledDatasets.push(id),
          ignoredGersIDs: new Set(),
          catalog: new Map()
        },
        storage: {
          getItem: () => 'false'
        }
      };
    }

    enter(mode, options) {
      enterCalls.push([mode, options]);
    }
  }

  beforeEach(() => {
    context = new MockContext();
    toggle = new Rapid.UiRapidDatasetToggle(context);
    toggle.render = () => {};
  });


  it('returns to browse mode before toggling a dataset', () => {
    toggle.toggleDataset(null, { id: 'dataset-1' });

    expect(enterCalls[0][0]).to.eql('browse');
    expect(toggledDatasets).to.eql(['dataset-1']);
  });


  it('updates dataset color and redraws rapid layers', () => {
    toggle.changeColor('dataset-1', '#112233');

    expect(dataset.color).to.eql('#112233');
    expect(dirtyLayerCalls).to.eql([['rapid', 'rapidoverlay']]);
    expect(redrawCalls.length).to.eql(1);
  });


  it('re-enters select mode to refresh sidebar when features are selected', () => {
    context.mode = {
      id: 'select',
      selectedData: [['w1', { id: 'w1' }]]
    };

    toggle.changeColor('dataset-1', '#445566');

    const selectCall = enterCalls.find(call => call[0] === 'select');
    expect(selectCall).to.not.be.undefined;
    expect(selectCall[1].selection instanceof Map).to.be.true;
    expect([...selectCall[1].selection.keys()]).to.eql(['w1']);
  });
});
