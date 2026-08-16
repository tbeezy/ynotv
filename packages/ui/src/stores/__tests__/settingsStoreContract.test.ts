import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useSettingsStore } from '../settingsStore';

/**
 * Consumer contract test for the settings store.
 *
 * Every consumer selects settings with either a slice selector
 * (`useSettingsStore((s) => s.foo)`) or a one-off `getState()` read
 * (`useSettingsStore.getState().foo`). A typo in one of those keys is a
 * runtime `undefined` — tsc can't catch it because zustand's selector
 * parameter is untyped at the call site (`(s: SettingsState) => unknown`).
 *
 * This test statically scans every non-test source file for those two forms
 * and asserts each extracted key is a real key of the store's state, so a
 * misspelled selector fails CI instead of silently breaking a component.
 */
const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walkSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) && !/\.d\.ts$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Capture full property chains for both forms, e.g.
 *   `useSettingsStore((s) => s.foo?.bar)`  → `.foo?.bar`
 *   `useSettingsStore.getState().foo.bar`  → `.foo.bar`
 * Optional chaining (`?.`) is captured so the walker can treat a
 * null/undefined intermediate as a legitimate short-circuit.
 */
const SLICE_SELECTOR_RE = /useSettingsStore\(\(s\)\s*=>\s*s((?:\.[A-Za-z0-9_]+(?:\?\.)?)+)/g;
const GET_STATE_RE = /useSettingsStore\.getState\(\)((?:\.[A-Za-z0-9_]+(?:\?\.)?)+)/g;

function extractChains(source: string): string[] {
  const chains: string[] = [];
  const collect = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) chains.push(m[1]);
  };
  collect(SLICE_SELECTOR_RE);
  collect(GET_STATE_RE);
  return chains;
}

interface ChainSegment {
  key: string;
  /** True when `?.` precedes this segment — null/undefined intermediates are legal. */
  guarded: boolean;
}

function parseChain(chain: string): ChainSegment[] {
  const segments: ChainSegment[] = [];
  const re = /\.([A-Za-z0-9_]+)(\?\.)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chain)) !== null) {
    segments.push({ key: m[1], guarded: !!m[2] });
  }
  return segments;
}

/**
 * Walk a chain against the real store state. Returns an error message, or
 * null when the path resolves (including legal optional-chain short-circuits).
 * `in` is used for member checks so prototype methods (.includes, .map, ...)
 * on arrays/strings don't false-positive. Limitation: a chain segment BEHIND a
 * currently-null value (e.g. `savedLayoutState?.layout`) can't be validated —
 * the optional chain legitimately short-circuits against the seeded state.
 */
function validateChain(state: Record<string, any>, chain: string): string | null {
  const segments = parseChain(chain);
  let cur: any = state;
  for (let i = 0; i < segments.length; i++) {
    const { key, guarded } = segments[i];
    if (cur === undefined || cur === null) {
      if (guarded) return null; // legal optional-chain short-circuit
      return `accesses '${key}' after a null/undefined value (add '?.')`;
    }
    if (i === 0 && !(key in cur)) {
      return `'${key}' is not a SettingsState key`;
    }
    if (!(key in Object(cur))) {
      return `'${key}' is not a property of the current value`;
    }
    cur = cur[key];
  }
  return null;
}

