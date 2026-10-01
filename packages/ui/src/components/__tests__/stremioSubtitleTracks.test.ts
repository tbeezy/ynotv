/**
 * Source-contract tests for on-demand Stremio/Nuvio add-on subtitles.
 *
 * The whole point of this rework is what the playback path must NOT do any more:
 * batch-download every track the add-on returned. That behaviour lives in the
 * component tree and the add-on store, neither of which the node test
 * environment can render, so these assertions pin the wiring in the real
 * sources — in particular that no download loop survived and that only a single
 * best-match track is auto-loaded.
 *
 * The track selection/capping/label/queue logic itself is unit-tested in
 * utils/__tests__/stremioSubs.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', '..');
const read = (...parts: string[]) => readFileSync(resolve(srcRoot, ...parts), 'utf8');

const app = read('App.tsx');
const modal = read('components', 'SubtitleControlModal.tsx');
const store = read('stores', 'stremioAddonStore.ts');
const panel = read('components', 'stremio', 'AddonManagerPanel.tsx');
const service = read('services', 'stremio-subs.ts');
const addonService = read('services', 'stremio-addon.ts');
const trace = read('services', 'addonSubtitleLog.ts');
const debugTab = read('components', 'settings', 'DebugTab.tsx');
const settingsTab = read('components', 'Settings.tsx');
const bridge = read('services', 'tauri-bridge.ts');

describe('Stremio add-on subtitles are downloaded on demand', () => {
  it('no longer batch-downloads every returned track', () => {
    expect(app).not.toContain('filteredSubs');
    expect(app).not.toContain("for (let i = 0; i < filteredSubs.length");
    // The eager path registered every track as a cached (unselected) file.
    expect(app).not.toContain("addSubtitleFile(filePath, 'cached')");
  });

  it('stores add-on metadata and loads only the best default-language match', () => {
    expect(app).toContain('const tracks = selectAddonTracks(subs);');
    expect(app).toContain('setAddonSubtitleTracks(tracks);');
    expect(app).toContain('addonSubtitleMetaIdRef.current = meta.id;');
    expect(app).toContain('const best = pickBestAddonTrack(tracks, normalizeSubtitleLang(defaultLanguage));');
    expect(app).toContain('void loadAddonSubtitle(best, true);');
    // Metadata is fetched even when the default language is off, so every
    // language stays reachable from the modal.
    expect(app).toContain("if (defaultLanguage === 'off') {");
    const block = app.slice(app.indexOf('const tracks = selectAddonTracks(subs);'));
    const downloadCall = block.indexOf('void loadAddonSubtitle(best, true);');
    expect(downloadCall, 'auto-load must sit inside the default-language branch').toBeGreaterThan(-1);
  });

  it('downloads exactly one file per selection and skips writing placeholders to disk', () => {
    // No iteration over a track list anywhere in the downloader.
    expect(service).not.toMatch(/for\s*\(/);
    expect(service).not.toMatch(/\.forEach\(/);
    expect((service.match(/writeTextFile\(/g) || []).length).toBe(1);
    expect(service).toContain('buildAddonSubtitleFilename({');
    expect(service).toContain('if (!parseQueuePlaceholder(text).queued)');
  });

  it('selects the track it just downloaded and replaces an earlier copy', () => {
    const loader = app.slice(
      app.indexOf('const loadAddonSubtitle = useCallback('),
      app.indexOf('const handleAddonSubtitleSelect = useCallback(')
    );
    expect(loader).toContain('await window.mpv.removeSubtitleFile(previousPath)');
    expect(loader).toContain("'select',");
    expect(loader).not.toContain("'cached'");
    expect(loader).toContain('parseQueuePlaceholder(download.text)');
  });

  it('does not evict or select files when translation is queued (non-destructive re-check)', () => {
    const loader = app.slice(
      app.indexOf('const loadAddonSubtitle = useCallback('),
      app.indexOf('const handleAddonSubtitleSelect = useCallback(')
    );
    const downloadIdx = loader.indexOf('downloadAddonSubtitle(');
    const queueCheckIdx = loader.indexOf('if (!queue.queued)');
    const removeIdx = loader.indexOf('window.mpv.removeSubtitleFile');
    const addIdx = loader.indexOf('window.mpv.addSubtitleFile');

    expect(downloadIdx).toBeGreaterThan(-1);
    expect(queueCheckIdx).toBeGreaterThan(downloadIdx);
    expect(removeIdx).toBeGreaterThan(queueCheckIdx);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });

  it('does not mark a translation-queue placeholder as loaded', () => {
    // A placeholder file downloads successfully but holds no dialogue, so the
    // row must keep showing its queue badge instead of the loaded styling.
    // Setting loaded to true must only occur inside the !queue.queued block.
    const loader = app.slice(
      app.indexOf('const loadAddonSubtitle = useCallback('),
      app.indexOf('const handleAddonSubtitleSelect = useCallback(')
    );
    expect(loader).toContain('!queue.queued');
    const queueCheckIdx = loader.indexOf('if (!queue.queued)');
    const loadedIdx = loader.indexOf('setAddonSubtitleLoaded');
    const queueEndIdx = loader.indexOf('setAddonSubtitleQueue');
    expect(queueCheckIdx).toBeGreaterThan(-1);
    expect(loadedIdx).toBeGreaterThan(queueCheckIdx);
    expect(loadedIdx).toBeLessThan(queueEndIdx);
  });
});

describe('Subtitle modal offers add-on tracks', () => {
  it('accepts add-on metadata and renders a per-language section', () => {
    expect(modal).toContain('addonSubtitleTracks?: AddonSubtitleTrack[];');
    expect(modal).toContain('onAddonSubtitleSelect?: (track: AddonSubtitleTrack) => void | Promise<void>;');
    expect(modal).toContain('const addonTrackList = (addonSubtitleTracks || []).filter(');
    expect(modal).toContain("className=\"subtitle-addon-tracks\"");
    expect(modal).toContain('onClick={() => void handleAddonTrackSelect(track)}');
    expect(modal).toContain('{addonTrackLabel(track)}');
    // Rows are named by language, so the add-on's own file name (out of the
    // visible line — it is a whole release name) stays available on hover.
    expect(modal).toContain('const detail = addonTrackDetail(track);');
    expect(modal).toContain('const rowTitle = detail ? `${detail} — ${track.url}` : track.url;');
    expect(modal).toContain('title={rowTitle}');
  });

  it('offers a language the add-ons carry even when no mpv track uses it', () => {
    // The language column drives the add-on row filter, so a language only the
    // add-on offers (Arabic from a translation add-on) has to be selectable.
    expect(modal).toContain('...(addonSubtitleTracks || []).map(t => t.langCode),');
  });

  it('shows the translation-queue state with a manual re-check', () => {
    expect(modal).toContain('subtitle-addon-queue-badge');
    expect(modal).toContain('{addonQueueStatusText(queue, t)}');
    // Clicking a queued track re-requests its URL — that IS the status check.
    expect(app).toContain('setAddonSubtitleQueue((prev) => {');
  });

  it('makes the re-check an explicit control on a queued row', () => {
    // The re-check is a real request that can bring the finished file in, so it
    // must be a visible, labelled control rather than a hidden side effect of
    // clicking the row — and the section says what is going on.
    expect(modal).toContain('className="subtitle-addon-queue-strip"');
    expect(modal).toContain('className="subtitle-addon-recheck"');
    expect(modal).toContain("{isLoading ? '…' : t('addonQueueRecheck')}");
    expect(modal).toContain('className="subtitle-addon-queue-hint"');
    expect(modal).toContain("{t('addonQueueHint')}");
    // The status strip is a sibling of the row button, never nested inside it,
    // and its control runs the same download the row click does.
    const stripIdx = modal.indexOf('className="subtitle-addon-queue-strip"');
    const strip = modal.slice(stripIdx);
    expect(strip.slice(0, 600)).toContain('onClick={() => void handleAddonTrackSelect(track)}');
  });

  it('reports the queue state identically in the toast and the badge', () => {
    // The player toast and the modal row badge must not each compose their own
    // wording: one shared formatter, or the two surfaces drift apart again.
    expect(app).toContain(
      "const statusText = addonQueueStatusText(queue, i18n.getFixedT(null, 'subtitles'));"
    );
    expect(app).toContain('`${addonTrackLabel(track)}: ${statusText}`');
    expect(modal).toMatch(/import \{[^}]*addonQueueStatusText[^}]*\} from '\.\.\/utils\/stremioSubs'/);
    // No private copies of the wording may survive on either surface.
    expect(app).not.toContain("i18n.t('subtitles:addonQueued");
    expect(app).not.toContain("i18n.t('subtitles:addonQueueFull");
    expect(modal).not.toContain("t('addonQueued");
    expect(modal).not.toContain("t('addonQueueFull')");
  });

  it('refreshes the loaded-track column right after an add-on track is selected', () => {
    // The player hands the download promise back to the modal...
    expect(app).toContain('return loadAddonSubtitle(track);');
    // ...which awaits it before re-reading mpv's track list, so the top column
    // no longer stays stale until the modal is closed and reopened.
    expect(modal).toContain('await onAddonSubtitleSelect(track);');
    const handler = modal.slice(modal.indexOf('await onAddonSubtitleSelect(track);'));
    expect(handler.slice(0, 120)).toContain('await loadTracks();');
  });

  it('keeps the loaded tint visible in every UI version', () => {
    // v3 re-declares the variant-title colour with !important, so the base
    // `.loaded` rule in SubtitleControlModal.css cannot win there — the theme
    // needs an override of its own, in both the dark and light blocks.
    const v3 = read('styles', 'ModernV3.css');
    expect(v3).toContain('.modern-ui-v3 .subtitle-addon-track-btn.loaded .subtitle-track-variant-title');
    expect(v3).toContain('html.modern-ui-v3[data-theme="light"] .subtitle-addon-track-btn.loaded .subtitle-track-variant-title');
  });

  it('is wired up by the player and scoped to Stremio/Nuvio media', () => {
    expect(app).toContain("addonSubtitleTracks={(vodInfo?.source_id === 'stremio' || vodInfo?.source_id === 'nuvio') ? addonSubtitleTracks : undefined}");
    expect(app).toContain('onAddonSubtitleSelect={handleAddonSubtitleSelect}');
    expect(app).toContain('clearAddonSubtitleTracks();');
  });

  it('clears add-on subtitle tracks whenever non-Stremio media plays', () => {
    expect(app).toContain("if (vodInfo && vodInfo.source_id !== 'stremio' && vodInfo.source_id !== 'nuvio') {");
    expect(app).toContain("if (channel.source_id !== 'vod')");
    expect(app).toContain('clearAddonSubtitleTracksRef.current?.();');
  });
});

describe('Add-ons that demand configuration cannot be installed silently', () => {
  it('refuses the unconfigured manifest and points at the configure page', () => {
    expect(store).toContain('if (manifest.behaviorHints?.configurationRequired && !options?.allowUnconfigured) {');
    expect(store).toContain('throw new AddonConfigurationRequiredError(');
    expect(store).toContain('openAddonConfigureUrl(configureUrl)');
    expect(store).toContain("addAddon: (url: string, options?: AddAddonOptions) => Promise<void>;");
  });

  it('surfaces the refusal in the add-on manager with an explicit override', () => {
    expect(panel).toContain("e?.code === 'addonConfigurationRequired'");
    expect(panel).toContain('handleInstall(configRequired.url, true)');
    expect(panel).toContain("i18n.t('stremio:installAnyway')");
    expect(panel).toContain("i18n.t('stremio:addonConfigurationHowTo')");
  });

  it('flags already-installed add-ons that still require configuration', () => {
    expect(panel).toContain('addon.manifest.behaviorHints?.configurationRequired');
  });
});

describe('The add-on subtitle trace is permanently instrumented', () => {
  it('traces every stage of the pipeline', () => {
    expect(addonService).toContain("addonSubLog('fetch'");
    expect(addonService).toContain('addonSubError(\'fetch\'');
    expect(app).toContain("addonSubLog('fetch'");
    expect(app).toContain("addonSubLog('select'");
    expect(app).toContain("addonSubLog('load'");
    expect(app).toContain('addonSubError(\'load\'');
    expect(service).toContain("addonSubLog('download'");
    expect(service).toContain('addonSubError(\'download\'');
    expect(modal).toMatch(/addonSubLog\(\s*'click'/);
    expect(modal).toMatch(/addonSubLog\(\s*'ui'/);
  });

  it('keeps the diagnostics ring unconditional and the console sink opt-in', () => {
    // The ring is what makes a support bundle useful without preparation; the
    // console/app-log sink must stay behind the Settings -> Debug opt-in.
    expect(trace).toContain('useSubtitleDebugStore.getState().logSub(`addon:${area}`');
    expect(trace).toContain('if (!isAddonSubtitleTraceEnabled()) return;');
    expect(trace).toContain('export function setAddonSubtitleTraceEnabled');
    expect(trace).toContain('__debugLoggingEnabled === true');
  });

  it('exposes the opt-in in Settings -> Debug and restores it at startup', () => {
    expect(debugTab).toContain("i18n.t('settings:debug.addonTraceLabel')");
    expect(debugTab).toContain('setAddonSubtitleTraceEnabled(enabled)');
    expect(debugTab).toContain('updateSettings({ addonSubtitleTraceEnabled: enabled })');
    expect(settingsTab).toContain('addonSubtitleTraceEnabled?: boolean;');
    expect(settingsTab).toContain('setAddonTraceEnabled(settings.addonSubtitleTraceEnabled ?? false)');
    expect(settingsTab).toContain('addonTraceEnabled={addonTraceEnabled}');
    expect(bridge).toContain('setAddonSubtitleTraceEnabled(settings.addonSubtitleTraceEnabled ?? false)');
  });
});
