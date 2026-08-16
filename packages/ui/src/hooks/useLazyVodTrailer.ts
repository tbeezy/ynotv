import { useState, useEffect, useRef, useCallback } from 'react';
import type { StoredMovie, StoredSeries } from '../db';
import { fetchVodProviderTrailerInfo } from '../db/sync';
import { cleanTitleForSearch } from '../utils/cleanTitle';
import type { Source } from '@ynotv/core';
import { useSettingsStore } from '../stores/settingsStore';
import {
  getTmdb,
  searchMovies,
  searchTvShows,
  getMovieVideos,
  getTvShowVideos,
  findTrailerUrl,
} from '../services/tmdb';

export interface VodTrailerResult {
  /** Trailer supplied directly by the IPTV source (get_vod_info / get_series_info). */
  sourceTrailerUrl: string | null;
  /** Trailer resolved from TMDB. */
  tmdbTrailerUrl: string | null;
  /** True while either trailer is being resolved. */
  loading: boolean;
}

function toYouTubeUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  return `https://www.youtube.com/watch?v=${v}`;
}

export function useLazyVodTrailer(
  item: StoredMovie | StoredSeries | null,
  type: 'movie' | 'series',
  accessToken: string | null
): VodTrailerResult {
  const [sourceTrailerUrl, setSourceTrailerUrl] = useState<string | null>(null);
  const [tmdbTrailerUrl, setTmdbTrailerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastItemIdRef = useRef<string | number | null>(null);
  const fetchingRef = useRef(false);

  const isSeries = type === 'series';
  const itemId = item
    ? (isSeries ? (item as StoredSeries).series_id : (item as StoredMovie).stream_id)
    : null;

  if (itemId !== lastItemIdRef.current) {
    lastItemIdRef.current = itemId;
    setSourceTrailerUrl(null);
    setTmdbTrailerUrl(null);
  }

  useEffect(() => {
    if (!item) {
      setSourceTrailerUrl(null);
      setTmdbTrailerUrl(null);
      setLoading(false);
      return;
    }

    if (fetchingRef.current) return;

    let cancelled = false;

    const fetchTrailers = async () => {
      fetchingRef.current = true;
      setLoading(true);

      const itemIdForFetch = isSeries
        ? (item as StoredSeries).series_id
        : (item as StoredMovie).stream_id;

      try {
        // ---- 1. Source trailer (works with OR without a TMDB key) ----
        let sourceTrailer: string | null = null;

        // 1a. Directly from the stored item if it already has a youtube_trailer.
        const storedTrailer = (item as any).youtube_trailer;
        if (storedTrailer && typeof storedTrailer === 'string' && storedTrailer.trim()) {
          sourceTrailer = toYouTubeUrl(storedTrailer);
        }

        // 1b. Otherwise fetch it / a provider tmdb_id from get_vod_info / get_series_info.
        // Even when a TMDB key is present, the provider's own trailer is preferred
        // because it's an exact, maintained match for their catalog entry.
        let providerTmdbId: number | null = null;
        const storage = window.storage;
        if (storage && item.source_id) {
          try {
            const sourcesResult = await storage.getSources();
            const src = sourcesResult.data?.find((s) => String(s.id) === String(item.source_id));
            if (src) {
              const info = await fetchVodProviderTrailerInfo(src, type, itemIdForFetch);
              if (!cancelled) {
                providerTmdbId = info.tmdbId;
                if (!sourceTrailer && info.youtubeTrailer) {
                  sourceTrailer = toYouTubeUrl(info.youtubeTrailer);
                }
              }
            }
          } catch (err) {
            console.warn('[Trailer] Provider trailer fetch failed:', err);
          }
        }

        if (!cancelled) setSourceTrailerUrl(sourceTrailer);

        // ---- 2. TMDB trailer (only if a TMDB key is configured) ----
        if (accessToken && accessToken.trim()) {
          const itemStoredId = item.tmdb_id ? Number(item.tmdb_id) : NaN;
          let tmdbId: number | null = !isNaN(itemStoredId) ? itemStoredId : providerTmdbId;

          if (!tmdbId && item.imdb_id && item.imdb_id.startsWith('tt')) {
            try {
              const tmdb = getTmdb(accessToken);
              const findResult = await tmdb.find.byExternalId(item.imdb_id, { external_source: 'imdb_id' });
              if (isSeries) {
                tmdbId = findResult.tv_results?.[0]?.id || null;
              } else {
                tmdbId = findResult.movie_results?.[0]?.id || null;
              }
            } catch (err) {
              console.error('[TMDB] Find by IMDb ID failed in VOD trailer hook:', err);
            }
          }

          const rawTitle = item.title || item.name;
          const cleanedTitle = cleanTitleForSearch(rawTitle);
          const title = cleanedTitle || rawTitle;
          const year = item.year || (item as any).release_date?.slice(0, 4);

          // Fallback to cleaned title & year search
          if (!tmdbId && title && !cancelled) {
            if (isSeries) {
              const results = await searchTvShows(accessToken, title, year ? parseInt(String(year)) : undefined);
              if (!cancelled && results.length > 0) tmdbId = results[0].id;
            } else {
              const results = await searchMovies(accessToken, title, year ? parseInt(String(year)) : undefined);
              if (!cancelled && results.length > 0) tmdbId = results[0].id;
            }
          }

          if (tmdbId && !cancelled) {
            const videos = isSeries
              ? await getTvShowVideos(accessToken, tmdbId)
              : await getMovieVideos(accessToken, tmdbId);
            const url = findTrailerUrl(videos);
            if (!cancelled) setTmdbTrailerUrl(url);
          }
        }
      } catch (err) {
        console.error('[TMDB] Failed to fetch VOD trailer:', err);
      } finally {
        fetchingRef.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    void fetchTrailers();

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [itemId, item?.title, item?.name, item?.tmdb_id, item?.imdb_id, isSeries, accessToken, item?.source_id]);

  return { sourceTrailerUrl, tmdbTrailerUrl, loading };
}

export type TrailerSource = 'source' | 'tmdb';

/**
 * User preference for which trailer to use when both the source and TMDB
 * provide one. Persisted to settings.
 */
export function useTrailerSource(): [TrailerSource, (source: TrailerSource) => void] {
  const sourcePref = useSettingsStore((s) => s.trailerSource);
  const setPref = useCallback((pref: TrailerSource) => {
    useSettingsStore.getState().setTrailerSource(pref);
  }, []);

  return [sourcePref, setPref];
}

export function useTrailerPlayerMode(): [import('../components/vod/SplitPlayButton').VodPlayerMode, (mode: import('../components/vod/SplitPlayButton').VodPlayerMode) => void] {
  const mode = useSettingsStore((s) => s.trailerPlayerMode);
  const setMode = (newMode: import('../components/vod/SplitPlayButton').VodPlayerMode) => {
    useSettingsStore.getState().setTrailerPlayerMode(newMode);
  };

  return [mode, setMode];
}