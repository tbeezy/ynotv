import { useSettingsStore } from './settingsStore';
import type { SettingsState } from './settingsStore';
import { applyCustomTheme, updateScrollbarHoverColor } from '../utils/themeHelper';
import { applyUiDesign } from '../utils/uiDesign';
import i18n from '../i18n';

/* ---------------------------------------------------------------------------
   Settings DOM applier — ONE idempotent applier for every documentElement
   side effect derived from the settings store.

   Phase 3 of the settings-store migration. Previously these writes were split
   across per-instance React effects the old useAppSettings hook (the source of the
   mount-time race bugs: every instance mounted with default state and briefly
   re-applied it), the store setters, and the hydration module. Now a single
   subscription owns them all:

     - each section re-applies only when its inputs actually changed
       (per-section signature compare — no churn on unrelated settings), and
     - the sections that mutate attributes/vars keep their own DOM-compare
       guards as a belt-and-suspenders (the existing font-effect pattern).

   The module self-initializes at import time — before React renders — so the
   first paint is already correct from the localStorage-seeded store state.
   This is the same guarantee the old OLED module-global provided, generalised
   to every settings-driven DOM property.
   --------------------------------------------------------------------------- */

const CUSTOM_THEME_KEYS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--surface-color',
  '--surface-hover',
  '--surface-active',
  '--surface-border',
  '--surface-glow',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-accent',
  '--accent-primary',
  '--accent-secondary',
  '--accent-glow',
  '--glass-blur',
  '--glass-saturation',
  '--glass-border',
  '--glass-shadow',
  '--bg-gradient-1',
  '--bg-gradient-2',
  '--bg-gradient-3',
  '--bg-gradient-4',
  '--bg-gradient-5',
  '--custom-blob-1',
  '--custom-blob-2',
  '--custom-blob-3',
  '--custom-blob-4',
  '--glass-blob-opacity',
  '--glass-blob-visibility',
  '--glass-blob-will-change',
];

/** Last-applied signature per section — a store change only touches DOM whose inputs changed. */
const lastApplied: Record<string, string> = {};

function sectionChanged(name: string, inputs: Record<string, unknown>): boolean {
  const sig = JSON.stringify(inputs);
  if (lastApplied[name] === sig) return false;
  lastApplied[name] = sig;
  return true;
}

function root(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.documentElement : null;
}

function setStyle(prop: string, value: string) {
  root()?.style.setProperty(prop, value);
}

function removeStyle(prop: string) {
  root()?.style.removeProperty(prop);
}

function toggleClass(name: string, on: boolean) {
  const el = root();
  if (!el) return;
  if (on) el.classList.add(name);
  else el.classList.remove(name);
}

