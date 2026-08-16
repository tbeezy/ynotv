import { useSettingsStore } from '../stores/settingsStore';

/**
 * Auto "scroll turbo" — while the user is scrolling, temporarily strip the
 * expensive per-frame compositing work (backdrop-filter re-sampling on every
 * glass surface, glow blending on the liquid-glass blobs) by toggling a
 * `scroll-turbo` class on <html>.
 *
 * Why this is the GPU compromise: the "Enable GPU Hardware Acceleration"
 * toggle is binary — off means `--disable-gpu --disable-gpu-compositing`,
 * i.e. the whole UI is software-rasterized and scrolling becomes CPU-bound
 * (that's the low-fps feel). Turbo keeps GPU compositing on (so scrolling
 * stays at compositor speed) but removes the per-frame effects that make the
 * GPU spike while scrolling. Effects are fully restored ~120ms after the last
 * scroll event, so the only visible difference is during motion, when losing
 * the frosted blur is imperceptible.
 *
 * Unlike the settings-derived DOM writes in settingsDomApplier, this class is
 * event-derived (scroll), so it lives here rather than in the applier.
 */

const TURBO_IDLE_MS = 120;

let rafPending = false;
let idleTimer: number | undefined;

function setTurbo(on: boolean): void {
  document.documentElement.classList.toggle('scroll-turbo', on);
}

function onScroll(): void {
  if (!useSettingsStore.getState().reduceEffectsWhileScrolling) return;
  // Add the class at most once per frame — scroll events can fire more often
  // than the compositor can paint, and a classList write per event is waste.
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      setTurbo(true);
    });
  }
  // Keep the class alive while scroll events keep arriving; drop it shortly
  // after the last one so effects snap back the instant scrolling stops.
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => setTurbo(false), TURBO_IDLE_MS);
}

function init(): void {
  if (typeof document === 'undefined') return;
  // Capture phase: `scroll` doesn't bubble, but capture catches scrolls on
  // every nested container (EPG grid, category strip, modals, ...).
  document.addEventListener('scroll', onScroll, true);
  // If the user disables turbo mid-scroll, drop the class immediately.
  useSettingsStore.subscribe((state) => {
    if (!state.reduceEffectsWhileScrolling) {
      document.documentElement.classList.remove('scroll-turbo');
    }
  });
}

init();
