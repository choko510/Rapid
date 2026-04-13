import { EventEmitter } from 'pixi.js';
import { vecRotate } from '@rapid-sdk/math';


/**
 * "Behaviors" are nothing more than bundles of event handlers that we can
 * enable and disable depending on what the user is doing.
 *
 * `AbstractBehavior` is the base class from which all behaviors inherit.
 * It contains enable/disable methods which manage the event handlers for the behavior.
 * All behaviors are event emitters.
 *
 * Properties you can access:
 *   `id`        `String` identifier for the behavior (e.g. 'draw')
 *   `enabled`   `true` if the event handlers are enabled, `false` if not.
 */
export class AbstractBehavior extends EventEmitter {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super();
    this.context = context;
    this.id = '';

    this._enabled = false;
  }


  /**
   * enable
   * Every behavior should have an `enable` function
   * to setup whatever event handlers this behavior needs
   */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
  }


  /**
   * disable
   * Every behavior should have a `disable` function
   * to teardown whatever event handlers this behavior needs
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
  }


  /**
   * enabled
   * Whether the behavior is enabled
   * @readonly
   */
  get enabled() {
    return this._enabled;
  }

  /**
   * _getEventData
   * Returns an object containing the important details about this Pixi event.
   * @param  {Object}  e - A Pixi FederatedEvent (or something that looks like one)
   * @return {Object}  Object containing data about the event and what was targeted
   */
  _getEventData(e) {
//    const result = {
//      //      pointer event id                touch event id        default
//      id: e.data.originalEvent.pointerId || e.data.pointerType || 'mouse',
//      event: e,
//      originalEvent: e.data.originalEvent,
//      // mouse original events contain offsets, touch events contain 'layerX/Y'.
//      coord: this._getEventCoord(e),
//      time: e.data.originalEvent.timeStamp,
//      isCancelled: false,
//      target: null,
//      feature: null,
//      data: null,
//    };

    const coord = {
      screen: [e.global.x, e.global.y],  // [0,0] is top,left of the screen
      map: [e.global.x, e.global.y]      // [0,0] is the origin of the viewport (rotation removed)
    };

    const context = this.context;
    const viewport = context.viewport;
    const r = viewport.transform.r;
    if (r) {
      coord.map = vecRotate(coord.screen, -r, viewport.center());  // remove rotation
    }

    const result = {
      id: e.pointerId ?? e.pointerType ?? 'unknown',
      event: e,
      originalEvent: e.originalEvent,
      coord: coord,
      time: e.timeStamp,
      isCancelled: false,
      target: null
    };

    //console.log(`hit: ${e.target?.label}`);

    if (!e.target) {   // `e.target` is the PIXI.DisplayObject that triggered this event.
      return result;
    }

    let dObj = e.target;

    // Try to find a target feature - it will have a `__feature__` property.
    // Look up through the parent hierarchy until we find one or end up at the root stage.
    while (dObj) {
      let feature = dObj.__feature__;
      if (feature) {
        result.target = {
          displayObject: dObj,
          feature: feature,
          featureID: feature.id,
          layer: feature.layer,
          layerID: feature.layer.id,
          data: feature.data,
          dataID: feature.dataID
        };
        return result;

      } else {
        if (dObj.parent) {
          dObj = dObj.parent;

        } else {  // can't look up any further, just return the original target.
          result.target = {
            displayObject: e.target,
            feature: null,
            featureID: null,
            layer: null,
            layerID: null,
            data: null,
            dataID: null
          };
          return result;
        }
      }
    }

  }

}
