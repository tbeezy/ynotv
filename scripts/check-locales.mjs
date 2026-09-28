// Locale allowlist enforcement + key parity check.
//
// 1. Every locale file must have a matching entry in SUPPORTED_LOCALES (and vice versa).
// 2. All locale files must have the same set of flattened keys as en.json (the source of truth).
//
// Runs as part of `pnpm --filter @ynotv/ui typecheck`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const localesDir = join(root, '..', 'packages', 'ui', 'src', 'i18n', 'locales');
const indexFile = join(root, '..', 'packages', 'ui', 'src', 'i18n', 'index.ts');

const registrySource = readFileSync(indexFile, 'utf8');
const registered = [...registrySource.matchAll(/code:\s*'([a-zA-Z0-9-]+)'/g)].map((m) => m[1]);

const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
const fileCodes = [...new Set(files.map((f) => f.replace(/\.json$/, '')))];

const errors = [];

// --- Check 1: allowlist parity ---
for (const code of fileCodes) {
  if (!registered.includes(code)) {
    errors.push(`Locale file "locales/${code}.json" exists but "${code}" is missing from SUPPORTED_LOCALES in src/i18n/index.ts.`);
  }
}
for (const code of registered) {
  if (!fileCodes.includes(code)) {
    errors.push(`SUPPORTED_LOCALES lists "${code}" but no locales/${code}.json file exists.`);
  }
}

// --- Check 2: key parity (all locales must have the same keys as en.json) ---
function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

// Flatten to leaf entries (key path + value) for value-level checks.
function flattenLeaves(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenLeaves(v, full));
    } else {
      out.push([full, v]);
    }
  }
  return out;
}

const enPath = join(localesDir, 'en.json');
const enObj = JSON.parse(readFileSync(enPath, 'utf8'));
const enKeys = new Set(flattenKeys(enObj));
const enLeaves = new Map(flattenLeaves(enObj));

function placeholderSet(text) {
  return (text.match(/\{\{[^}]+\}\}/g) || []).sort().join(',');
}

for (const code of fileCodes) {
  if (code === 'en') continue;
  const localePath = join(localesDir, `${code}.json`);
  const localeObj = JSON.parse(readFileSync(localePath, 'utf8'));
  const localeKeys = new Set(flattenKeys(localeObj));

  for (const key of enKeys) {
    if (!localeKeys.has(key)) {
      errors.push(`[key-parity] "${code}.json" is missing key: "${key}" (exists in en.json).`);
    }
  }
  for (const key of localeKeys) {
    if (!enKeys.has(key)) {
      errors.push(`[key-parity] "${code}.json" has extra key: "${key}" (not in en.json).`);
    }
  }

  // --- Check 3: value hygiene (leaked tokens, placeholder mismatch, ZWSP) ---
  for (const [key, value] of flattenLeaves(localeObj)) {
    if (typeof value !== 'string') continue;
    if (value.includes('@@')) {
      errors.push(`[value-hygiene] "${code}.json" key "${key}" contains a leaked translation token ("@@...@@"): ${JSON.stringify(value.slice(0, 120))}`);
    }
    if (/[\u200b\ufeff]/.test(value)) {
      // ZWSP (U+200B) and BOM (U+FEFF) are never legitimate in these locales;
      // ZWNJ/ZWJ (U+200C/U+200D) are intentionally excluded (Persian orthography).
      errors.push(`[value-hygiene] "${code}.json" key "${key}" contains a zero-width space / BOM character: ${JSON.stringify(value.slice(0, 120))}`);
    }
    const enValue = enLeaves.get(key);
    if (typeof enValue === 'string' && placeholderSet(enValue) !== placeholderSet(value)) {
      errors.push(`[value-hygiene] "${code}.json" key "${key}" placeholder mismatch: en=[${placeholderSet(enValue)}] locale=[${placeholderSet(value)}] value=${JSON.stringify(value.slice(0, 120))}`);
    }
  }
}

