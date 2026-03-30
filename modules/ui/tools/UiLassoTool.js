import { selection } from 'd3-selection';

import { uiIcon } from '../icon.js';
import { uiTooltip } from '../tooltip.js';

const LASSO_PREF_KEY = 'prefs.lasso.enabled';


/**
 * UiLassoTool
 * A toolbar section for toggling lasso-selection mode
 */
export class UiLassoTool {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    this.context = context;
    this.id = 'lasso_selection';
    this.stringID = 'toolbar.lasso_selection';

    // Create child components
    this.Tooltip = uiTooltip(context);

    // D3 selections
    this.$parent = null;

    // Ensure methods used as callbacks always have `this` bound correctly.
    // (This is also necessary when using `d3-selection.call`)
    this.choose = this.choose.bind(this);
    this.render = this.render.bind(this);
    this.rerender = (() => this.render());  // call render without argument

    // Event listeners
    context.on('modechange', this.rerender);
  }


  /**
   * render
   * Accepts a parent selection, and renders the content under it.
   * (The parent selection is required the first time, but can be inferred on subsequent renders)
   * @param {d3-selection} $parent - A d3-selection to a HTMLElement that this component should render itself into
   */
  render($parent = this.$parent) {
    if ($parent instanceof selection) {
      this.$parent = $parent;
    } else {
      return;   // no parent - called too early?
    }

    const context = this.context;
    const l10n = context.systems.l10n;

    this.Tooltip
      .placement('bottom')
      .scrollContainer(context.container().select('.map-toolbar'))
      .title(l10n.t('shortcuts.command.lasso.label'));

    // Button
    let $button = $parent.selectAll('button.lasso-selection')
      .data([0]);

    // enter
    const $$button = $button.enter()
      .append('button')
      .attr('class', 'lasso-selection bar-button')
      .on('click', this.choose)
      .call(this.Tooltip)
      .call(uiIcon('#fas-crosshairs'));

    // update
    $button = $button.merge($$button);

    $button
      .classed('active', this.isActive())
      .classed('disabled', this.isDisabled());
  }


  /**
   * isActive
   * @return {boolean} `true` if lasso mode is active, `false` if not
   */
  isActive() {
    const storage = this.context.systems.storage;
    return storage.getItem(LASSO_PREF_KEY) === 'true';
  }


  /**
   * isDisabled
   * @return {boolean} `true` if disabled, `false` if enabled
   */
  isDisabled() {
    const context = this.context;
    const modeID = context.mode?.id;
    return context.inIntro || modeID === 'save';
  }


  /**
   * choose
   * @param  {Event} e? - triggering event (if any)
   */
  choose(e) {
    if (e)  e.preventDefault();
    if (this.isDisabled()) return;

    const context = this.context;
    const storage = context.systems.storage;
    const ui = context.systems.ui;
    const next = this.isActive() ? 'false' : 'true';

    storage.setItem(LASSO_PREF_KEY, next);
    ui.emit('uichange');
    this.rerender();
  }

}
