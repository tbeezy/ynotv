/**
 * Width bounds of the EPG preview pane in the 3-column *row* layout.
 *
 * That layout sizes the pane from `--preview-width`, a percentage of
 * `.guide-top-section`, and `ChannelPanel.css` additionally clamps the box with
 * `min-width: 280px` / `max-width: calc(100% - 280px)` so the EPG window beside
 * it always keeps 280px.
 *
 * CSS clamps only what is *painted*. A remembered width that sits outside those
 * bounds - dragged on a wide window, then re-opened on a narrow one - therefore
 * renders at the clamp while the state still holds the old value, and the pane
 * snaps on the first pixel of the next drag. `ChannelPanel` runs both its drag
 * handler and its resize reconciler through these helpers, so the bounds JS
 * enforces and CSS paints cannot disagree.
 */

/** `min-width` of the row-layout preview pane, and the space the EPG window keeps. */
export const ROW_PREVIEW_MIN_WIDTH_PX = 280;

export interface PreviewWidthBoundsPct {
  minPct: number;
  maxPct: number;
}

/**
 * Percentage bounds for a container `availableWidthPx` wide (`--preview-width`
 * is a percentage of that container).
 *
 * Below twice the minimum the bounds cross over - the pane wants 280px and the
 * EPG window wants 280px as well. CSS resolves that by letting `min-width` win,
 * and `clampRowPreviewWidthPct` reproduces it.
 *
 * A container that has not been measured yet (`0`, `NaN`) has no bounds, i.e.
 * the full `0%..100%` range, so nothing is clamped away before layout.
 */
export function getRowPreviewWidthBoundsPct(availableWidthPx: number): PreviewWidthBoundsPct {
  if (!(availableWidthPx > 0)) return { minPct: 0, maxPct: 100 };
  return {
    minPct: (ROW_PREVIEW_MIN_WIDTH_PX / availableWidthPx) * 100,
    maxPct: ((availableWidthPx - ROW_PREVIEW_MIN_WIDTH_PX) / availableWidthPx) * 100,
  };
}

/**
 * `pct` clamped to what the row layout can render in `availableWidthPx`.
 *
 * `minPct` wins when the bounds cross over, exactly like CSS. An unparseable
 * stored value (`NaN`) is returned untouched - nothing in the app writes one,
 * and quietly turning a corrupt entry into a valid width would hide it.
 */
export function clampRowPreviewWidthPct(pct: number, availableWidthPx: number): number {
  if (!Number.isFinite(pct)) return pct;
  const { minPct, maxPct } = getRowPreviewWidthBoundsPct(availableWidthPx);
  return Math.max(minPct, Math.min(pct, maxPct));
}

/** Percentages closer than this are pointer noise, not a deliberate resize. */
export const PREVIEW_WIDTH_COMMIT_TOLERANCE_PCT = 0.01;

/**
 * Whether releasing the preview resize handle should commit a new width.
 *
 * Both arguments must come from the same source - the pane's inline flex basis
 * read at mouse-down and at mouse-up. Comparing the basis against a
 * `getBoundingClientRect()` measurement instead skews the result by the pane's
 * own border (1px, 2px in the light theme) because the pane is content-box,
 * which is larger than this tolerance and would let a click that never moved
 * the pane overwrite the stored preference.
 *
 * A missing origin (`null`, e.g. the pane had not painted an inline width yet)
 * or an unparseable value returns `true`: with nothing reliable to compare
 * against, a drag is presumed deliberate rather than silently dropped.
 */
export function didPreviewWidthChange(
  startPct: number | null,
  finalPct: number,
  tolerancePct: number = PREVIEW_WIDTH_COMMIT_TOLERANCE_PCT
): boolean {
  if (startPct === null || !Number.isFinite(startPct) || !Number.isFinite(finalPct)) return true;
  return Math.abs(finalPct - startPct) > tolerancePct;
}