// --- Check 4 (report-only): untranslated values ---
// Locale values still byte-identical to en.json are flagged as a WARNING, not
// an error, because some values legitimately stay English (brand names,
// technical tokens, units, punctuation). Auto-skipped:
//   - values with no lowercase ASCII letters ("DRM", "4K / UHD", "OK", "1 GB")
//   - values with no letters at all (")", ":", "\"{{name}}\"")
// Plus an explicit allowlist for brand names / fonts / genres / unit strings.
// Add keys here only when the English value is intentionally a constant.
const UNTRANSLATED_ALLOWLIST = new Set([
  // user agents + placeholders
  'settings.sources.uaTivimate', 'settings.sources.uaGse', 'settings.sources.uaIptvSmarters',
  'settings.sources.uaFallbackHintCode', 'settings.sources.uaFallbackHintPost', 'settings.sources.uaPlaceholderEx',
  'settings.sources.bulkStalkerPlaceholder',
  'settings.sources.xtreamCodes', 'settings.sources.stalkerPortal', 'settings.sources.epgUrl',
  'settings.sources.epgIdColon', 'settings.sources.epgIdTvg', 'settings.sources.confirmDeleteName',
  'settings.sources.deleteConfirmPost', 'settings.nuvio.tmdbTokenPlaceholder', 'epg.logoUrlPlaceholder',
  'settings.strem.badgeUrlPlaceholder', 'settings.categoryManager.enterFolderNamePost',
  'settings.categoryManager.enterNewFolderNamePost', 'settings.categoryManager.deleteFolderConfirmPost',
  'settings.categoryManager.deleteFolderConfirmName',
  // FFmpeg command-line examples — intentionally identical in every locale
  'settings.dvr.extraInputArgsPlaceholder', 'settings.dvr.extraOutputArgsPlaceholder',
  // "HLS" is the name of the format, not a translatable word
  'dvr.streamTypeHls',
  // French calls a playlist's EPG source "source" too ("Source : {{name}}"), so the
  // Feed/Source grouping labels legitimately share one word there
  'fr:epg.matchesGroupSource',
  // "Filter" is the same word in these languages, and French spells the strict
  // threshold preset "Strict" too — constants, not missed translations
  'bs:epg.filter', 'de:epg.filter', 'hr:epg.filter', 'nl:epg.filter', 'fr:epg.thresholdStrict',
  // "Server" is the ordinary word for a server in these languages (a loanword), so the
  // Stalker server-search label legitimately matches English there
  'bs:vod.stalkerServerSearchSource', 'de:vod.stalkerServerSearchSource',
  'it:vod.stalkerServerSearchSource', 'nl:vod.stalkerServerSearchSource',
  'bs:player.connectionInfo.server', 'de:player.connectionInfo.server',
  'it:player.connectionInfo.server', 'nl:player.connectionInfo.server',
  // Identical terms in connection info ("Status", "Type", "Account", "Error") across languages
  'bs:player.connectionInfo.status', 'de:player.connectionInfo.status', 'hr:player.connectionInfo.status',
  'nl:player.connectionInfo.status', 'pl:player.connectionInfo.status', 'pt-BR:player.connectionInfo.status',
  'sr:player.connectionInfo.status', 'fr:player.connectionInfo.type', 'nl:player.connectionInfo.type',
  'it:player.connectionInfo.account', 'nl:player.connectionInfo.account', 'es:player.connectionInfo.statusError',
  // controller hardware labels (printed on the physical buttons) + universal terms
  'settings.controllers.mapping.buttons.select', 'settings.controllers.mapping.buttons.start',
  'settings.controllers.mapping.groups.dpad', 'settings.controllers.mapping.groups.menu',
  // brand / product names
  'nav.items.nuvio', 'nav.items.stremio', 'nav.items.jellyfin', 'settings.tabs.nuvio', 'settings.tabs.strem',
  'settings.tabs.jellyfin', 'settings.jellyfin.title', 'settings.jellyfin.scrobblingTitle',
  'settings.tabs.scrobbling', 'settings.tabs.simkl', 'settings.tabs.discord',
  'settings.startup.views.stremio', 'settings.startup.views.nuvio', 'settings.startup.views.guide',
  'settings.scrobbling.title', 'settings.simkl.title', 'settings.nuvio.title',
  'settings.tmdb.tabs.tmdb', 'settings.tmdb.tabs.rpdb', 'cast.googleCast', 'cast.chromecast',
  'tvShows.imdb', 'settings.playback.tabs.mpv', 'sports.tabs.worldcup', 'vod.editMetadataTmdbId',
  // fonts
  'settings.ui.fraunces', 'settings.ui.sentient', 'settings.ui.switzer', 'settings.ui.cabinetGrotesk',
  'settings.theme.fraunces', 'settings.theme.sentient', 'settings.theme.switzer', 'settings.theme.cabinetGrotesk',
  // media genres (industry-standard English labels)
  'nuvio.anime', 'stremio.anime', 'stremio.reality', 'stremio.thriller', 'stremio.horror',
  'stremio.drama', 'stremio.romance', 'stremio.action', 'stremio.comedy', 'stremio.animation',
  'stremio.sciFiFantasy', 'stremio.kidsFamily',
  // units / technical tokens
  'common.contextMenu.min', 'common.contextMenu.minShort', 'common.contextMenu.min_one',
  'common.contextMenu.min_other', 'common.contextMenu.min_few', 'common.contextMenu.min_many',
  'common.contextMenu.min_two', 'common.contextMenu.min_zero', 'settings.playback.minUnit',
  'settings.playback.secUnit', 'settings.dvr.min_one', 'tvShows.minutes_one',
  // "s" is the correct seconds abbreviation in bs/de/es/fr/hr/it/nl/pl/pt-BR/sq,
  // exactly as it already is for time.secAgo in those locales.
  'time.durationS',
  'time.durationM', 'time.durationH', 'time.durationHM', 'time.lessThanMinute', 'vod.durationHM',
  'probe.progressCount', 'probe.msValue', 'probe.fpsValue', 'probe.eta', 'probe.chPerSec',
  'probe.ok', 'probe.drm', 'probe.quality4k', 'probe.quality1080p', 'probe.quality720p', 'probe.qualitySd',
  'probe.tabDrm', 'probe.tab4k', 'probe.tab1080p', 'probe.tab720p', 'probe.tabSd', 'probe.colFps',
  'settings.livetv.logos.gb1', 'settings.livetv.logos.mb100', 'settings.livetv.logos.mb250',
  'settings.livetv.logos.mb500', 'settings.livetv.logos.xl56', 'settings.livetv.fps',
  'settings.livetv.avgBitrateLocationFailover', 'settings.subtitles.maxVolume100',
  'settings.navigation.tabs.epg', 'settings.navigation.tabs.vod', 'vod.sortName', 'common.ok', 'common.rec', 'common.live',
  'tvShows.nA', 'tvShows.tba', 'tvShows.tbd', 'sports.pct', 'sports.pts', 'sports.pos', 'sports.vs',
  'sports.tbd', 'sports.statusLive', 'sports.live', 'sports.statusFinal', 'sports.wins',
  'player.dl', 'player.dlWithCount', 'nuvio.tv', 'stremio.tv', 'subtitles.tv', 'tvShows.idLabel',
  'settings.ui.legacy', 'updates.sparkles', 'vod.nameAZ', 'vod.nameZA',
  // tech loanwords — universally kept in English (Cast, Proxy, Audio, Auto, ...)
  'settings.playback.tabs.cast', 'nav.items.cast', 'player.cast', 'stremio.cast', 'vod.cast',
  'settings.tabs.proxy', 'settings.subtitles.tabs.audio', 'probe.colAudio', 'probe.colVideo',
  'settings.sources.expLabel', 'logoEditor.autoTab', 'logoEditor.auto', 'common.test',
  'settings.nuvio.cwPoster', 'nuvio.poster', 'settings.overlay.logoPlaceholder', 'tvShows.statusLabel',
  'probe.colStatus', 'settings.livetv.logos.formatLabel', 'settings.tabs.cache', 'epg.normalPadding',
  'player.trailer', 'vod.trailerSuffix', 'settings.livetv.favoritesModeGlobal', 'settings.posterdb.tier',
  'settings.ui.v2Modern', 'player.live', 'player.visualizerVinylShort', 'tvShows.debug',
  'settings.tabs.debug', 'settings.tabs.livetv', 'nuvio.scrapers', 'player.volume', 'player.volumeValue',
  'sports.tabs.info', 'dvr.downloads', 'player.catchup', 'settings.playback.tabs.catchup',
  'player.epgCatchup', 'player.pip', 'settings.startup.layouts.pip', 'player.layoutPip', 'sports.total',
  'settings.shortcuts.groups.Layout', 'player.layoutLabel', 'settings.startup.layoutLabel',
  'settings.shortcuts.groups.Interface', 'settings.shortcuts.groups.Navigation', 'settings.tabs.navigation',
  'sports.sport', 'sports.team', 'sports.streams', 'player.playerLabel', 'player.pause', 'probe.pause', 'player.stop',
  'player.popout', 'player.shuffle', 'nuvio.addons', 'settings.about.updatesTitle',
  'player.visualizerCircularShort', 'sports.score', 'sports.stat', 'settings.livetv.channels.providerOption',
  'subtitles.provider', 'settings.sources.type', 'nuvio.type', 'player.mpvTimeout', 'probe.timeoutLabel',
  'nuvio.optional', 'nuvio.top', 'settings.ui.general', 'common.rectangle', 'sports.date',
  'settings.sources.password', 'settings.subtitles.password', 'settings.nuvio.passwordPlaceholder',
  'nuvio.password', 'stremio.password', 'settings.sources.passwordPlaceholder', 'vod.home', 'nuvio.home',
  'stremio.home', 'common.contextMenu.start', 'epg.start', 'epg.startRequired', 'common.no',
  'nav.items.series', 'settings.startup.views.series', 'stremio.series', 'nav.items.sports',
  'settings.startup.views.sports', 'sports.brandName', 'vod.recent', 'widgets.recentWithCount',
  'stremio.plot', 'settings.sources.name', 'settings.failover.sortName', 'settings.about.version', 'settings.sources.sourcesTitle',
  'settings.tabs.sources', 'settings.failover.tabSources', 'settings.sources.sourceColon',
  'common.contextMenu.source', 'epg.sourceLabel', 'live.source', 'player.source', 'playlist.source',
  'settings.startup.slotChannel', 'settings.proxy.serverLabel', 'settings.overlay.horizontal169',
  'settings.ui.cleanBorderless', 'sports.gameCardAria', 'stremio.torrentNum', 'stremio.streamNum',
  'sports.backupChannel', 'player.backupAttempt', 'player.viewerLabel', 'common.errorPrefix',
  'common.contextMenu.error', 'settings.nuvio.errorPrefix', 'tvShows.debugError', 'subtitles.verboseOn',
  'logoEditor.paddingLabel', 'settings.tabs.metadata', 'settings.theme.stop1', 'settings.theme.stop2',
  'settings.theme.stop4', 'settings.simkl.openPin', 'nuvio.collections', 'tvShows.notifications',
  'stremio.pageIndicator', 'subtitles.trackLabel', 'probe.concurrencySlots', 'playlist.addFolder',
  'widgets.persistent', 'settings.playlists.colActions', 'probe.colActions', 'settings.failover.backup',
  'sports.liveCount', 'probe.onePlaylist', 'vod.playlists', 'settings.failover.backupNum',
  'settings.failover.streamCount_one', 'settings.sources.seriesCount', 'sports.backupsCount',
  'common.programsCount_one', 'settings.failover.smartAutoGroup', 'settings.failover.matchingOptions',
  'settings.failover.sportsOnly', 'settings.failover.created',
  // bitrate/unit column headers + value tokens
  'probe.kbpsValue', 'probe.sortByBitrate', 'probe.colVideoBitrate', 'probe.colAudioBitrate',
  'vod.folderTypeSeries', 'settings.navigation.showVodPlaylists',
  // loanwords Google (rightly) keeps identical in specific languages
  'settings.ui.player', 'stremio.account', 'settings.about.documentation', 'sports.filterSuggestions',
  'epg.description', 'common.syncingBatchWithPrefix', 'nav.items.liveTv', 'updates.later',
  // per-locale exceptions: "Local" is the correct word in Spanish/Portuguese
  'es:vod.local', 'pt-BR:vod.local', 'es:stremio.local', 'pt-BR:stremio.local',
  // Spanish singular for the error-count badge is the same word as English
  'es:common.errorCount_one',
  // French "source"/"sources" for the show-source count hint is the same word
  'fr:common.sourcesCount_one', 'fr:common.sourcesCount_other', 'fr:common.sourcesCount_few',
  'fr:common.sourcesCount_many', 'fr:common.sourcesCount_two', 'fr:common.sourcesCount_zero',
  'es:settings.navigation.showVodLocal', 'pt-BR:settings.navigation.showVodLocal',
  // per-locale exceptions: the English word is already the correct translation
  // (Dutch "Recent", German "Episode", French "Pause"/"Auto")
  'nl:settings.navigation.showVodRecent', 'de:vod.episode',
  'fr:vod.pauseScan', 'fr:vod.editEpisodeSeasonPlaceholder',
  // "Auto" is the native word in these locales (loanword), not an untranslated gap
  'bs:settings.livetv.logos.defaultBgAuto', 'de:settings.livetv.logos.defaultBgAuto',
  'fr:settings.livetv.logos.defaultBgAuto', 'hr:settings.livetv.logos.defaultBgAuto',
  'it:settings.livetv.logos.defaultBgAuto', 'nl:settings.livetv.logos.defaultBgAuto',
  'pl:settings.livetv.logos.defaultBgAuto', 'sq:settings.livetv.logos.defaultBgAuto',
  // per-locale exceptions: de/el/pl keep the English loanword "Catch-up"
  // (their player.catchup / settings.playback.tabs.catchup are identical too)
  'de:live.viewAllCatchup', 'el:live.viewAllCatchup', 'pl:live.viewAllCatchup',
  // per-locale exceptions: "Normal"/"Compact" size labels are universal loanwords
  'de:settings.controllers.remoteCustomizer.buttonSizeNormal',
  'de:settings.controllers.remoteCustomizer.centerSizeNormal',
  'fr:settings.controllers.remoteCustomizer.buttonSizeCompact',
  'fr:settings.controllers.remoteCustomizer.buttonSizeNormal',
  'es:settings.controllers.remoteCustomizer.buttonSizeNormal',
  'nl:settings.controllers.remoteCustomizer.buttonSizeCompact',
  'pt-BR:settings.controllers.remoteCustomizer.buttonSizeNormal',
  'sq:settings.controllers.remoteCustomizer.buttonSizeNormal',
  'tr:settings.controllers.remoteCustomizer.buttonSizeNormal',
]);

