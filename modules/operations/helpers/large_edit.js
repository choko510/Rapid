/**
 * Returns whether an operation should be considered "too large" for normal mode.
 * This respects the power-user allowLargeEdits flag.
 *
 * @param  {Object}  context
 * @param  {Extent}  extent
 * @param  {number}  threshold
 * @return {boolean}
 */
export function operationIsTooLarge(context, extent, threshold = 0.8) {
  if (!extent) return false;

  const storage = context.systems.storage;
  const viewport = context.viewport;
  const allowLargeEdits = storage.getItem('rapid-internal-feature.allowLargeEdits') === 'true';
  return !allowLargeEdits && extent.percentContainedIn(viewport.visibleExtent()) < threshold;
}

