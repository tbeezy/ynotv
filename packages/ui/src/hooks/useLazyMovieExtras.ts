/**
 * useLazyMovieExtras - Lazy-load movie metadata with cast photos, logo, and IDs
 *
 * Fetches from TMDB API (requires API key):
 * - Searches by title+year if tmdb_id is missing, caches it back to DB
 * - Cast with headshot photos (profile_path)
 * - Movie logo (from TMDB images)
 * - IMDB ID
 *
 * Caches results to DB so we don't refetch.
 */

import { useState, useEffect, useRef } from 'react';
import { db, type StoredMovie } from '../db';
import { getTmdb, getTmdbImageUrl, searchMovies, getMovieDetails, getMovieCredits, formatLanguageCode, formatCountryCode } from '../services/tmdb';
import { fetchVodProviderTmdbId, isTmdbMatchStale } from '../db/sync';
import { cleanTitleForSearch } from '../utils/cleanTitle';

export interface CastMember {
  id: number;
  name: string;
  character: string;
  photo: string | null;
}

export interface MovieExtras {
  cast: CastMember[];
  logoUrl: string | null;
  imdbId: string | null;
  country: string | null;
  language: string | null;
  loading: boolean;
}

export function useLazyMovieExtras(
  movie: StoredMovie | null | undefined,
  apiKey: string | null | undefined
): MovieExtras {
  const [cast, setCast] = useState<CastMember[]>([]);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [imdbId, setImdbId] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastMovieIdRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);

  const movieId = movie?.stream_id ?? null;

  if (movieId !== lastMovieIdRef.current) {
    lastMovieIdRef.current = movieId;
    setCast([]);
    setLogoUrl(null);
    setImdbId(null);
    setCountry(null);
    setLanguage(null);
  }

  useEffect(() => {
    if (!movie || !apiKey) return;
    if (fetchingRef.current) return;

    let cancelled = false;

    const fetchExtras = async () => {
      fetchingRef.current = true;
      setLoading(true);

      try {
        const searchQuery = cleanTitleForSearch(movie.title || movie.name);
        const year = movie.year || movie.release_date?.slice(0, 4);
        if (!searchQuery) {
          fetchingRef.current = false;
          setLoading(false);
          return;
        }

        const cachedTmdbId = movie.tmdb_id ? Number(movie.tmdb_id) || null : null;
        const revalidate = isTmdbMatchStale(movie.match_attempted);
        let foundTmdbId: number | null = cachedTmdbId;
        let newCast: CastMember[] = [];
        let newLogo: string | null = null;
        let newImdbId: string | null = null;
        let newCountry: string | null = null;
        let newLanguage: string | null = null;

        // Resolve TMDB ID when missing OR stale. Prefer the provider-supplied
        // get_vod_info id (exact match) so ids added/fixed by the provider after
        // a fuzzy-search match are picked up instead of being locked in forever.
        if (!foundTmdbId || revalidate) {
          try {
            if (window.storage && movie.source_id) {
              const sourcesResult = await window.storage.getSources();
              const source = sourcesResult.data?.find(s => String(s.id) === String(movie.source_id));
              if (source) {
                const providerTmdbId = await fetchVodProviderTmdbId(source, movie.stream_id);
                if (!cancelled && providerTmdbId) {
                  foundTmdbId = providerTmdbId;
                }
              }
            }
          } catch (e) {
            console.warn('[useLazyMovieExtras] Provider tmdb_id fetch failed:', e);
          }

          if (!foundTmdbId) {
            try {
              const results = await searchMovies(apiKey, searchQuery, year ? parseInt(year) : undefined);
              if (!cancelled && results.length > 0) {
                foundTmdbId = results[0].id;
              }
            } catch (e) {
              console.warn('[useLazyMovieExtras] TMDB search failed:', e);
            }
          }
        }

        if (!foundTmdbId) {
          fetchingRef.current = false;
          setLoading(false);
          return;
        }

        const tmdb = getTmdb(apiKey);

        // Fetch movie details for imdb_id, country, and language
        try {
          const details = await getMovieDetails(apiKey, foundTmdbId);
          if (!cancelled) {
            newImdbId = details.imdb_id || null;
            newCountry = formatCountryCode(details.production_countries, details.origin_country) || null;
            newLanguage = formatLanguageCode(details.original_language, details.spoken_languages) || null;
          }
        } catch (e) {
          console.warn('[useLazyMovieExtras] TMDB details failed:', e);
        }

        // Fetch credits for cast with photos
        try {
          const credits = await getMovieCredits(apiKey, foundTmdbId);
          if (!cancelled && credits.cast) {
            newCast = credits.cast.slice(0, 12).map((c) => ({
              id: c.id,
              name: c.name,
              character: c.character,
              photo: c.profile_path ? getTmdbImageUrl(c.profile_path, 'w185') : null,
            }));
          }
        } catch (e) {
          console.warn('[useLazyMovieExtras] TMDB credits failed:', e);
        }

        // Fetch images for logo
        try {
          const images = await tmdb.movies.images(foundTmdbId);
          if (!cancelled && images.logos && images.logos.length > 0) {
            const logo = images.logos.find((l: any) => l.iso_639_1 === 'en') || images.logos[0];
            newLogo = getTmdbImageUrl(logo.file_path, 'original');
          }
        } catch (e) {
          console.warn('[useLazyMovieExtras] TMDB images failed:', e);
        }

        // Cache discovered IDs to DB
        if (!cancelled) {
          const updates: Partial<StoredMovie> = {};
          if (foundTmdbId && cachedTmdbId !== foundTmdbId) updates.tmdb_id = foundTmdbId;
          if (newImdbId && !movie.imdb_id) updates.imdb_id = newImdbId;
          if (!cachedTmdbId || revalidate) updates.match_attempted = new Date().toISOString();

          if (Object.keys(updates).length > 0) {
            await db.vodMovies.update(movie.stream_id, updates);
          }

          setCast(newCast);
          setLogoUrl(newLogo);
          setImdbId(newImdbId);
          setCountry(newCountry);
          setLanguage(newLanguage);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[useLazyMovieExtras] Failed:', err);
        }
      } finally {
        fetchingRef.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    fetchExtras();

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [movie?.stream_id, movie?.title, movie?.name, movie?.tmdb_id, movie?.imdb_id, movie?.match_attempted, apiKey]);

  return { cast, logoUrl, imdbId, country, language, loading };
}

export default useLazyMovieExtras;
