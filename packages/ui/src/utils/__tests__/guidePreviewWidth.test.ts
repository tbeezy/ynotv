import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_WIDTH_COMMIT_TOLERANCE_PCT,
  ROW_PREVIEW_MIN_WIDTH_PX,
  clampRowPreviewWidthPct,
  didPreviewWidthChange,
  getRowPreviewWidthBoundsPct,
} from '../guidePreviewWidth';

/** Bounds and widths are percentages of a pixel width, so they carry rounding noise. */
const CLOSE = 10;

describe('getRowPreviewWidthBoundsPct', () => {
  it('turns the 280px pane minimum into percentage bounds', () => {
    const wide = getRowPreviewWidthBoundsPct(1000);
    expect(wide.minPct).toBeCloseTo(28, CLOSE);
    expect(wide.maxPct).toBeCloseTo(72, CLOSE);

    const ultrawide = getRowPreviewWidthBoundsPct(1400);
    expect(ultrawide.minPct).toBeCloseTo(20, CLOSE);
    expect(ultrawide.maxPct).toBeCloseTo(80, CLOSE);
  });

  it('crosses over below twice the minimum, where the pane and the EPG window both want 280px', () => {
    const { minPct, maxPct } = getRowPreviewWidthBoundsPct(500);
    expect(minPct).toBeCloseTo(56, CLOSE);
    expect(maxPct).toBeCloseTo(44, CLOSE);
    expect(minPct).toBeGreaterThan(maxPct);
  });

  it('reports no bounds for a container that has not been measured yet', () => {
    expect(getRowPreviewWidthBoundsPct(0)).toEqual({ minPct: 0, maxPct: 100 });
    expect(getRowPreviewWidthBoundsPct(Number.NaN)).toEqual({ minPct: 0, maxPct: 100 });
  });
});

describe('clampRowPreviewWidthPct', () => {
  it('leaves a width that is already inside the bounds alone', () => {
    expect(clampRowPreviewWidthPct(50, 1000)).toBe(50);
  });

  it('clamps to the pane minimum and to the space the EPG window keeps', () => {
    expect(clampRowPreviewWidthPct(5, 1000)).toBeCloseTo(28, CLOSE);
    expect(clampRowPreviewWidthPct(95, 1000)).toBeCloseTo(72, CLOSE);
  });

  it('lets the minimum win when the bounds cross over, exactly like CSS min-width', () => {
    expect(clampRowPreviewWidthPct(95, 500)).toBeCloseTo(56, CLOSE);
    expect(clampRowPreviewWidthPct(5, 500)).toBeCloseTo(56, CLOSE);
  });

  it('returns an unparseable stored width untouched instead of silently repairing it', () => {
    expect(clampRowPreviewWidthPct(Number.NaN, 1000)).toBeNaN();
  });

  it('never renders the pane narrower than 280px, nor wider than the floor CSS clamps it to', () => {
    for (const width of [420, 560, 800, 1400, 2900]) {
      for (const pct of [0, 12, 50, 73.5, 100]) {
        const px = (clampRowPreviewWidthPct(pct, width) / 100) * width;
        // `min-width: 280px` always applies; `max-width: calc(100% - 280px)`
        // yields to it once the column is too narrow for both to have 280px.
        expect(px).toBeGreaterThanOrEqual(ROW_PREVIEW_MIN_WIDTH_PX - 1e-6);
        expect(px).toBeLessThanOrEqual(
          Math.max(ROW_PREVIEW_MIN_WIDTH_PX, width - ROW_PREVIEW_MIN_WIDTH_PX) + 1e-6
        );
      }
    }
  });
});

describe('didPreviewWidthChange', () => {
  it('reports no change when the handle was clicked without moving', () => {
    expect(didPreviewWidthChange(60, 60)).toBe(false);
    expect(didPreviewWidthChange(60, 60 + PREVIEW_WIDTH_COMMIT_TOLERANCE_PCT / 2)).toBe(false);
  });

  it('reports a change once the pane actually moved', () => {
    expect(didPreviewWidthChange(60, 55)).toBe(true);
    expect(didPreviewWidthChange(60, 60 + PREVIEW_WIDTH_COMMIT_TOLERANCE_PCT * 2)).toBe(true);
  });

  it('keeps the tolerance under the pane border, so the two origins are not interchangeable', () => {
    // 1px of border on a 1000px column is 0.1% - an order of magnitude above the
    // tolerance, so comparing a rect-derived origin against a basis percentage
    // would read the border alone as a drag and commit it.
    const borderBiasPctOn1000pxColumn = (1 / 1000) * 100;
    expect(borderBiasPctOn1000pxColumn).toBeGreaterThan(PREVIEW_WIDTH_COMMIT_TOLERANCE_PCT);
  });

  it('presumes a deliberate drag when there is no reliable origin', () => {
    expect(didPreviewWidthChange(null, 60)).toBe(true);
    expect(didPreviewWidthChange(Number.NaN, 60)).toBe(true);
    expect(didPreviewWidthChange(60, Number.NaN)).toBe(true);
  });
});

describe('ChannelPanel.css contract', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../components/ChannelPanel.css'),
    'utf8'
  );

  it('clamps the row-layout pane with the same 280px the JS bounds use', () => {
    const rule = css.match(
      /\.guide-panel\.alt-row-layout \.guide-top-section\.alternate-view > \.guide-preview-pane \{([^}]*)\}/
    )?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toContain(`min-width: ${ROW_PREVIEW_MIN_WIDTH_PX}px;`);
    expect(rule).toContain(`max-width: calc(100% - ${ROW_PREVIEW_MIN_WIDTH_PX}px);`);
  });
});
