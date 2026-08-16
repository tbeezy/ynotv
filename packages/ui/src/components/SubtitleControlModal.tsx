import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { translateNativeError } from '../i18n';
import { Bridge } from '../services/tauri-bridge';
import {
  searchSubSourceMovies,
  searchSubSourceSubtitles,
  downloadSubSourceSubtitle,
  downloadSubSourceZip,
  getZipEntries,
  decompressZipEntry,
  toSubSourceLang,
  fromSubSourceLang,
  toSubSourceImdb,
  type SubSourceMovie,
  type SubSourceSubtitle,
  type ZipEntry,
} from '../services/subsource';
import {
  searchOpenSubtitles,
  downloadOpenSubtitlesSubtitle,
  ensureValidOpenSubtitlesToken,
  type OpenSubtitlesSubtitle,
  type OpenSubtitlesSearchResult,
} from '../services/opensubtitles';
import { useToastStore } from '../stores/toastStore';
import { useSubtitleDebugStore } from '../stores/subtitleDebugStore';
import { useSettingsStore } from '../stores/settingsStore';
import { SubtitleDiagnosticsModal } from './SubtitleDiagnosticsModal';
import { cleanTitleForSearch } from '../utils/cleanTitle';
import { db } from '../db';
import { fetchVodProviderTmdbId } from '../db/sync';
import './SubtitleControlModal.css';

interface Track {
  id: number;
  type: 'audio' | 'sub';
  title?: string;
  lang?: string;
  codec?: string;
  default: boolean;
  selected: boolean;
  external?: boolean;
  'external-filename'?: string;
}

interface SubtitleControlModalProps {
  isOpen: boolean;
  onClose: () => void;
  vodTitle?: string;
  vodYear?: string;
  seasonNum?: number;
  episodeNum?: number;
  tmdbId?: number | string;
  imdbId?: string;
  vodSourceId?: string;
  vodMediaId?: string;
}

type ViewState = 'tracks' | 'movies' | 'subtitles' | 'zip-files';