describe('useSettingsStore consumer contract', () => {
  const storeKeys = new Set<string>(Object.keys(useSettingsStore.getState()));

  it('exposes subtitleSettings + setter (regression for the subtitle migration)', () => {
    expect(storeKeys.has('subtitleSettings')).toBe(true);
    expect(storeKeys.has('setSubtitleSettings')).toBe(true);
  });

  it('exposes globalEpgLinks + auto-backup fields (regression for this migration)', () => {
    expect(storeKeys.has('globalEpgLinks')).toBe(true);
    expect(storeKeys.has('setGlobalEpgLinks')).toBe(true);
    expect(storeKeys.has('autoBackupEnabled')).toBe(true);
    expect(storeKeys.has('autoBackupIntervalHours')).toBe(true);
    expect(storeKeys.has('autoBackupMaxBackups')).toBe(true);
    expect(storeKeys.has('autoBackupDirectory')).toBe(true);
    expect(storeKeys.has('setAutoBackupSettings')).toBe(true);
  });

  it('exposes streaming-catalog, trailer, and metadata-API fields (regression for this migration)', () => {
    for (const key of [
      'streamingCatalogsEnabled', 'streamingNuvioCatalogsEnabled', 'enabledStreamingServices',
      'trailerSource', 'trailerPlayerMode', 'tmdbApiKey', 'posterDbApiKey', 'rpdbBackdropsEnabled',
      'setStreamingCatalogsEnabled', 'setStreamingNuvioCatalogsEnabled', 'setEnabledStreamingServices',
      'setTrailerSource', 'setTrailerPlayerMode', 'setTmdbApiKey', 'setPosterDbApiKey', 'setRpdbBackdropsEnabled',
    ]) {
      expect(storeKeys.has(key)).toBe(true);
    }
  });

  it('exposes downloadsPath and genre-list fields (regression for the Tier-2 pass)', () => {
    for (const key of [
      'downloadsPath', 'setDownloadsPath',
      'movieGenresEnabled', 'setMovieGenresEnabled',
      'seriesGenresEnabled', 'setSeriesGenresEnabled',
    ]) {
      expect(storeKeys.has(key)).toBe(true);
    }
  });

  it('exposes trakt/simkl/tvCalendar and category-visibility fields (regression for the final Tier-2 pass)', () => {
    for (const key of [
      'traktEnabled', 'traktAccessToken', 'traktRefreshToken', 'traktTokenExpiresAt',
      'traktScrobbleEnabled', 'traktSyncEnabled', 'traktCatalogsEnabled', 'traktCatalogOrder',
      'traktCatalogsBeforeAddon', 'traktEnabledLists', 'traktNuvioCatalogsEnabled',
      'traktNuvioCatalogOrder', 'traktNuvioCatalogsBeforeAddon', 'traktNuvioEnabledLists',
      'setTraktSettings', 'simklEnabled', 'simklAccessToken', 'simklScrobbleEnabled',
      'setSimklSettings', 'tvCalendarAutoSync', 'setTvCalendarAutoSync',
      'showAllChannels', 'showFavorites', 'showWatchlist', 'showRecentlyViewed',
      'favoritesMode', 'setCategorySettings', 'collapseSourceCategoriesOnStartup',
      'setCollapseSourceCategoriesOnStartup',
    ]) {
      expect(storeKeys.has(key)).toBe(true);
    }
  });

  it('exposes the final Tier-2 sweep fields (font sizes, uiScale, transparent guide, LAN gate, design)', () => {
    for (const key of [
      'channelFontSize', 'setChannelFontSize', 'categoryFontSize', 'setCategoryFontSize',
      'sourceFontSize', 'setSourceFontSize', 'epgTitleFontSize', 'setEpgTitleFontSize',
      'epgBodyFontSize', 'setEpgBodyFontSize', 'uiScale', 'setUiScale',
      'transparentGuideHeight', 'setTransparentGuideHeight', 'transparentGuideHideHeader',
      'setTransparentGuideHideHeader', 'transparentGuideOverlayOpacity',
      'setTransparentGuideOverlayOpacity', 'transparentGuideSidebarOpacity',
      'setTransparentGuideSidebarOpacity', 'allowLanSources', 'setAllowLanSources',
      'modernUiEnabled', 'setModernUiEnabled', 'v3DefaultMigrated',
      'stremioBadgeSize', 'setStremioBadgeSize', 'nuvioBadgeSize', 'setNuvioBadgeSize',
    ]) {
      expect(storeKeys.has(key)).toBe(true);
    }
  });

  const files = walkSourceFiles(SRC_DIR);
  const consumers = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return src.includes('useSettingsStore');
  });

  it('finds consumers to scan', () => {
    expect(consumers.length).toBeGreaterThan(10);
  });

  for (const file of consumers) {
    // SRC_DIR is a platform path (\ on Windows); normalize both sides so the
    // test names show a clean relative path.
    const relative = file.replace(/\\/g, '/').replace(SRC_DIR.replace(/\\/g, '/') + '/', '');
    const src = readFileSync(file, 'utf8');
    const state = useSettingsStore.getState() as Record<string, any>;
    const errors: string[] = [];
    for (const chain of extractChains(src)) {
      const err = validateChain(state, chain);
      if (err) errors.push(`${chain} → ${err}`);
    }

    it(`store access paths in ${relative} resolve against SettingsState`, () => {
      expect(errors).toEqual([]);
    });
  }
});
