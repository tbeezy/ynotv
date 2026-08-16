/**
 * DOM-applier idempotency tests (Phase 3 of the settings-store migration).
 *
 * The applier is the ONE writer of every settings-driven documentElement
 * side effect. The critical regression this guards is the mount-time race
 * class: before the migration, ~20 per-instance effects re-applied default
 * state on every mount, causing theme/OLED flashes. With the store + applier,
 * re-applying the same state must produce ZERO DOM writes.
 *
 * Static imports only: `domApplierTestDom` installs the fake `document` at
 * module load (before the applier's own module body runs), and the applier is
 * imported once. Per-test isolation is done by RE-INSTALLING a fresh fake DOM
 * in beforeEach — the applier reads `document.documentElement` dynamically via
 * root(), so a fresh fake means fresh counters/maps with no module resets
 * (vi.resetModules() would re-evaluate the shared DOM module and orphan the
 * test's reference).
 */

import { installFakeDom, type FakeDom } from './domApplierTestDom';
import { applySettingsDom, __resetSettingsApplierStateForTests } from '../settingsDomApplier';
import { describe, it, expect, beforeEach } from 'vitest';

let fake: FakeDom;

// No window/storage in node → the store's persist helpers no-op. The fake
// document + getComputedStyle are installed by domApplierTestDom at module
// load (before the applier's init() runs).

function baseState() {
  return {
    theme: 'dark' as string,
    customThemeConfig: undefined,
    appFontFamily: 'inter',
    appCustomFontBase64: '',
    appCustomFontFormat: '',
    appCustomFontName: '',
    disableThemeBackdropBlur: false,
    disableEpgTransitions: false,
    epgReduceGpuLayers: false,
    epgDisableChannelFade: false,
    oledBlack: false,
    epgLogoDisplay: 'square' as string,
    channelLogoSize: 42,
    channelLogoRoundEdges: true,
    channelLogoPadding: 'none' as string,
    channelFontSize: 12,
    categoryFontSize: 13,
    sourceFontSize: 12,
    epgTitleFontSize: 32,
    epgBodyFontSize: 16,
    stremioBadgeSize: 100,
    nuvioBadgeSize: 100,
    uiScale: 100,
    transparentGuideHeight: 40,
    transparentGuideHideHeader: false,
    transparentGuideOverlayOpacity: 55,
    transparentGuideSidebarOpacity: 55,
    modernUiEnabled: 'v3' as 'v1' | 'v2' | 'v3' | false,
    enableCustomScrollbarWidth: false,
    customScrollbarWidth: 12,
    widgetScale: 1,
    widgetBgOpacity: 0.55,
    sportsScale: 1,
    sportsBgOpacity: 0.55,
    channelInfoOverlayFontSize: 16,
    channelInfoOverlayLogoSize: 42,
    channelInfoOverlayBoxWidth: 380,
    epgDarkenCurrent: false,
    epgHighlightBorderCurrent: false,
    epgBoldChannelNames: false,
    epgBoldTopCategories: false,
    epgBoldSourceCategories: false,
  };
}

beforeEach(() => {
  fake = installFakeDom();
  // Fresh per-section change tracking so each case starts from "nothing
  // applied" — the applier module is imported once (static import) and its
  // `lastApplied` map is module state that would otherwise leak across cases.
  __resetSettingsApplierStateForTests();
});

