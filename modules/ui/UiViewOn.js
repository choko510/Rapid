import { selection } from 'd3-selection';

import { osmRelation, osmWay } from '../osm/index.js';
import { uiIcon } from './icon.js';


/**
 * UiViewOn
 * This component adds a link like "View On OSM"
 */
export class UiViewOn {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    this.context = context;

    this.url = null;
    this.stringID = null;
    this.stringOptions = null;

    // D3 selections
    this.$parent = null;

    // Ensure methods used as callbacks always have `this` bound correctly.
    // (This is also necessary when using `d3-selection.call`)
    this.render = this.render.bind(this);
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

    const url = this.url;
    const stringID = this.stringID;
    const stringOptions = this.stringOptions;

    let $viewon = $parent.selectAll('.view-on')
      .data(url && stringID ? [url] : [], d => d);

    // exit
    $viewon.exit()
      .remove();

    // enter
    const $$viewon = $viewon.enter()
      .append('a')
      .attr('class', 'view-on')
      .attr('target', '_blank')
      .call(uiIcon('#rapid-icon-out-link', 'inline'));

    $$viewon
      .append('span');

    // update
    $viewon = $viewon.merge($$viewon);

    $viewon
      .attr('href', d => d);

    $viewon.selectAll('span')
      .text(stringID ? l10n.t(stringID, stringOptions) : '');
  }


  static getRelativeDate(context, date) {
    const l10n = context.systems.l10n;
    const localeCode = l10n.localeCode();
    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      return l10n.t('inspector.unknown');
    }

    if (typeof Intl === 'undefined' || typeof Intl.RelativeTimeFormat === 'undefined') {
      return parsedDate.toLocaleDateString(localeCode);
    }

    const elapsedSeconds = Math.floor((Date.now() - parsedDate.getTime()) / 1000);
    const toRelative = n => Math.floor(elapsedSeconds / n);

    let value = toRelative(1);
    let unit = 'seconds';
    if (toRelative(60 * 60 * 24 * 365) > 1) {
      value = toRelative(60 * 60 * 24 * 365);
      unit = 'years';
    } else if (toRelative(60 * 60 * 24 * 30) > 1) {
      value = toRelative(60 * 60 * 24 * 30);
      unit = 'months';
    } else if (toRelative(60 * 60 * 24) > 1) {
      value = toRelative(60 * 60 * 24);
      unit = 'days';
    } else if (toRelative(60 * 60) > 1) {
      value = toRelative(60 * 60);
      unit = 'hours';
    } else if (toRelative(60) > 1) {
      value = toRelative(60);
      unit = 'minutes';
    }

    if (!Number.isFinite(value)) {
      return l10n.t('inspector.unknown');
    }

    return new Intl.RelativeTimeFormat(localeCode).format(-value, unit);
  }


  static findLastModifiedChild(graph, feature) {
    let latest = feature;
    const seen = new Set();

    const hasTimestamp = entity => {
      return (typeof entity?.timestamp === 'string' && entity.timestamp.length > 0);
    };

    const isNewerEntity = entity => {
      if (!hasTimestamp(entity)) return false;
      if (!hasTimestamp(latest)) return true;
      return entity.timestamp > latest.timestamp;
    };

    const recurseChildren = entity => {
      if (!entity || seen.has(entity.id)) return;
      seen.add(entity.id);

      if (isNewerEntity(entity)) {
        latest = entity;
      }

      if (entity instanceof osmWay) {
        entity.nodes
          .map(nodeID => graph.hasEntity(nodeID))
          .filter(Boolean)
          .forEach(recurseChildren);

      } else if (entity instanceof osmRelation) {
        entity.members
          .map(member => graph.hasEntity(member.id))
          .filter(Boolean)
          .forEach(recurseChildren);
      }
    };

    recurseChildren(feature);
    return latest;
  }
}
