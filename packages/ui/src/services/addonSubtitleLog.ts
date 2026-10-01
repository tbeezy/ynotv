/**
 * Runtime trace for the Stremio/Nuvio add-on subtitle pipeline.
 *
 * The pipeline spans four places that are silent in a release build — the
 * add-on metadata fetch, the language match, the on-demand download and the
 * translation-queue verdict — so a "why is this track missing / not loading"
 * report used to need a temporary diff and a rebuild to answer. This module is
 * the permanent, opt-in replacement for that.
 *
 * Two sinks, gated differently on purpose:
 *  - the in-app subtitle diagnostics ring is ALWAYS written, so a user who hits
 *    a problem can open the panel and copy it without having prepared anything;
 *  - the console / app-log sink only writes once the user opts in, through
 *    Settings -> Debug -> "Add-on subtitle trace" (or the general debug logging
 *    switch, which also unlocks the log file).
 *
 * Messages stay untranslated on purpose: this is diagnostic output for whoever
 * is debugging, not UI copy.
 */
import { logError, logInfo } from '../utils/logger';
import { useSubtitleDebugStore } from '../stores/subtitleDebugStore';

/** Stage a trace line came from; shown as `addon:<area>` in the diagnostics panel. */
export type AddonSubtitleTraceArea = 'fetch' | 'select' | 'download' | 'load' | 'click' | 'ui';

const AREA_LABEL = '[Stremio][addon-subs]';

let optedIn = false;

/** Set from the persisted Settings -> Debug switch, and once at bridge startup. */
export function setAddonSubtitleTraceEnabled(enabled: boolean): void {
  optedIn = enabled;
}

/** The general debug logging switch, which the log-file sink is bound to. */
function debugLoggingEnabled(): boolean {
  return typeof window !== 'undefined' && (window as any).__debugLoggingEnabled === true;
}

/** Opted into either the targeted trace or general debug logging. */
export function isAddonSubtitleTraceEnabled(): boolean {
  return optedIn || debugLoggingEnabled();
}

/** Write one trace line: always to the diagnostics ring, verbosely once opted in. */
export function addonSubLog(area: AddonSubtitleTraceArea, msg: string): void {
  useSubtitleDebugStore.getState().logSub(`addon:${area}`, msg);
  if (!isAddonSubtitleTraceEnabled()) return;

  const line = `${AREA_LABEL}[${area}] ${msg}`;
  if (debugLoggingEnabled()) {
    logInfo(line); // console + app log file
    return;
  }
  // Trace-only opt-in: the log file itself is gated by general debug logging,
  // so this reaches the console only.
  console.info(line);
}

/** Failure line. Same gating; the diagnostics ring keeps it in every case. */
export function addonSubError(area: AddonSubtitleTraceArea, msg: string, err?: unknown): void {
  const detail =
    err === undefined || err === null
      ? ''
      : ` — ${err instanceof Error ? err.message : String(err)}`;

  useSubtitleDebugStore.getState().logSub(`addon:${area}`, `error: ${msg}${detail}`);
  if (!isAddonSubtitleTraceEnabled()) return;

  const line = `${AREA_LABEL}[${area}] ${msg}${detail}`;
  if (debugLoggingEnabled()) {
    logError(line); // console + app log file
    return;
  }
  console.error(line, err);
}

interface AddonSubLangItem {
  lang?: string;
  langCode?: string;
}

/** `en=14, ar=12, …` for a list of add-on subtitles or tracks, busiest first. */
export function addonSubLangSummary(
  items: readonly AddonSubLangItem[] | undefined | null,
  key: 'lang' | 'langCode' = 'lang'
): string {
  if (!items?.length) return 'none';

  const counts = new Map<string, number>();
  for (const item of items) {
    const value = String((key === 'langCode' ? item.langCode : item.lang) ?? '').trim() || '?';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value}=${count}`)
    .join(', ');
}

/** One-line, length-capped view of a response body — enough to spot a banner. */
export function addonSubPreview(text: unknown, max = 200): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '(empty)';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