export function applySettingsDom(state: SettingsState): void {
  // Theme + custom-theme vars + scrollbar hover color.
  if (sectionChanged('theme', { theme: state.theme, config: state.customThemeConfig })) {
    const el = root();
    if (el) {
      if (el.getAttribute('data-theme') !== state.theme) {
        el.setAttribute('data-theme', state.theme);
      }
      if (state.theme === 'custom' && state.customThemeConfig) {
        applyCustomTheme(state.customThemeConfig);
      } else {
        CUSTOM_THEME_KEYS.forEach((key) => el.style.removeProperty(key));
      }
    }
    // Keep the scrollbar hover color readable: if the theme's accent is too
    // dark against the background (e.g. a black accent on a dark theme) it
    // would make hover-highlighted scrollbars invisible. See themeHelper.
    updateScrollbarHoverColor();
  }

  // Global font (CJK fallback + custom font-face + DOM-compare guard — the
  // existing font-effect pattern, now single-sourced).
  if (sectionChanged('font', {
    family: state.appFontFamily,
    base64: state.appCustomFontBase64,
    format: state.appCustomFontFormat,
    lang: i18n.language,
  })) {
    const el = root();
    if (!el) return;

    let fontValue = "'Inter', system-ui, sans-serif";
    let fontFaceName: string | null = null;
    if (state.appFontFamily === 'switzer') {
      fontValue = "'Switzer', sans-serif";
      fontFaceName = 'Switzer';
    } else if (state.appFontFamily === 'sentient') {
      fontValue = "'Sentient', serif";
      fontFaceName = 'Sentient';
    } else if (state.appFontFamily === 'fraunces') {
      fontValue = "'Fraunces', serif";
      fontFaceName = 'Fraunces';
    } else if (state.appFontFamily === 'cabinet-grotesk') {
      fontValue = "'Cabinet Grotesk', sans-serif";
      fontFaceName = 'Cabinet Grotesk';
    } else if (state.appFontFamily === 'custom' && state.appCustomFontBase64) {
      fontValue = "'custom-uploaded-font', sans-serif";
    }

    // CJK font fallback: Chinese locales (zh-CN / zh-TW) need a CJK-capable font for
    // glyphs the latin UI fonts don't cover. Append the platform CJK stack to whatever
    // UI font is selected so Chinese text always renders (latin keeps the chosen face).
    const activeLng = i18n.language || i18n.resolvedLanguage || 'en';
    if (activeLng.startsWith('zh')) {
      const cjkStack =
        activeLng === 'zh-TW'
          ? "'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC', 'Heiti TC', sans-serif"
          : "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif";
      const primary = fontValue.split(',')[0];
      fontValue = `${primary}, ${cjkStack}`;
    }

    // Guard: if the DOM already has this exact value, no work needed.
    const currentDomValue = el.style.getPropertyValue('--font-family');
    const needsFontWrite = currentDomValue !== fontValue;

    let styleEl = document.getElementById('custom-theme-font-face') as HTMLStyleElement;
    if (state.appFontFamily === 'custom' && state.appCustomFontBase64) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-theme-font-face';
        document.head.appendChild(styleEl);
      }
      const format = state.appCustomFontFormat || 'woff2';
      const newFace = `@font-face{font-family:'custom-uploaded-font';src:url('${state.appCustomFontBase64}')format('${format}');font-weight:100 900;font-style:normal;font-display:block;}`;
      if (styleEl.innerHTML !== newFace) {
        styleEl.innerHTML = newFace;
      }
    } else {
      if (styleEl) styleEl.remove();
    }

    if (!needsFontWrite) return;

    // Pre-load the selected font before applying it to avoid any remaining FOUT.
    if (fontFaceName && document.fonts) {
      document.fonts.load(`400 1em '${fontFaceName}'`).then(() => {
        el.style.setProperty('--font-family', fontValue);
      }).catch(() => {
        el.style.setProperty('--font-family', fontValue);
      });
    } else {
      el.style.setProperty('--font-family', fontValue);
    }
  }

  // Optimization classes
  if (sectionChanged('blur', { v: state.disableThemeBackdropBlur })) {
    toggleClass('disable-theme-backdrop-blur', !!state.disableThemeBackdropBlur);
  }
  if (sectionChanged('epgTransitions', { v: state.disableEpgTransitions })) {
    toggleClass('disable-epg-transitions', !!state.disableEpgTransitions);
  }
  if (sectionChanged('epgGpuLayers', { v: state.epgReduceGpuLayers })) {
    toggleClass('epg-reduce-gpu-layers', !!state.epgReduceGpuLayers);
  }
  if (sectionChanged('epgChannelFade', { v: state.epgDisableChannelFade })) {
    toggleClass('epg-disable-channel-fade', !!state.epgDisableChannelFade);
  }

  // OLED true-black — absorbed from the old module-global. One writer, one
  // source: purely derived from state.oledBlack (the CSS gates on dark themes).
  if (sectionChanged('oled', { v: state.oledBlack })) {
    const el = root();
    if (el) {
      if (state.oledBlack) {
        el.dataset.oled = 'true';
      } else {
        delete el.dataset.oled;
      }
    }
  }

  // Logo / EPG classes + vars
  if (sectionChanged('epgRectangleLogos', { v: state.epgLogoDisplay })) {
    toggleClass('epg-rectangle-logos', state.epgLogoDisplay === 'rectangle');
  }
  if (sectionChanged('channelLogoSize', { v: state.channelLogoSize })) {
    setStyle('--channel-logo-size', `${state.channelLogoSize}px`);
  }
  if (sectionChanged('channelLogoRoundEdges', { v: state.channelLogoRoundEdges })) {
    if (!state.channelLogoRoundEdges) {
      setStyle('--channel-logo-radius', '0px');
      toggleClass('logo-sharp-edges', true);
    } else {
      removeStyle('--channel-logo-radius');
      toggleClass('logo-sharp-edges', false);
    }
  }
  if (sectionChanged('channelLogoPadding', { v: state.channelLogoPadding })) {
    toggleClass('logo-padded-tiles', state.channelLogoPadding === 'padded');
  }

  // UI font sizes (moved from the autosync boot block + Settings editor)
  if (sectionChanged('channelFontSize', { v: state.channelFontSize })) {
    setStyle('--channel-font-size', `${state.channelFontSize}px`);
  }
  if (sectionChanged('categoryFontSize', { v: state.categoryFontSize })) {
    setStyle('--category-font-size', `${state.categoryFontSize}px`);
  }
  if (sectionChanged('sourceFontSize', { v: state.sourceFontSize })) {
    setStyle('--source-font-size', `${state.sourceFontSize}px`);
  }
  if (sectionChanged('epgTitleFontSize', { v: state.epgTitleFontSize })) {
    setStyle('--epg-title-font-size', `${state.epgTitleFontSize}px`);
  }
  if (sectionChanged('epgBodyFontSize', { v: state.epgBodyFontSize })) {
    setStyle('--epg-body-font-size', `${state.epgBodyFontSize}px`);
  }

  // UI scale (--app-zoom). Dispatch a resize so the EPG grid re-measures
  // availableWidth under the new zoom (was done inline in the autosync boot).
  if (sectionChanged('uiScale', { v: state.uiScale })) {
    setStyle('--app-zoom', String(state.uiScale / 100));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('resize'));
    }
  }

  // Transparent guide overlay (was applied inline in the autosync boot block)
  if (sectionChanged('transparentGuideHeight', { v: state.transparentGuideHeight })) {
    setStyle('--transparent-guide-height', `${state.transparentGuideHeight}%`);
  }
  if (sectionChanged('transparentGuideHideHeader', { v: state.transparentGuideHideHeader })) {
    toggleClass('transparent-guide-hide-header', !!state.transparentGuideHideHeader);
  }
  if (sectionChanged('transparentGuideOverlayOpacity', { v: state.transparentGuideOverlayOpacity })) {
    setStyle('--transparent-guide-overlay-opacity', String(state.transparentGuideOverlayOpacity / 100));
  }
  if (sectionChanged('transparentGuideSidebarOpacity', { v: state.transparentGuideSidebarOpacity })) {
    setStyle('--transparent-guide-sidebar-opacity', String(state.transparentGuideSidebarOpacity / 100));
  }

  // UI design version (v1/v2/v3 classes + stylesheets). The value comes from
  // the store (hydration latches the v3-default migration); applyUiDesign is
  // idempotent and owns the class/stylesheet side effects.
  if (sectionChanged('uiDesign', { v: state.modernUiEnabled })) {
    applyUiDesign(state.modernUiEnabled === 'v3' ? 'v3' : (state.modernUiEnabled === false || state.modernUiEnabled === 'v1' ? 'v1' : 'v2'));
  }

  // Custom scrollbar
  if (sectionChanged('customScrollbar', { enabled: state.enableCustomScrollbarWidth, width: state.customScrollbarWidth })) {
    const el = root();
    if (el) {
      if (state.enableCustomScrollbarWidth) {
        el.dataset.customScrollbar = 'true';
        el.style.setProperty('--app-scrollbar-width', `${state.customScrollbarWidth}px`);
      } else {
        delete el.dataset.customScrollbar;
        el.style.removeProperty('--app-scrollbar-width');
      }
    }
  }

  // Widget scale
  if (sectionChanged('widget', { scale: state.widgetScale, opacity: state.widgetBgOpacity })) {
    setStyle('--widget-scale', String(state.widgetScale));
    setStyle('--widget-bg-opacity', String(state.widgetBgOpacity));
    // --cio-bg-opacity is only a CSS fallback under --widget-bg-opacity
    // (ChannelInfoOverlay.css); mirror widget opacity into it exactly as the
    // old load/setter did. The old setChannelInfoOverlayOpacity write to this
    // var was always shadowed — a dead write, dropped here (visually identical).
    setStyle('--cio-bg-opacity', String(state.widgetBgOpacity));
  }

  // Sports overlay
  if (sectionChanged('sports', { scale: state.sportsScale, opacity: state.sportsBgOpacity })) {
    setStyle('--sports-scale', String(state.sportsScale));
    setStyle('--sports-bg-opacity', String(state.sportsBgOpacity));
  }

  // Channel-info overlay sizing vars
  if (sectionChanged('channelInfoOverlay', { fs: state.channelInfoOverlayFontSize, ls: state.channelInfoOverlayLogoSize, bw: state.channelInfoOverlayBoxWidth })) {
    setStyle('--cio-font-size', `${state.channelInfoOverlayFontSize}px`);
    setStyle('--cio-logo-size', `${state.channelInfoOverlayLogoSize}px`);
    setStyle('--cio-box-width', `${state.channelInfoOverlayBoxWidth}px`);
  }

  // EPG cosmetic classes (load-time settings, no setters)
  if (sectionChanged('epgCosmetic', {
    darken: state.epgDarkenCurrent,
    highlight: state.epgHighlightBorderCurrent,
    boldNames: state.epgBoldChannelNames,
    boldTop: state.epgBoldTopCategories,
    boldSource: state.epgBoldSourceCategories,
  })) {
    toggleClass('epg-darken-current', !!state.epgDarkenCurrent);
    toggleClass('epg-highlight-border-current', !!state.epgHighlightBorderCurrent);
    toggleClass('epg-bold-channel-names', !!state.epgBoldChannelNames);
    toggleClass('epg-bold-top-categories', !!state.epgBoldTopCategories);
    toggleClass('epg-bold-source-categories', !!state.epgBoldSourceCategories);
  }
}

function init(): void {
  if (typeof document === 'undefined') return;
  // Apply the localStorage-seeded state before first paint.
  applySettingsDom(useSettingsStore.getState());
  // Re-apply on every state change (hydration + setters) — idempotent.
  useSettingsStore.subscribe((state) => applySettingsDom(state));
}

/** Test-only: clear the per-section change tracking so a fresh fake DOM can
 *  be driven from scratch (settingsDomApplier.test.ts calls this between
 *  cases instead of re-importing the module). Never used in production. */
export function __resetSettingsApplierStateForTests(): void {
  Object.keys(lastApplied).forEach((k) => delete lastApplied[k]);
}

init();