/** Try to extract an episode number (1-99) from releaseInfo strings like ["S01E04","WEB-DL"]. */
function extractEpisodeFromReleaseInfo(releaseInfo: string[]): number | null {
  for (const info of releaseInfo) {
    const m = info.match(/[Ss]\d{1,2}[Ee](\d{1,2})/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Pick the best matching SubSource movie from search results.
 * Preference: exact TMDb/IMDb id match → matching season (series) → first result.
 */
function pickSubSourceTarget(
  movies: SubSourceMovie[],
  season: number | undefined,
  tmdbId?: number | string,
  imdbId?: string | number
): SubSourceMovie | null {
  if (!movies || movies.length === 0) return null;

  const targetTmdb = tmdbId === undefined || tmdbId === null ? undefined : String(tmdbId);
  const targetImdb = toSubSourceImdb(imdbId);

  // 1. Exact id match against the result's tmdbId/imdbId
  const idMatch = movies.find((m) => {
    if (targetTmdb && m.tmdbId !== undefined && m.tmdbId !== null && String(m.tmdbId) === targetTmdb) {
      return true;
    }
    if (targetImdb && toSubSourceImdb(m.imdbId) === targetImdb) {
      return true;
    }
    return false;
  });
  if (idMatch) return idMatch;

  // 2. Series + exact season
  if (season !== undefined && season > 0) {
    const seasonMatch = movies.find((m) => m.type === 'tvseries' && m.season === season);
    if (seasonMatch) return seasonMatch;
  }

  // 3. First result
  return movies[0];
}

/* Module-level cache so auto-search results persist across modal open/close */
interface SearchCache {
  query: string;
  year?: string;
  lang: string;
  movies: SubSourceMovie[];
  selectedMovie: SubSourceMovie | null;
  subtitles: SubSourceSubtitle[];
  viewState: ViewState;
  timestamp: number;
}
let searchCache: SearchCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const LANG_LABELS: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', nl: 'Dutch', pl: 'Polish', tr: 'Turkish',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech',
  el: 'Greek', he: 'Hebrew', id: 'Indonesian', ms: 'Malay', th: 'Thai',
  vi: 'Vietnamese', ro: 'Romanian', hu: 'Hungarian', bg: 'Bulgarian',
  uk: 'Ukrainian', sr: 'Serbian', hr: 'Croatian', sk: 'Slovak', sl: 'Slovenian',
  lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', ca: 'Catalan', tl: 'Tagalog',
  fa: 'Persian', ur: 'Urdu', bn: 'Bengali', ta: 'Tamil', te: 'Telugu',
  mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam',
  si: 'Sinhala', ne: 'Nepali', my: 'Burmese', km: 'Khmer', lo: 'Lao',
  am: 'Amharic', sw: 'Swahili', zu: 'Zulu', af: 'Afrikaans', sq: 'Albanian',
  hy: 'Armenian', ka: 'Georgian', az: 'Azerbaijani', uz: 'Uzbek', kk: 'Kazakh',
  ky: 'Kyrgyz', mn: 'Mongolian', la: 'Latin', cy: 'Welsh',
  ga: 'Irish', eu: 'Basque', gl: 'Galician', is: 'Icelandic', mt: 'Maltese',
};

function normalizeLangCode(code?: string): string {
  if (!code) return '';
  return fromSubSourceLang(toSubSourceLang(code));
}

function getTrackLanguage(track: Track): string {
  if (track.external && track['external-filename']) {
    const parts = track['external-filename'].split(/[/\\]/);
    const base = parts[parts.length - 1];
    if (base.startsWith('stremio__')) {
      const subParts = base.split('__');
      if (subParts.length >= 5) {
        return normalizeLangCode(subParts[4]);
      }
    } else if (base.startsWith('subsource__') || base.startsWith('opensubtitles__')) {
      const subParts = base.split('__');
      if (subParts.length >= 3) {
        return normalizeLangCode(subParts[2]);
      }
    }
  }
  return normalizeLangCode(track.lang);
}

function parseExternalTrack(filePath: string): { label: string; origin: string } {
  const parts = filePath.split(/[/\\]/);
  const base = parts[parts.length - 1];
  
  if (base.startsWith('stremio__')) {
    const subParts = base.split('__');
    if (subParts.length >= 5) {
      const addon = subParts[1].replace(/_/g, ' ');
      const label = subParts[2].replace(/_/g, ' ');
      return { label, origin: addon };
    }
    return { label: 'Stremio Subtitle', origin: 'Stremio Addon' };
  }
  
  if (base.startsWith('subsource__')) {
    const subParts = base.split('__');
    if (subParts.length >= 4) {
      const releaseInfo = subParts[1].replace(/_/g, ' ');
      return { label: releaseInfo, origin: 'SubSource' };
    }
    return { label: 'Downloaded Subtitle', origin: 'SubSource' };
  }

  if (base.startsWith('opensubtitles__')) {
    const subParts = base.split('__');
    if (subParts.length >= 4) {
      const releaseInfo = subParts[1].replace(/_/g, ' ');
      return { label: releaseInfo, origin: 'OpenSubtitles' };
    }
    return { label: 'Downloaded Subtitle', origin: 'OpenSubtitles' };
  }
  
  // Fallback for legacy format
  if (base.includes('_')) {
    const subParts = base.split('_');
    if (subParts.length >= 3) {
      const label = subParts.slice(0, subParts.length - 2).join(' ').replace(/_/g, ' ');
      return { label, origin: 'Downloaded Sub' };
    }
  }

  const nameOnly = base.replace(/\.[^/.]+$/, '');
  return { label: nameOnly.replace(/_/g, ' '), origin: 'Local File' };
}


export function SubtitleControlModal({
  isOpen,
  onClose,
  vodTitle,
  vodYear,
  seasonNum,
  episodeNum,
  tmdbId,
  imdbId,
  vodSourceId,
  vodMediaId,
}: SubtitleControlModalProps) {
  const { t } = useTranslation('subtitles');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Controls
  const [delay, setDelay] = useState(0);
  const [size, setSize] = useState(35);
  const [verticalOffset, setVerticalOffset] = useState(100);
  const [subBackgroundEnabled, setSubBackgroundEnabled] = useState(false);
  const [subBackgroundColor, setSubBackgroundColor] = useState('#000000');
  const [subBackgroundOpacity, setSubBackgroundOpacity] = useState(80);

  // Provider flow state
  const [provider, setProvider] = useState<'subsource' | 'opensubtitles'>('subsource');
  const [openSubtitlesToken, setOpenSubtitlesToken] = useState('');
  const [openSubtitlesUser, setOpenSubtitlesUser] = useState<any>(null);

  // SubSource flow state
  const [apiKey, setApiKey] = useState('');
  const [searchLang, setSearchLang] = useState('en');
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // View state & results
  const [viewState, setViewState] = useState<ViewState>('tracks');
  const [movies, setMovies] = useState<SubSourceMovie[]>([]);
  const [selectedMovie, setSelectedMovie] = useState<SubSourceMovie | null>(null);
  const [subtitles, setSubtitles] = useState<SubSourceSubtitle[]>([]);
  const [openSubtitlesSubtitles, setOpenSubtitlesSubtitles] = useState<OpenSubtitlesSubtitle[]>([]);
  const [downloadingSubId, setDownloadingSubId] = useState<number | null>(null);
  const [downloadingOsId, setDownloadingOsId] = useState<string | null>(null);
  const [zipEntries, setZipEntries] = useState<ZipEntry[]>([]);
  const [pendingZipData, setPendingZipData] = useState<Uint8Array | null>(null);
  const [activeSubSourceSubtitle, setActiveSubSourceSubtitle] = useState<SubSourceSubtitle | null>(null);

  // Episode filter
  const [episodeFilter, setEpisodeFilter] = useState<number | null>(null);
  const [availableEpisodes, setAvailableEpisodes] = useState<number[]>([]);

  // Diagnostics
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const logSub = useSubtitleDebugStore((s) => s.logSub);

  const debugLogSubTracks = async (tag: string) => {
    const trackList = await Bridge.getTrackList().catch(() => []);
    const subs = (trackList as any[]).filter((t) => t.type === 'sub');
    const lines = subs.map((t) => {
      const sel = t.selected ? 'SELECTED' : 'not-selected';
      const kind = t.external ? 'EXT' : 'EMB';
      const file = t['external-filename'] || '(embedded)';
      return `  #${t.id} [${sel}][${kind}] codec=${t.codec || '?'} lang=${t.lang || t.title || '?'} file=${file}`;
    });
    logSub('tracks', `${tag} -> ${subs.length} sub track(s)\n${lines.join('\n')}`);
  };

  const debugLogSubState = async (tag: string) => {
    const sid = await Bridge.getProperty('sid').catch(() => 'ERR');
    const vis = await Bridge.getProperty('sub-visibility').catch(() => 'ERR');
    const enabled = await Bridge.getProperty('sub-enabled').catch(() => 'ERR');
    logSub('state', `${tag}: sid=${JSON.stringify(sid)} sub-visibility=${JSON.stringify(vis)} sub-enabled=${JSON.stringify(enabled)}`);
  };

  const loadedRef = useRef(false);
  const autoSearchRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      loadTracks();
      loadSettings().then(({ key, osToken, prefProvider, defaultLanguage }) => {
        if (!autoSearchRef.current && vodTitle && defaultLanguage !== 'off') {
          autoSearchRef.current = true;
          const targetProvider = (prefProvider === 'opensubtitles' && osToken) ? 'opensubtitles' : 'subsource';
          if (targetProvider === 'opensubtitles' && osToken) {
            doOpenSubtitlesSearch(vodTitle, vodYear, seasonNum, episodeNum, defaultLanguage, osToken);
          } else if (key) {
            const cacheKey = `${vodTitle}|${vodYear || ''}|${seasonNum || ''}|${defaultLanguage}`;
            if (
              searchCache &&
              searchCache.query === cacheKey &&
              Date.now() - searchCache.timestamp < CACHE_TTL_MS
            ) {
              setMovies(searchCache.movies);
              setSelectedMovie(searchCache.selectedMovie);
              setSubtitles(searchCache.subtitles);
              setViewState(searchCache.viewState);
            } else {
              doAutoSearch(vodTitle, vodYear, seasonNum, key, defaultLanguage);
            }
          }
        }
      });
    }
  }, [isOpen]);

  // Reset auto-search flag when title/season changes
  useEffect(() => {
    autoSearchRef.current = false;
  }, [vodTitle, vodYear, seasonNum]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const loadSettings = async (): Promise<{ key: string; osToken: string; prefProvider: string; defaultLanguage: string }> => {
    try {
      const settings: any = { subtitleSettings: useSettingsStore.getState().subtitleSettings };
      let key = '';
      let osToken = '';
      let prefProvider = 'subsource';
      let defaultLanguage = 'en';
      if (settings.subtitleSettings) {
        const ss = settings.subtitleSettings;
        key = ss.subsourceApiKey || '';
        prefProvider = ss.preferredProvider || 'subsource';
        setApiKey(key);

        const validOs = await ensureValidOpenSubtitlesToken(ss);
        osToken = validOs.token;
        setOpenSubtitlesToken(osToken);
        setOpenSubtitlesUser(validOs.user || ss.openSubtitlesUser || null);

        if (prefProvider === 'opensubtitles' && osToken) {
          setProvider('opensubtitles');
        } else {
          setProvider('subsource');
        }
        defaultLanguage = ss.defaultLanguage || 'en';
        setSearchLang(defaultLanguage);
        setSize(ss.defaultSize || 35);
        setSubBackgroundEnabled(ss.subBackgroundEnabled ?? false);
        setSubBackgroundColor(ss.subBackgroundColor || '#000000');
        setSubBackgroundOpacity(ss.subBackgroundOpacity ?? 80);
        if (!loadedRef.current) {
          setVerticalOffset(ss.subVerticalOffset !== undefined ? ss.subVerticalOffset : 90);
          setDelay(ss.subDelay || 0);
        }
      }
      if (vodTitle) {
        const clean = cleanTitleForSearch(vodTitle);
        setSearchQuery(clean + (vodYear ? ` ${vodYear}` : ''));
      }
      loadedRef.current = true;
      return { key, osToken, prefProvider, defaultLanguage };
    } catch (e) {
      console.error('Failed to load subtitle settings:', e);
      return { key: '', osToken: '', prefProvider: 'subsource', defaultLanguage: 'en' };
    }
  };

  // Resolve TMDb/IMDb ids for subtitle matching. Prefers ids already passed in
  // from the playback session, then falls back to the cached DB record, then to
  // the provider's get_vod_info tmdb_id (exact match).
  const resolveVodIds = useCallback(async (): Promise<{ tmdbId?: number; imdbId?: string }> => {
    const out: { tmdbId?: number; imdbId?: string } = {};

    if (tmdbId !== undefined && tmdbId !== null && tmdbId !== '') {
      const n = parseInt(String(tmdbId).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n) && n > 0) out.tmdbId = n;
    }
    if (imdbId) out.imdbId = String(imdbId).trim().replace(/^tt/, '');
    if (out.tmdbId || out.imdbId) return out;

    // Playback session didn't carry ids - look them up. Only handles movies
    // (mediaId is the vodMovies primary key). Episodes would need series-level lookup.
    if (vodMediaId && vodSourceId && !vodMediaId.includes('_ep_')) {
      try {
        const movie = await db.vodMovies.get(vodMediaId);
        if (movie?.tmdb_id) out.tmdbId = movie.tmdb_id;
        if (movie?.imdb_id) out.imdbId = String(movie.imdb_id).trim().replace(/^tt/, '');
        if (!out.tmdbId) {
          const sourcesResult = await window.storage?.getSources();
          const source = sourcesResult?.data?.find((s) => String(s.id) === String(vodSourceId));
          if (source) {
            const providerTmdb = await fetchVodProviderTmdbId(source, vodMediaId);
            if (providerTmdb) out.tmdbId = providerTmdb;
          }
        }
      } catch (e) {
        console.warn('[SubtitleModal] Failed to resolve vod ids:', e);
      }
    }

    return out;
  }, [tmdbId, imdbId, vodMediaId, vodSourceId]);

  const doAutoSearch = async (
    title: string,
    year?: string,
    season?: number,
    providedKey?: string,
    langCode?: string
  ) => {
    const key = providedKey || apiKey;
    if (!key || !title.trim()) return;

    const targetLang = langCode || searchLang;
    if (targetLang === 'off') {
      console.log('[SubtitleModal] Subtitle language is off. Skipping auto-search.');
      return;
    }

    const cleanTitle = cleanTitleForSearch(title);
    const cleanYearStr = year ? String(year).replace(/[^0-9]/g, '') : undefined;
    const resolved = await resolveVodIds();
    const imdb = resolved.imdbId ? String(resolved.imdbId) : undefined;
    console.log('[SubtitleModal] Auto-searching SubSource:', { original: title, clean: cleanTitle, year: cleanYearStr, season, lang: targetLang, imdb, tmdb: resolved.tmdbId });
    setSearching(true);
    setSearchError('');
    setEpisodeFilter(null);
    setAvailableEpisodes([]);

    try {
      // 1. Prefer an exact IMDb lookup when we have an id (most reliable match)
      let result = await searchSubSourceMovies(key, cleanTitle, cleanYearStr, 'all', season, imdb);

      // 2. If the IMDb lookup returned nothing, fall back to a clean-title text search
      if ((!result.success || !result.movies || result.movies.length === 0) && imdb) {
        console.log('[SubtitleModal] IMDb search empty, falling back to text search');
        result = await searchSubSourceMovies(key, cleanTitle, cleanYearStr, 'all', season);
      }

      console.log('[SubtitleModal] Auto-search result:', result);

      if (!result.success) {
        setSearchError(translateNativeError(result.error) || t('autoSearchFailed'));
        return;
      }

      if (!result.movies || result.movies.length === 0) {
        setSearchError(t('noMoviesAutoSearch'));
        return;
      }

      setMovies(result.movies);

      // Pick the best match: exact TMDb/IMDb id → matching season → first result
      const targetMovie = pickSubSourceTarget(result.movies, season, resolved.tmdbId, resolved.imdbId);
      console.log('[SubtitleModal] Selected target movie:', targetMovie?.title, targetMovie?.movieId);

      if (!targetMovie) {
        setSearchError(t('noSuitableMatch'));
        return;
      }

      setSelectedMovie(targetMovie);
      const subResult = await searchSubSourceSubtitles(key, targetMovie.movieId, targetLang);

      if (subResult.success && subResult.subtitles && subResult.subtitles.length > 0) {
        setSubtitles(subResult.subtitles);

        // Extract available episode numbers from releaseInfo
        const eps = new Set<number>();
        subResult.subtitles.forEach((sub) => {
          const ep = extractEpisodeFromReleaseInfo(sub.releaseInfo);
          if (ep !== null) eps.add(ep);
        });
        const sortedEps = Array.from(eps).sort((a, b) => a - b);
        setAvailableEpisodes(sortedEps);

        // If we know the current episode, auto-filter to it
        if (episodeNum !== undefined && episodeNum > 0 && sortedEps.includes(episodeNum)) {
          setEpisodeFilter(episodeNum);
        }

        setViewState('subtitles');
        searchCache = {
          query: `${cleanTitle}|${year || ''}|${season || ''}|${targetLang}`,
          year,
          lang: targetLang,
          movies: result.movies,
          selectedMovie: targetMovie,
          subtitles: subResult.subtitles,
          viewState: 'subtitles',
          timestamp: Date.now(),
        };
      } else {
        // No subtitles for target movie, show movie list so user can pick another
        setViewState('movies');
        searchCache = {
          query: `${cleanTitle}|${year || ''}|${season || ''}|${targetLang}`,
          year,
          lang: targetLang,
          movies: result.movies,
          selectedMovie: null,
          subtitles: [],
          viewState: 'movies',
          timestamp: Date.now(),
        };
      }
    } catch (e: any) {
      console.error('[SubtitleModal] Auto-search exception:', e);
      setSearchError(translateNativeError(e?.message) || t('autoSearchFailed'));
    } finally {
      setSearching(false);
    }
  };

  const loadTracks = async () => {
    setLoading(true);
    try {
      const trackList = await Bridge.getTrackList();
      const filteredTracks = trackList
        .filter((t: any) => t.type === 'sub')
        .map((t: any) => ({
          id: t.id,
          type: t.type,
          title: t.title,
          lang: t.lang,
          codec: t.codec,
          default: t.default || false,
          selected: t.selected || false,
          external: t.external || false,
          'external-filename': t['external-filename'] || '',
        }));
      setTracks(filteredTracks);

      const current = filteredTracks.find((t: Track) => t.selected);
      if (current) {
        setSelectedId(current.id);
        const norm = getTrackLanguage(current);
        if (norm) {
          setSearchLang(norm);
        } else {
          setSearchLang('off');
        }
      } else {
        setSelectedId(0);
        setSearchLang('off');
      }
    } catch (e) {
      console.error('Failed to load subtitle tracks:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async (trackId: number) => {
    logSub('select', `selecting track #${trackId}`);
    try {
      await Bridge.setSubtitleTrack(trackId);
      setSelectedId(trackId);
      await debugLogSubTracks(`after setSubtitleTrack(${trackId})`);
      await debugLogSubState('after select');
    } catch (e) {
      console.error('Failed to set subtitle track:', e);
      logSub('select', `ERROR setting track #${trackId}: ${e}`);
    }
  };

  const handleDisable = async () => {
    logSub('select', 'disabling subtitles (sid=0)');
    try {
      await Bridge.setSubtitleTrack(0);
      setSelectedId(0);
      await debugLogSubState('after disable');
    } catch (e) {
      console.error('Failed to disable subtitles:', e);
    }
  };

  /**
   * Add an external subtitle file to mpv and then EXPLICITLY select the
   * newly-added track. We can't rely on mpv honoring the sub-add "select"
   * flag (it sometimes just registers the track without activating it), so
   * we poll track-list until the external track appears and then enable it.
   */
  const addExternalSubtitleFile = async (filePath: string) => {
    logSub('load', `sub-add file: ${filePath}`);
    await Bridge.addSubtitleFile(filePath);

    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const needle = normPath(filePath);
    logSub('load', `needle (normalized path): ${needle}`);

    let found: any = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const trackList = await Bridge.getTrackList().catch(() => []);
      const subTracks = (trackList as any[]).filter(
        (t: any) => t.type === 'sub' && t.external
      );
      const extTrack = subTracks.find(
        (t: any) =>
          t['external-filename'] &&
          normPath(String(t['external-filename'])) === needle
      );
      if (attempt === 0 || attempt === 9 || extTrack) {
        logSub(
          'load',
          `poll #${attempt + 1}: ${subTracks.length} external sub track(s): ` +
            (subTracks.length
              ? subTracks.map((t) => `#${t.id} file=${t['external-filename']}`).join(' | ')
              : '(none)')
        );
      }
      if (extTrack) {
        found = extTrack;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (found) {
      logSub('load', `match found -> track #${found.id}, selecting via setSubtitleTrack`);
      await Bridge.setSubtitleTrack(found.id).catch((e) => logSub('load', `ERROR setSubtitleTrack(${found.id}): ${e}`));
      await debugLogSubTracks('after external track selection');
      await debugLogSubState('after external selection');
    } else {
      logSub('load', 'NO matching external track found in 10 polls — track added but not selected');
    }
    await loadTracks();
  };

  const handleDelayChange = useCallback(async (value: number) => {
    setDelay(value);
    try { await Bridge.setSubtitleDelay(value); } catch (e) { console.error(e); }
  }, []);

  const handleSizeChange = useCallback(async (value: number) => {
    setSize(value);
    try {
      await Bridge.setSubtitleSize(value);
      useSettingsStore.getState().setSubtitleSettings({ defaultSize: value });
    } catch (e) { console.error(e); }
  }, []);

  const handleVerticalOffsetChange = useCallback(async (value: number) => {
    setVerticalOffset(value);
    try {
      await Bridge.setSubtitlePos(value);
      useSettingsStore.getState().setSubtitleSettings({ subVerticalOffset: value });
    } catch (e) { console.error(e); }
  }, []);

  const applyBackgroundSettings = useCallback(async (enabled: boolean, color: string, opacity: number) => {
    try {
      if (enabled) {
        await Bridge.setSubtitleBackColor(color, opacity);
        await Bridge.setSubtitleBorderStyle('background-box');
      } else {
        await Bridge.setSubtitleBackColor(color, 0);
        await Bridge.setSubtitleBorderStyle('outline-and-shadow');
      }
    } catch (e) { console.error('[SubtitleModal] applyBackgroundSettings error:', e); }
  }, []);

  const handleBackgroundToggle = useCallback(async (enabled: boolean) => {
    setSubBackgroundEnabled(enabled);
    await applyBackgroundSettings(enabled, subBackgroundColor, subBackgroundOpacity);

    // Persist setting
    try {
      useSettingsStore.getState().setSubtitleSettings({ subBackgroundEnabled: enabled });
    } catch (e) {
      console.error('Failed to save subBackgroundEnabled:', e);
    }
  }, [subBackgroundColor, subBackgroundOpacity, applyBackgroundSettings]);

  const handleBackgroundOpacityChange = useCallback(async (opacity: number) => {
    setSubBackgroundOpacity(opacity);
    if (subBackgroundEnabled) {
      await applyBackgroundSettings(true, subBackgroundColor, opacity);
    }
    
    // Persist setting
    try {
      useSettingsStore.getState().setSubtitleSettings({ subBackgroundOpacity: opacity });
    } catch (e) {
      console.error('Failed to save subBackgroundOpacity:', e);
    }
  }, [subBackgroundColor, subBackgroundEnabled, applyBackgroundSettings]);

  /* -------------------------------------------------------------- */
  /*  OpenSubtitles search & download                                 */
  /* -------------------------------------------------------------- */

  const doOpenSubtitlesSearch = async (
    title: string,
    year?: string,
    season?: number,
    episode?: number,
    langCode?: string,
    providedToken?: string
  ) => {
    let token = providedToken || openSubtitlesToken;
    if (!token) {
      const ss = useSettingsStore.getState().subtitleSettings;
      const valid = await ensureValidOpenSubtitlesToken(ss);
      if (valid.token) {
        token = valid.token;
        setOpenSubtitlesToken(token);
        setOpenSubtitlesUser(valid.user);
      }
    }

    if (!token) {
      setSearchError(t('loginRequiredSearch'));
      return;
    }

    const targetLang = langCode || searchLang;
    if (targetLang === 'off') return;

    // Extract year from title if not explicitly provided (e.g. "Mortal Kombat II (2026)")
    let extractedYearStr = year ? String(year).replace(/[^0-9]/g, '') : '';
    if (!extractedYearStr && title) {
      const yearMatch = title.match(/[\(\[\{]?\b(19\d{2}|20\d{2})\b[\)\]\}]?/);
      if (yearMatch) {
        extractedYearStr = yearMatch[1];
      }
    }
    const parsedYear = extractedYearStr ? parseInt(extractedYearStr, 10) : undefined;
    const finalYear = (parsedYear && !isNaN(parsedYear)) ? parsedYear : undefined;

    const cleanTitle = cleanTitleForSearch(title);

    const resolved = await resolveVodIds();

    const rawImdb = resolved.imdbId ? String(resolved.imdbId).trim().replace(/^tt/, '') : undefined;
    const rawTmdb = resolved.tmdbId ? parseInt(String(resolved.tmdbId).replace(/[^0-9]/g, ''), 10) : undefined;
    const validTmdb = (rawTmdb && !isNaN(rawTmdb) && rawTmdb > 0) ? rawTmdb : undefined;
    const mediaType = (season && season > 0) || (episode && episode > 0) ? 'episode' : 'movie';

    console.log('[SubtitleModal] Searching OpenSubtitles:', {
      cleanTitle,
      year: finalYear,
      season,
      episode,
      type: mediaType,
      lang: targetLang,
      imdbId: rawImdb,
      tmdbId: validTmdb,
    });
    setSearching(true);
    setSearchError('');
    setEpisodeFilter(null);
    setAvailableEpisodes([]);
    setOpenSubtitlesSubtitles([]);

    try {
      let res: OpenSubtitlesSearchResult | null = null;

      // 1. If IMDb ID or TMDb ID is available, search by ID first (without text query) for exact matching
      if (rawImdb || validTmdb) {
        res = await searchOpenSubtitles(token, {
          seasonNumber: season,
          episodeNumber: episode,
          type: mediaType,
          languages: targetLang,
          imdbId: rawImdb,
          tmdbId: validTmdb,
        });
      }

      // 2. If ID search produced no subtitles (or no ID was available), fall back to clean title text search
      if (!res || !res.success || !res.subtitles || res.subtitles.length === 0) {
        if (cleanTitle) {
          res = await searchOpenSubtitles(token, {
            query: cleanTitle,
            seasonNumber: season,
            episodeNumber: episode,
            type: mediaType,
            languages: targetLang,
            year: finalYear,
          });
        }
      }

      if (!res || !res.success) {
        const msg = translateNativeError(res?.error) || t('openSubtitlesSearchFailed');
        setSearchError(msg);
        useToastStore.getState().addToast(msg, 'error');
        return;
      }

      if (!res.subtitles || res.subtitles.length === 0) {
        const msg = t('noOpenSubtitlesFound', { title: cleanTitle });
        setSearchError(msg);
        return;
      }

      setOpenSubtitlesSubtitles(res.subtitles);

      // Extract available episodes if present
      const eps = new Set<number>();
      res.subtitles.forEach((sub) => {
        if (sub.episodeNumber && sub.episodeNumber > 0) {
          eps.add(sub.episodeNumber);
        } else {
          const ep = extractEpisodeFromReleaseInfo([sub.release, sub.fileName]);
          if (ep !== null) eps.add(ep);
        }
      });
      const sortedEps = Array.from(eps).sort((a, b) => a - b);
      setAvailableEpisodes(sortedEps);

      if (episodeNum !== undefined && episodeNum > 0 && sortedEps.includes(episodeNum)) {
        setEpisodeFilter(episodeNum);
      }

      setViewState('subtitles');
    } catch (e: any) {
      console.error('[SubtitleModal] OpenSubtitles search error:', e);
      const msg = translateNativeError(e?.message) || t('openSubtitlesSearchFailed');
      setSearchError(msg);
      useToastStore.getState().addToast(msg, 'error');
    } finally {
      setSearching(false);
    }
  };

  const handleDownloadOpenSubtitles = async (sub: OpenSubtitlesSubtitle) => {
    if (!openSubtitlesToken) {
      const msg = t('loginRequired');
      setSearchError(msg);
      useToastStore.getState().addToast(msg, 'error');
      return;
    }
    setDownloadingOsId(sub.id);
    setSearchError('');

    try {
      const res = await downloadOpenSubtitlesSubtitle(openSubtitlesToken, sub.fileId);
      if (!res.success || !res.content) {
        const msg = translateNativeError(res.error) || t('downloadSubtitleFailed');
        setSearchError(msg);
        useToastStore.getState().addToast(msg, 'error');
        return;
      }

      const { writeTextFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs');
      const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
      const appDir = await appLocalDataDir();

      const sanitizePart = (val?: string) => {
        if (!val) return 'unknown';
        return val.replace(/__/g, '_').replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      };

      const cleanRelease = sanitizePart(sub.release || sub.fileName).slice(0, 40);
      const cleanLang = sanitizePart(sub.language).slice(0, 10);
      const ext = (res.fileName || sub.fileName || '').toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';

      const relPath = `subtitles/opensubtitles__${cleanRelease}__${cleanLang}__${sub.fileId}.${ext}`;
      const filePath = await join(appDir, relPath);

      await mkdir('subtitles', { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
      await writeTextFile(relPath, res.content, { baseDir: BaseDirectory.AppLocalData });
      console.log('[SubtitleModal] Saved OpenSubtitles file to:', filePath);
      logSub('os-download', `saved: ${filePath} (${(res.content?.length || 0)} chars)`);

      await addExternalSubtitleFile(filePath);
      setViewState('tracks');
    } catch (e: any) {
      console.error('[SubtitleModal] OpenSubtitles download exception:', e);
      const msg = translateNativeError(e?.message) || t('downloadFailed');
      setSearchError(msg);
      useToastStore.getState().addToast(msg, 'error');
    } finally {
      setDownloadingOsId(null);
    }
  };

  const handleProviderChange = async (newProvider: 'subsource' | 'opensubtitles') => {
    setProvider(newProvider);
    setSearchError('');
    setViewState('tracks');

    // Save preferred provider to settings
    try {
      useSettingsStore.getState().setSubtitleSettings({ preferredProvider: newProvider });
    } catch (e) {
      console.error('Failed to save preferred provider setting:', e);
    }

    if (searchQuery.trim()) {
      if (newProvider === 'opensubtitles' && openSubtitlesToken) {
        doOpenSubtitlesSearch(searchQuery, vodYear, seasonNum, episodeNum, searchLang);
      } else if (newProvider === 'subsource' && apiKey) {
        await doAutoSearch(searchQuery, vodYear, seasonNum, undefined, searchLang);
      }
    }
  };

  /* -------------------------------------------------------------- */
  /*  SubSource movie search (manual)                                 */
  /* -------------------------------------------------------------- */

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    if (provider === 'opensubtitles') {
      await doOpenSubtitlesSearch(searchQuery, vodYear, seasonNum, episodeNum, searchLang);
      return;
    }

    if (!apiKey) {
      setSearchError(t('configureApiKey'));
      return;
    }

    setSearching(true);
    setSearchError('');
    setMovies([]);
    setSubtitles([]);
    setSelectedMovie(null);
    setEpisodeFilter(null);
    setAvailableEpisodes([]);

    console.log('[SubtitleModal] Starting movie search:', { query: searchQuery.trim(), year: vodYear, apiKey: apiKey ? '***' : 'missing' });

    try {
      const cleanQuery = cleanTitleForSearch(searchQuery.trim());
      const result = await searchSubSourceMovies(apiKey, cleanQuery, vodYear, 'all', seasonNum);
      console.log('[SubtitleModal] Movie search result:', result);

      if (!result.success) {
        setSearchError(translateNativeError(result.error) || t('searchFailed'));
        return;
      }

      if (!result.movies || result.movies.length === 0) {
        setSearchError(t('noResultsQuery'));
        return;
      }

      setMovies(result.movies);
      setViewState('movies');
      searchCache = {
        query: `${cleanQuery}|${vodYear || ''}|${seasonNum || ''}|${searchLang}`,
        year: vodYear,
        lang: searchLang,
        movies: result.movies,
        selectedMovie: null,
        subtitles: [],
        viewState: 'movies',
        timestamp: Date.now(),
      };
    } catch (e: any) {
      console.error('[SubtitleModal] Movie search exception:', e);
      setSearchError(translateNativeError(e?.message) || t('searchFailed'));
    } finally {
      setSearching(false);
    }
  };

  /* -------------------------------------------------------------- */
  /*  Select movie → fetch subtitles                                  */
  /* -------------------------------------------------------------- */

  const handleSelectMovie = async (movie: SubSourceMovie) => {
    setSelectedMovie(movie);
    setSubtitles([]);
    setSearchError('');
    setEpisodeFilter(null);
    setAvailableEpisodes([]);
    setSearching(true);

    console.log('[SubtitleModal] Fetching subtitles for movie:', { movieId: movie.movieId, title: movie.title, lang: searchLang });

    try {
      const result = await searchSubSourceSubtitles(apiKey, movie.movieId, searchLang);
      console.log('[SubtitleModal] Subtitle search result:', result);

      if (!result.success) {
        setSearchError(translateNativeError(result.error) || t('loadSubtitlesFailed'));
        setViewState('tracks');
        return;
      }

      if (!result.subtitles || result.subtitles.length === 0) {
        setSearchError(t('noLangSubtitles', { lang: LANG_LABELS[searchLang]?.toLowerCase() || searchLang, title: movie.title }));
        setViewState('tracks');
        return;
      }

      setSubtitles(result.subtitles);

      // Extract available episode numbers
      const eps = new Set<number>();
      result.subtitles.forEach((sub) => {
        const ep = extractEpisodeFromReleaseInfo(sub.releaseInfo);
        if (ep !== null) eps.add(ep);
      });
      const sortedEps = Array.from(eps).sort((a, b) => a - b);
      setAvailableEpisodes(sortedEps);

      // Auto-filter to current episode if known
      if (episodeNum !== undefined && episodeNum > 0 && sortedEps.includes(episodeNum)) {
        setEpisodeFilter(episodeNum);
      }

      setViewState('subtitles');
      if (searchCache) {
        searchCache = {
          ...searchCache,
          selectedMovie: movie,
          subtitles: result.subtitles,
          viewState: 'subtitles',
          timestamp: Date.now(),
        };
      }
    } catch (e: any) {
      console.error('[SubtitleModal] Subtitle fetch exception:', e);
      setSearchError(translateNativeError(e?.message) || t('loadSubtitlesFailed2'));
      setViewState('tracks');
    } finally {
      setSearching(false);
    }
  };

  /* -------------------------------------------------------------- */
  /*  Download subtitle                                               */
  /* -------------------------------------------------------------- */

  const extractAndLoadZipEntry = async (zipData: Uint8Array, entry: ZipEntry, sub: SubSourceSubtitle) => {
    setDownloadingSubId(sub.subtitleId);
    setSearchError('');
    try {
      const content = await decompressZipEntry(zipData, entry);
      if (!content) {
        setSearchError(t('extractZipFailed'));
        return;
      }

      // Write to disk
      const { writeTextFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs');
      const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
      const appDir = await appLocalDataDir();
      const sanitizePart = (val?: string) => {
        if (!val) return 'unknown';
        return val.replace(/__/g, '_').replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      };
      
      const releaseStr = sub.releaseInfo && sub.releaseInfo.length > 0 ? sub.releaseInfo[0] : 'subtitle';
      const cleanRelease = sanitizePart(releaseStr).slice(0, 40);
      const cleanLang = sanitizePart(sub.language).slice(0, 10);
      
      // Clean target filename within ZIP
      const entryBase = entry.fileName.split(/[/\\]/).pop() || entry.fileName;
      const cleanFile = sanitizePart(entryBase.replace(/\.(srt|vtt)$/i, '')).slice(0, 40);
      const ext = entry.fileName.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';
      
      const relPath = `subtitles/subsource__${cleanRelease}__${cleanFile}__${cleanLang}__${sub.subtitleId}.${ext}`;
      const filePath = await join(appDir, relPath);

      await mkdir('subtitles', { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
      await writeTextFile(relPath, content, { baseDir: BaseDirectory.AppLocalData });
      console.log('[SubtitleModal] Saved SRT to:', filePath);
      logSub('subsource-download', `saved: ${filePath} (${(content?.length || 0)} chars)`);

      // Load into MPV and explicitly select the track so it renders immediately
      await addExternalSubtitleFile(filePath);
      console.log('[SubtitleModal] Added subtitle to MPV');

      // Refresh tracks
      setViewState('tracks');
      
      // Reset ZIP state
      setZipEntries([]);
      setPendingZipData(null);
      setActiveSubSourceSubtitle(null);
    } catch (e: any) {
      console.error('[SubtitleModal] Extraction exception:', e);
      setSearchError(translateNativeError(e?.message) || t('extractSubtitleFailed'));
    } finally {
      setDownloadingSubId(null);
    }
  };

  const handleExtractAndLoadZipEntry = async (entry: ZipEntry) => {
    if (!pendingZipData || !activeSubSourceSubtitle) return;
    await extractAndLoadZipEntry(pendingZipData, entry, activeSubSourceSubtitle);
  };

  const handleDownloadSubtitle = async (sub: SubSourceSubtitle) => {
    setDownloadingSubId(sub.subtitleId);
    setSearchError('');

    console.log('[SubtitleModal] Downloading subtitle ZIP:', { subtitleId: sub.subtitleId, releaseInfo: sub.releaseInfo });

    try {
      const zipResult = await downloadSubSourceZip(apiKey, sub.subtitleId);
      if (!zipResult.success || !zipResult.data) {
        setSearchError(zipResult.error || t('downloadFailed'));
        return;
      }

      const zipData = zipResult.data;
      const entries = getZipEntries(zipData);

      if (entries.length === 0) {
        setSearchError(t('noSubtitleFiles'));
        return;
      }

      if (entries.length === 1) {
        // Just one file, extract it directly
        await extractAndLoadZipEntry(zipData, entries[0], sub);
      } else {
        // Multiple files, show selection list
        setZipEntries(entries);
        setPendingZipData(zipData);
        setActiveSubSourceSubtitle(sub);
        setViewState('zip-files');
      }
    } catch (e: any) {
      console.error('[SubtitleModal] Download exception:', e);
      setSearchError(translateNativeError(e?.message) || t('downloadSubtitleFailed2'));
    } finally {
      setDownloadingSubId(null);
    }
  };

  /* -------------------------------------------------------------- */
  /*  Load local subtitle file                                       */
  /* -------------------------------------------------------------- */

  const handleLoadLocalFile = async () => {
    try {
      setSearchError('');
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        directory: false,
        title: 'Select Subtitle File',
        filters: [
          {
            name: 'Subtitle Files (*.srt, *.vtt, *.sub, *.ass, *.ssa)',
            extensions: ['srt', 'vtt', 'sub', 'ass', 'ssa', 'txt'],
          },
        ],
      });

      if (selected && typeof selected === 'string') {
        console.log('[SubtitleModal] Selected local subtitle file:', selected);
        logSub('local-load', `selected: ${selected}`);
        await addExternalSubtitleFile(selected);
        setViewState('tracks');
      }
    } catch (e: any) {
      console.error('[SubtitleModal] Failed to load local subtitle file:', e);
      setSearchError(translateNativeError(e?.message) || t('openLocalFileFailed'));
    }
  };

  /* -------------------------------------------------------------- */
  /*  Remove external subtitle                                        */
  /* -------------------------------------------------------------- */

  const handleRemoveExternal = async (trackId: number) => {
    const track = tracks.find(t => t.id === trackId);
    if (track?.external && track['external-filename']) {
      try {
        await Bridge.removeSubtitleFile(track['external-filename']);
        await loadTracks();
      } catch (e) {
        console.error('Failed to remove subtitle:', e);
      }
    }
  };

  /* -------------------------------------------------------------- */
  /*  Language change                                                 */
  /* -------------------------------------------------------------- */

  const handleLangChange = (langCode: string) => {
    setSearchLang(langCode);
    setViewState('tracks');
    setMovies([]);
    setSubtitles([]);
    setSelectedMovie(null);
    setEpisodeFilter(null);
    setAvailableEpisodes([]);
    setSearchError('');
  };

  /* -------------------------------------------------------------- */
  /*  Render                                                          */
  /* -------------------------------------------------------------- */

  if (!isOpen) return null;

  const allSubTracks = tracks.filter(t => t.type === 'sub');

  // Derive available languages from actual subtitle tracks, normalized to canonical 2-letter codes
  const availableLangs = Array.from(
    new Set(allSubTracks.map(t => getTrackLanguage(t)).filter(Boolean))
  ).map(code => ({
    code: code,
    label: LANG_LABELS[code] || code.toUpperCase(),
  }));

  // Sort alphabetically
  availableLangs.sort((a, b) => a.label.localeCompare(b.label));

  // Determine active track language based on selectedId
  const activeTrack = allSubTracks.find(t => t.id === selectedId);
  const selectedTrackLang = selectedId === 0 ? 'off' : (activeTrack ? getTrackLanguage(activeTrack) : 'off');

  // Filter subtitle tracks for Column 2 based on selected language.
  // When subtitles are "off" list every loaded track. App-downloaded external
  // tracks (opensubtitles__/subsource__/stremio__) are ALWAYS shown so a
  // downloaded subtitle never disappears from the list just because the active
  // language filter (e.g. the default language) differs from its own language.
  const filteredSubTracks = searchLang === 'off'
    ? allSubTracks
    : allSubTracks.filter(track => {
        const extFile = track.external && track['external-filename']
          ? (track['external-filename'].split(/[/\\]/).pop() || '')
          : '';
        if (extFile.startsWith('opensubtitles__') || extFile.startsWith('subsource__') || extFile.startsWith('stremio__')) {
          return true;
        }
        return getTrackLanguage(track) === normalizeLangCode(searchLang);
      });

  // Filter subtitles by episode if filter is active
  const filteredSubtitles = episodeFilter !== null
    ? subtitles.filter((sub) => {
        const ep = extractEpisodeFromReleaseInfo(sub.releaseInfo);
        return ep === episodeFilter;
      })
    : subtitles;

  const filteredOsSubtitles = episodeFilter !== null
    ? openSubtitlesSubtitles.filter((sub) => {
        if (sub.episodeNumber && sub.episodeNumber > 0) {
          return sub.episodeNumber === episodeFilter;
        }
        const ep = extractEpisodeFromReleaseInfo([sub.release, sub.fileName]);
        return ep === episodeFilter;
      })
    : openSubtitlesSubtitles;

  return (
    <div className="subtitle-modal-overlay">
      <div className="subtitle-modal">
        <div className="subtitle-modal-header">
          <div className="subtitle-modal-header-top">
            <h3>{t('header')}</h3>
            <div className="subtitle-modal-header-actions">
              <button
                className="subtitle-diagnostics-open"
                onClick={() => setShowDiagnostics(true)}
                title={t('diagnosticsTooltip')}
              >
                {t('diagnostics')}
              </button>
              <button className="subtitle-modal-close" onClick={onClose}>×</button>
            </div>
          </div>
          <div className="subtitle-header-search">
            <input
              type="text"
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="subtitle-header-search-input"
            />
            <button
              className="subtitle-header-search-btn"
              onClick={handleSearch}
              disabled={searching}
            >
              {searching ? '…' : t('search')}
            </button>
          </div>
          {searchError && (
            <div className="subtitle-header-search-error">{searchError}</div>
          )}
        </div>

        <div className="subtitle-modal-body">
          {/* ── Column 1: Language ── */}
          <div className="subtitle-col subtitle-col-lang">
            <div className="subtitle-col-title">{t('languagesTitle')}</div>
            <div className="subtitle-lang-list">
              <button
                className={`subtitle-lang-btn ${searchLang === 'off' ? 'active' : ''}`}
                onClick={() => {
                  handleDisable();
                  setSearchLang('off');
                }}
              >
                OFF
                {selectedTrackLang === 'off' && <span className="subtitle-active-dot"></span>}
              </button>
              {availableLangs.map((lang) => (
                <button
                  key={lang.code}
                  className={`subtitle-lang-btn ${searchLang === lang.code ? 'active' : ''}`}
                  onClick={() => handleLangChange(lang.code)}
                >
                  {lang.label}
                  {selectedTrackLang === lang.code && <span className="subtitle-active-dot"></span>}
                </button>
              ))}
            </div>
          </div>

          {/* ── Column 2: Loaded Subtitles ── */}
          <div className="subtitle-col subtitle-col-tracks">
            <div className="subtitle-col-title-bar">
              <div className="subtitle-col-title">{t('loadedTitle')}</div>
              <button
                className="subtitle-load-file-btn"
                onClick={handleLoadLocalFile}
                title={t('loadFileTooltip')}
              >
                📂 {t('loadFile')}…
              </button>
            </div>
            {loading ? (
              <div className="subtitle-empty">{t('loadingTracks')}</div>
            ) : (
              <div className="subtitle-track-list">
                <button className="subtitle-load-local-action-btn" onClick={handleLoadLocalFile}>
                  <span>📂 {t('loadFromDisk')}…</span>
                </button>
                <button
                  className={`subtitle-track-btn ${selectedId === 0 ? 'active' : ''}`}
                  onClick={handleDisable}
                >
                  <div className="subtitle-track-variant-wrapper">
                    <div className="subtitle-track-variant-title">
                      {t('none')}
                    </div>
                    <div className="subtitle-track-variant-origin">
                      {t('disabled')}
                    </div>
                  </div>
                  {selectedId === 0 && <span className="subtitle-active-dot"></span>}
                </button>
                {filteredSubTracks.map((track) => {
                  const info = track.external && track['external-filename']
                    ? parseExternalTrack(track['external-filename'])
                    : { label: track.title || t('trackLabel', { id: track.id }), origin: t('embedded') };
                  
                  return (
                    <button
                      key={track.id}
                      className={`subtitle-track-btn ${selectedId === track.id ? 'active' : ''}`}
                      onClick={() => handleSelect(track.id)}
                    >
                      <div className="subtitle-track-variant-wrapper">
                        <div className="subtitle-track-variant-title">
                          {info.label}
                        </div>
                        <div className="subtitle-track-variant-origin">
                          {info.origin}
                            </div>
                          </div>
                          <span className="subtitle-track-meta">
                            {track.lang?.toUpperCase()}
                            {track.external && (
                              <span
                                className="subtitle-track-remove"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveExternal(track.id);
                                }}
                                title={t('remove')}
                              >
                                ×
                              </span>
                            )}
                          </span>
                          {selectedId === track.id && <span className="subtitle-active-dot"></span>}
                        </button>
                      );
                    })}
                {filteredSubTracks.length === 0 && (
                  <div className="subtitle-empty">{t('noSubtitlesLang')}</div>
                )}
              </div>
            )}
          </div>

          {/* ── Column 3: Search & Download ── */}
          <div className="subtitle-col subtitle-col-search">
            <div className="subtitle-col-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {viewState === 'movies' && (
                  <button className="subtitle-back-btn" onClick={() => setViewState('tracks')}>
                    ← {t('back')}
                  </button>
                )}
                {viewState === 'subtitles' && provider === 'subsource' && selectedMovie && (
                  <button
                    className="subtitle-back-btn"
                    onClick={() => {
                      setViewState('movies');
                      setSubtitles([]);
                      setEpisodeFilter(null);
                      setAvailableEpisodes([]);
                    }}
                  >
                    ← {t('back')}
                  </button>
                )}
                {viewState === 'subtitles' && provider === 'opensubtitles' && (
                  <button
                    className="subtitle-back-btn"
                    onClick={() => {
                      setViewState('tracks');
                      setOpenSubtitlesSubtitles([]);
                      setEpisodeFilter(null);
                      setAvailableEpisodes([]);
                    }}
                  >
                    ← {t('back')}
                  </button>
                )}
                {viewState === 'zip-files' && (
                  <button
                    className="subtitle-back-btn"
                    onClick={() => {
                      setViewState('subtitles');
                      setZipEntries([]);
                      setPendingZipData(null);
                      setActiveSubSourceSubtitle(null);
                    }}
                  >
                    ← {t('back')}
                  </button>
                )}
                {viewState === 'tracks' && (
                  <span>{t('provider')}</span>
                )}
              </div>

              {/* Provider selector toggle */}
              <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.08)', padding: '2px', borderRadius: '6px' }}>
                <button
                  type="button"
                  onClick={() => handleProviderChange('subsource')}
                  style={{
                    padding: '3px 8px',
                    fontSize: '0.75rem',
                    borderRadius: '4px',
                    border: 'none',
                    background: provider === 'subsource' ? 'var(--accent-color, #e50914)' : 'transparent',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: provider === 'subsource' ? 600 : 400
                  }}
                >
                  SubSource
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (openSubtitlesToken) handleProviderChange('opensubtitles');
                  }}
                  disabled={!openSubtitlesToken}
                  title={!openSubtitlesToken ? t('loginRequiredTitle') : t('searchOpenSubtitles')}
                  style={{
                    padding: '3px 8px',
                    fontSize: '0.75rem',
                    borderRadius: '4px',
                    border: 'none',
                    background: provider === 'opensubtitles' ? 'var(--accent-color, #e50914)' : 'transparent',
                    color: !openSubtitlesToken ? 'rgba(255,255,255,0.3)' : '#fff',
                    cursor: !openSubtitlesToken ? 'not-allowed' : 'pointer',
                    fontWeight: provider === 'opensubtitles' ? 600 : 400
                  }}
                >
                  OpenSubtitles{!openSubtitlesToken && ' 🔒'}
                </button>
              </div>
            </div>

            {/* Default / Empty / Initial search state */}
            {viewState === 'tracks' && (
              <div className="subtitle-empty">
                {provider === 'subsource' ? (
                  movies.length > 0 ? (
                    <button className="subtitle-back-btn" onClick={() => setViewState('movies')}>
                      {t('showResults', { count: movies.length })} →
                    </button>
                  ) : (
                    t('searchAboveSubSource')
                  )
                ) : (
                  openSubtitlesSubtitles.length > 0 ? (
                    <button className="subtitle-back-btn" onClick={() => setViewState('subtitles')}>
                      {t('showResults', { count: openSubtitlesSubtitles.length })} →
                    </button>
                  ) : openSubtitlesToken ? (
                    t('searchAboveOpenSubtitles')
                  ) : (
                    t('loginToEnable')
                  )
                )}
              </div>
            )}

            {/* MOVIES view (SubSource only) */}
            {viewState === 'movies' && provider === 'subsource' && (
              <div className="subtitle-movie-list">
                {movies.map((movie) => (
                  <button
                    key={movie.movieId}
                    className="subtitle-movie-btn"
                    onClick={() => handleSelectMovie(movie)}
                  >
                    <span className="subtitle-movie-title">
                      {movie.title}
                      {movie.alternateTitle && movie.alternateTitle !== movie.title && (
                        <span className="subtitle-movie-alt"> ({movie.alternateTitle})</span>
                      )}
                    </span>
                    <span className="subtitle-movie-meta">
                      {movie.releaseYear && movie.releaseYear > 0 && movie.releaseYear}
                      {movie.type === 'tvseries' && movie.season !== undefined && movie.season !== null && ` · S${movie.season}`}
                      {movie.type === 'tvseries' && ` · ${t('tv')}`}
                      {movie.type === 'movie' && ` · ${t('movie')}`}
                      {movie.subtitleCount > 0 && ` · ${t('subsCount', { count: movie.subtitleCount })}`}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* SUBTITLES view (OpenSubtitles) */}
            {viewState === 'subtitles' && provider === 'opensubtitles' && (
              <div className="subtitle-result-list">
                <div className="subtitle-result-header">
                  {t('resultsHeader', { lang: LANG_LABELS[searchLang] || searchLang })}
                </div>

                {/* Episode filter bar */}
                {availableEpisodes.length > 0 && (
                  <div className="subtitle-episode-filters">
                    <button
                      className={`subtitle-episode-filter ${episodeFilter === null ? 'active' : ''}`}
                      onClick={() => setEpisodeFilter(null)}
                    >
                      {t('all')}
                    </button>
                    {availableEpisodes.map((ep) => (
                      <button
                        key={ep}
                        className={`subtitle-episode-filter ${episodeFilter === ep ? 'active' : ''}`}
                        onClick={() => setEpisodeFilter(ep)}
                      >
                        E{ep.toString().padStart(2, '0')}
                      </button>
                    ))}
                  </div>
                )}

                {filteredOsSubtitles.map((sub) => (
                  <button
                    key={sub.id}
                    className="subtitle-result-btn"
                    onClick={() => handleDownloadOpenSubtitles(sub)}
                    disabled={downloadingOsId === sub.id}
                  >
                    <span className="subtitle-result-info">
                      <span className="subtitle-result-release" title={sub.release}>
                        <span className="subtitle-result-release-inner">
                          {sub.release}
                        </span>
                      </span>
                      <span className="subtitle-result-detail">
                        {sub.hd && 'HD'}
                        {sub.fps && ` · ${sub.fps}fps`}
                        {sub.hearingImpaired && ' · CC'}
                        {sub.downloads > 0 && ` · ${sub.downloads}↓`}
                        {sub.rating > 0 && (
                          <span className="subtitle-result-rating">
                            {' '}· ★ {sub.rating}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="subtitle-result-action">
                      {downloadingOsId === sub.id ? '…' : t('load')}
                    </span>
                  </button>
                ))}

                {episodeFilter !== null && filteredOsSubtitles.length === 0 && (
                  <div className="subtitle-empty">
                    {t('noSubtitlesForEpisode', { episode: episodeFilter.toString().padStart(2, '0') })}.
                  </div>
                )}
              </div>
            )}

            {/* SUBTITLES view (SubSource) */}
            {viewState === 'subtitles' && provider === 'subsource' && selectedMovie && (
              <div className="subtitle-result-list">
                <div className="subtitle-result-header">
                  {selectedMovie.title}
                  {selectedMovie.season !== undefined && selectedMovie.season !== null && ` S${selectedMovie.season}`}
                  {' '}
                  ({selectedMovie.releaseYear || '?'}) — {LANG_LABELS[searchLang] || searchLang}
                </div>

                {/* Episode filter bar */}
                {availableEpisodes.length > 0 && (
                  <div className="subtitle-episode-filters">
                    <button
                      className={`subtitle-episode-filter ${episodeFilter === null ? 'active' : ''}`}
                      onClick={() => setEpisodeFilter(null)}
                    >
                      {t('all')}
                    </button>
                    {availableEpisodes.map((ep) => (
                      <button
                        key={ep}
                        className={`subtitle-episode-filter ${episodeFilter === ep ? 'active' : ''}`}
                        onClick={() => setEpisodeFilter(ep)}
                      >
                        E{ep.toString().padStart(2, '0')}
                      </button>
                    ))}
                  </div>
                )}

                {filteredSubtitles.map((sub) => (
                  <button
                    key={sub.subtitleId}
                    className="subtitle-result-btn"
                    onClick={() => handleDownloadSubtitle(sub)}
                    disabled={downloadingSubId === sub.subtitleId}
                  >
                    <span className="subtitle-result-info">
                      <span className="subtitle-result-release" title={sub.releaseInfo?.join(' ') || t('unknownRelease')}>
                        <span className="subtitle-result-release-inner">
                          {sub.releaseInfo?.join(' ') || t('unknownRelease')}
                        </span>
                      </span>
                      <span className="subtitle-result-detail">
                        {sub.productionType}
                        {sub.hearingImpaired && ' · CC'}
                        {sub.downloads > 0 && ` · ${sub.downloads}↓`}
                        {sub.rating && sub.rating.total > 0 && (
                          <span className="subtitle-result-rating">
                            {' '}· 👍 {sub.rating.good}/{sub.rating.total}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="subtitle-result-action">
                      {downloadingSubId === sub.subtitleId ? '…' : t('load')}
                    </span>
                  </button>
                ))}

                {episodeFilter !== null && filteredSubtitles.length === 0 && (
                  <div className="subtitle-empty">
                    {t('noSubtitlesForEpisode', { episode: episodeFilter.toString().padStart(2, '0') })}.
                  </div>
                )}
              </div>
            )}

            {/* ZIP FILES view */}
            {viewState === 'zip-files' && (
              <div className="subtitle-result-list">
                <div className="subtitle-result-header">
                  {t('selectZipFile')}
                </div>
                <div className="subtitle-movie-list">
                  {zipEntries.map((entry, index) => {
                    const entryBase = entry.fileName.split(/[/\\]/).pop() || entry.fileName;
                    return (
                      <button
                        key={index}
                        className="subtitle-movie-btn"
                        onClick={() => handleExtractAndLoadZipEntry(entry)}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', width: '100%' }}
                      >
                        <span className="subtitle-movie-title" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                          {entryBase}
                        </span>
                        {entry.fileName !== entryBase && (
                          <span className="subtitle-movie-alt" style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                            {entry.fileName}
                          </span>
                        )}
                        <span className="subtitle-movie-meta" style={{ fontSize: '0.75rem', marginTop: '2px' }}>
                          {(entry.uncompressedSize / 1024).toFixed(1)} KB · {t('load')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Column 3: Subtitles Settings ── */}
          <div className="subtitle-col subtitle-col-controls">
            <div className="subtitle-col-title">{t('settingsTitle')}</div>
            <div className="subtitle-controls-list">
              <div className="subtitle-control-item">
                <label>{t('delay')}</label>
                <div className="subtitle-control-inputs">
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleDelayChange(Math.round((delay - 1) * 10) / 10)}
                    title={t('delayMinus1s')}
                  >-1s</button>
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleDelayChange(Math.round((delay - 0.1) * 10) / 10)}
                    title={t('delayMinus01s')}
                  >-</button>
                  <span className="subtitle-control-display">{delay.toFixed(1)}s</span>
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleDelayChange(Math.round((delay + 0.1) * 10) / 10)}
                    title={t('delayPlus01s')}
                  >+</button>
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleDelayChange(Math.round((delay + 1) * 10) / 10)}
                    title={t('delayPlus1s')}
                  >+1s</button>
                </div>
              </div>

              <div className="subtitle-control-item">
                <label>{t('size')}</label>
                <div className="subtitle-control-inputs">
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleSizeChange(Math.max(10, size - 2))}
                  >-</button>
                  <span className="subtitle-control-display">{size}</span>
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleSizeChange(Math.min(80, size + 2))}
                  >+</button>
                </div>
              </div>

              <div className="subtitle-control-item">
                <label>{t('verticalPosition')}</label>
                <div className="subtitle-control-inputs">
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleVerticalOffsetChange(Math.max(0, verticalOffset - 5))}
                  >↑</button>
                  <span className="subtitle-control-display">{verticalOffset}%</span>
                  <button
                    className="subtitle-control-nudge"
                    onClick={() => handleVerticalOffsetChange(Math.min(100, verticalOffset + 5))}
                  >↓</button>
                </div>
              </div>

              <div className="subtitle-control-item">
                <label>{t('background')}</label>
                <div className="subtitle-control-inputs">
                  <label className="subtitle-toggle-switch">
                    <input
                      type="checkbox"
                      checked={subBackgroundEnabled}
                      onChange={(e) => handleBackgroundToggle(e.target.checked)}
                    />
                    <span className="subtitle-toggle-slider" />
                  </label>
                </div>
              </div>

              {subBackgroundEnabled && (
                <div className="subtitle-control-item">
                  <label>{t('opacity')}</label>
                  <div className="subtitle-control-inputs" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={subBackgroundOpacity}
                      onChange={(e) => handleBackgroundOpacityChange(parseInt(e.target.value))}
                      style={{ width: '80px', margin: 0 }}
                    />
                    <span className="subtitle-control-display" style={{ fontSize: '0.8rem', padding: 0 }}>
                      {subBackgroundOpacity}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <SubtitleDiagnosticsModal isOpen={showDiagnostics} onClose={() => setShowDiagnostics(false)} />
    </div>
  );
}