// Values with no lowercase ASCII letters ("DRM", "OK", "4K / UHD", "1 GB") or no
// letters at all (").", ":") are never translatable — skip without allowlisting.
function isConstantLike(value) {
  if (!/[a-z]/.test(value)) return true;
  if (!/[A-Za-zÀ-ÿ]/.test(value)) return true;
  return false;
}

const untranslatedWarnings = []; // [locale, key, value]
for (const code of fileCodes) {
  if (code === 'en') continue;
  const localeObj = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
  for (const [key, value] of flattenLeaves(localeObj)) {
    if (typeof value !== 'string') continue;
    const enValue = enLeaves.get(key);
    if (typeof enValue !== 'string' || value !== enValue) continue;
    if (UNTRANSLATED_ALLOWLIST.has(key) || UNTRANSLATED_ALLOWLIST.has(`${code}:${key}`)) continue;
    if (isConstantLike(value)) continue;
    untranslatedWarnings.push([code, key, value]);
  }
}

if (untranslatedWarnings.length > 0) {
  const byLocale = new Map();
  for (const [code, key] of untranslatedWarnings) {
    if (!byLocale.has(code)) byLocale.set(code, []);
    byLocale.get(code).push(key);
  }
  const perKeyCount = new Map();
  for (const [, key] of untranslatedWarnings) perKeyCount.set(key, (perKeyCount.get(key) ?? 0) + 1);
  const topKeys = [...perKeyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const sortedLocales = [...byLocale.entries()].sort((a, b) => b[1].length - a[1].length);
  console.warn(`\n[i18n:check] WARN — ${untranslatedWarnings.length} values still identical to en.json (report-only; not a failure).`);
  console.warn('  Most common keys (locales affected):');
  for (const [key, n] of topKeys) console.warn(`    ${String(n).padStart(2)}x  ${key}`);
  console.warn('  Per locale (sample):');
  for (const [code, keys] of sortedLocales) {
    console.warn(`    ${code}: ${keys.length} key(s) — ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`);
  }
  console.warn('  Check whether these are genuine gaps (translate them) or constants (add to UNTRANSLATED_ALLOWLIST).');
}

// --- Check 5 (report-only): stale logo-background wording ---
// The logo-background feature reworded two English strings. Guard against
// future diffs that re-add English keys or re-translate the old semantics:
//   - settings.livetv.logos.perSourceOverridesSub must mention the BACKGROUND
//     dimension (the OLD wording only mentioned icon SHAPE).
//   - epg.logoBgHint must use the Default/Light/Dark semantics, not the OLD
//     "pick background if automatic detection gets it wrong" wording.
const staleBgWarnings = []; // [locale, key, sample]
const OLD_SHAPE_ONLY = /(shape|forma|forme|Symbolform|vorm|форму|şekil|شكل|hình|आकृति|shape)/;
const OLD_AUTO_HINT = /(if\s+automatic|si\s+la\s+d\u00e9tection|automatische|otomat|t\u1ef1 \u0111\u1ed9ng \u0111\u1ecbnh|t\u1ef1 \u0111\u1ed9ng|\u0430\u0432\u0442\u043e\u043c\u0430\u0442|auto\s+detect|detection\s+gets|\u0627\u0644\u062a\u0644\u0642\u0627\u0626\u064a|aut\u00f3m\u00e1tico|\u0434\u0435\u0442\u0435\u043a\u0442)/;
// Background words per major script, to confirm the "and background" clause
// is present (if detected as shape-only, we flag regardless).
for (const code of fileCodes) {
  if (code === 'en') continue;
  const localeObj = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
  const ov = localeObj.settings?.livetv?.logos?.perSourceOverridesSub;
  const hint = localeObj.epg?.logoBgHint;
  if (typeof ov === 'string') {
    // Old wording named only the SHAPE; new wording also names the background.
    // Heuristic: if it reads as shape-only (no background dimension spelled out) flag it.
    // Background-word coverage per script: el → παρασκήνιο*, fa → پس‌زمینه (ZWNJ),
    // ur → بیک گراؤنڈ (English loanword, regular space), hu → hátter*/háttér,
    // de → Hintergrund, nl → achtergrond, sq → sfond*, sr/bs/hr → позадин*/pozadin*,
    // uk/ru → фон, pl → tło, tr → arka, vi → nền, zh → 背景, hi → पृष्ठभूमि.
    const mentionsBackground = /background|achtergrond|fond|hintergrund|fundo|sfondo|фон|позадин|παρασκην|زمینه|خلف|بیک گراؤنڈ|पृष्ठभूमि|hátter|háttér|tło|tłem|arka|nền|背景|pozadinu|pozadini|sfond|позад|hinter|fondo/i.test(ov);
    if (!mentionsBackground) {
      staleBgWarnings.push([code, 'settings.livetv.logos.perSourceOverridesSub', ov]);
    }
  }
  if (typeof hint === 'string' && OLD_AUTO_HINT.test(hint)) {
    staleBgWarnings.push([code, 'epg.logoBgHint', hint]);
  }
}

if (staleBgWarnings.length > 0) {
  console.warn(`\n[i18n:check] WARN — ${staleBgWarnings.length} logo-background strings may use stale wording (report-only; not a failure).`);
  for (const [code, key, sample] of staleBgWarnings) {
    console.warn(`    ${code}: ${key} → ${JSON.stringify(sample.slice(0, 110))}`);
  }
  console.warn('  Expected: perSourceOverridesSub mentions icon BACKGROUND (not shape only);');
  console.warn('            logoBgHint uses the Default/Light/Dark semantics (not old auto-detection wording).');
}

// --- Report ---
if (errors.length > 0) {
  console.error('[i18n:check] Locale errors:');
  for (const e of errors) console.error('  - ' + e);
  console.error('\nFix: keep all locale files structurally identical to en.json.');
  process.exit(1);
}

console.log('[i18n:check] OK —', fileCodes.length, 'locales registered:', fileCodes.join(', '));