describe('settings DOM applier idempotency', () => {
  it('applies the initial state exactly once', () => {
    applySettingsDom(baseState() as any);
    const first = { ...fake.writes };
    expect(fake.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(first.style + first.attrs + first.classes + first.dataset + first.fontFace).toBeGreaterThan(0);
  });

  it('produces ZERO writes when re-applying the same state (the flash-regression guard)', () => {
    applySettingsDom(baseState() as any);
    const snapshot = { ...fake.writes };
    // Same state again — the regression this suite exists for: per-instance
    // effects used to re-apply default state on every mount.
    applySettingsDom(baseState() as any);
    expect(fake.writes).toEqual(snapshot);
  });

  it('writes only the section whose inputs changed', () => {
    applySettingsDom(baseState() as any);
    const snapshot = { ...fake.writes };

    // Change one unrelated setting (widget scale) → only its vars change.
    // The widget section writes --widget-scale, --widget-bg-opacity and
    // --cio-bg-opacity; the opacity two were already applied by the first
    // call (same values) so only --widget-scale actually changes the DOM.
    applySettingsDom({ ...baseState(), widgetScale: 1.2 } as any);
    expect(fake.writes.attrs).toBe(snapshot.attrs);
    expect(fake.writes.classes).toBe(snapshot.classes);
    expect(fake.writes.dataset).toBe(snapshot.dataset);
    expect(fake.writes.style).toBe(snapshot.style + 1);
    expect(fake.properties.get('--widget-scale')).toBe('1.2');

    // Change the theme → data-theme flips exactly once, no churn elsewhere.
    applySettingsDom({ ...baseState(), theme: 'dark-crimson' } as any);
    expect(fake.writes.attrs).toBe(snapshot.attrs + 1);
    expect(fake.document.documentElement.getAttribute('data-theme')).toBe('dark-crimson');
  });

  it('toggles OLED via dataset exactly once per change', () => {
    applySettingsDom(baseState() as any);
    const snapshot = { ...fake.writes };

    applySettingsDom({ ...baseState(), oledBlack: true } as any);
    expect(fake.document.documentElement.dataset.oled).toBe('true');
    expect(fake.writes.dataset).toBe(snapshot.dataset + 1);

    // Re-applying the same oled state is a no-op.
    const after = { ...fake.writes };
    applySettingsDom({ ...baseState(), oledBlack: true } as any);
    expect(fake.writes).toEqual(after);
  });

  it('keeps a stored custom theme config applied idempotently', () => {
    const state = {
      ...baseState(),
      theme: 'custom',
      customThemeConfig: { accentColor: '#ff0044', backgroundColor: '#0a0a0a' },
    };
    applySettingsDom(state as any);
    expect(fake.document.documentElement.getAttribute('data-theme')).toBe('custom');
    expect(fake.properties.get('--accent-primary')).toBe('#ff0044');

    const snapshot = { ...fake.writes };
    applySettingsDom(state as any);
    expect(fake.writes).toEqual(snapshot);
  });

  it('removes the custom-theme vars when switching away from a custom theme', () => {
    applySettingsDom({ ...baseState(), theme: 'custom', customThemeConfig: { accentColor: '#ff0044' } } as any);
    expect(fake.properties.has('--accent-primary')).toBe(true);

    applySettingsDom(baseState() as any);
    expect(fake.properties.has('--accent-primary')).toBe(false);
    expect(fake.document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies font-size, uiScale and transparent-guide vars idempotently', () => {
    applySettingsDom(baseState() as any);
    const snapshot = { ...fake.writes };

    // Font sizes land on the CSS vars.
    expect(fake.properties.get('--channel-font-size')).toBe('12px');
    expect(fake.properties.get('--category-font-size')).toBe('13px');
    expect(fake.properties.get('--source-font-size')).toBe('12px');
    expect(fake.properties.get('--epg-title-font-size')).toBe('32px');
    expect(fake.properties.get('--epg-body-font-size')).toBe('16px');
    expect(fake.properties.get('--app-zoom')).toBe('1');
    expect(fake.properties.get('--transparent-guide-height')).toBe('40%');
    expect(fake.properties.get('--transparent-guide-overlay-opacity')).toBe('0.55');
    expect(fake.properties.get('--transparent-guide-sidebar-opacity')).toBe('0.55');
    expect(fake.classes.has('transparent-guide-hide-header')).toBe(false);

    // Change one font size → only that var changes.
    applySettingsDom({ ...baseState(), categoryFontSize: 16 } as any);
    expect(fake.properties.get('--category-font-size')).toBe('16px');
    expect(fake.properties.get('--channel-font-size')).toBe('12px');

    const after = { ...fake.writes };
    applySettingsDom({ ...baseState(), categoryFontSize: 16 } as any);
    expect(fake.writes).toEqual(after);
  });

  it('applies the stremio/nuvio badge-scale vars idempotently', () => {
    applySettingsDom(baseState() as any);
    expect(fake.properties.get('--stremio-badge-scale')).toBe('1');
    expect(fake.properties.get('--nuvio-badge-scale')).toBe('1');

    applySettingsDom({ ...baseState(), stremioBadgeSize: 150 } as any);
    expect(fake.properties.get('--stremio-badge-scale')).toBe('1.5');
    expect(fake.properties.get('--nuvio-badge-scale')).toBe('1');

    applySettingsDom({ ...baseState(), nuvioBadgeSize: 80 } as any);
    expect(fake.properties.get('--stremio-badge-scale')).toBe('1');
    expect(fake.properties.get('--nuvio-badge-scale')).toBe('0.8');

    // Re-applying the same state → zero extra writes.
    const snapshot = { ...fake.writes };
    applySettingsDom({ ...baseState(), nuvioBadgeSize: 80 } as any);
    expect(fake.writes).toEqual(snapshot);
  });

  it('toggles the transparent-guide hide-header class and uiDesign classes', () => {
    applySettingsDom({ ...baseState(), transparentGuideHideHeader: true } as any);
    expect(fake.classes.has('transparent-guide-hide-header')).toBe(true);

    // v3 design → modern-ui + modern-ui-v3 classes + data-ui-version attr.
    applySettingsDom({ ...baseState(), modernUiEnabled: 'v3' } as any);
    expect(fake.classes.has('modern-ui')).toBe(true);
    expect(fake.classes.has('modern-ui-v3')).toBe(true);
    expect(fake.document.documentElement.getAttribute('data-ui-version')).toBe('v3');

    // Switch to v1 → drops modern-ui-v3, keeps modern-ui off entirely.
    applySettingsDom({ ...baseState(), modernUiEnabled: false } as any);
    expect(fake.classes.has('modern-ui-v3')).toBe(false);
    expect(fake.classes.has('modern-ui')).toBe(false);
    expect(fake.document.documentElement.getAttribute('data-ui-version')).toBe('v1');
  });

  it('applies channel-info-overlay vars idempotently', () => {
    applySettingsDom(baseState() as any);
    expect(fake.properties.get('--cio-font-size')).toBe('16px');
    expect(fake.properties.get('--cio-logo-size')).toBe('42px');
    expect(fake.properties.get('--cio-box-width')).toBe('380px');

    const snapshot = { ...fake.writes };
    applySettingsDom({ ...baseState(), channelInfoOverlayFontSize: 18 } as any);
    expect(fake.properties.get('--cio-font-size')).toBe('18px');
    expect(fake.properties.get('--cio-logo-size')).toBe('42px'); // untouched

    const after = { ...fake.writes };
    applySettingsDom({ ...baseState(), channelInfoOverlayFontSize: 18 } as any);
    expect(fake.writes).toEqual(after);
  });

  it('applies widget-scale and widget-bg-opacity vars idempotently', () => {
    applySettingsDom(baseState() as any);
    expect(fake.properties.get('--widget-scale')).toBe('1');
    expect(fake.properties.get('--widget-bg-opacity')).toBe('0.55');
    // --cio-bg-opacity mirrors widget opacity (CSS fallback, old dead write dropped).
    expect(fake.properties.get('--cio-bg-opacity')).toBe('0.55');

    const snapshot = { ...fake.writes };
    applySettingsDom({ ...baseState(), widgetScale: 1.2 } as any);
    expect(fake.properties.get('--widget-scale')).toBe('1.2');
    expect(fake.properties.get('--widget-bg-opacity')).toBe('0.55');

    const after = { ...fake.writes };
    applySettingsDom({ ...baseState(), widgetScale: 1.2 } as any);
    expect(fake.writes).toEqual(after);
  });

  it('toggles the EPG cosmetic classes (load-time settings) idempotently', () => {
    applySettingsDom(baseState() as any);
    expect(fake.classes.has('epg-darken-current')).toBe(false);
    expect(fake.classes.has('epg-highlight-border-current')).toBe(false);
    expect(fake.classes.has('epg-bold-channel-names')).toBe(false);

    const snapshot = { ...fake.writes };
    applySettingsDom({
      ...baseState(),
      epgDarkenCurrent: true,
      epgHighlightBorderCurrent: true,
      epgBoldChannelNames: true,
      epgBoldTopCategories: true,
      epgBoldSourceCategories: true,
    } as any);
    expect(fake.classes.has('epg-darken-current')).toBe(true);
    expect(fake.classes.has('epg-highlight-border-current')).toBe(true);
    expect(fake.classes.has('epg-bold-channel-names')).toBe(true);
    expect(fake.classes.has('epg-bold-top-categories')).toBe(true);
    expect(fake.classes.has('epg-bold-source-categories')).toBe(true);

    const after = { ...fake.writes };
    applySettingsDom({
      ...baseState(),
      epgDarkenCurrent: true,
      epgHighlightBorderCurrent: true,
      epgBoldChannelNames: true,
      epgBoldTopCategories: true,
      epgBoldSourceCategories: true,
    } as any);
    expect(fake.writes).toEqual(after);
  });
});
