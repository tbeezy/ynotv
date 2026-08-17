import { useEffect, useState, useCallback } from 'react';
import type { LocalEntry } from './types';
import { db, getVodWatchProgress, getEpisodeProgress, recordVodWatch, updateVodWatchProgress, recordEpisodeWatch } from '../../db';
import { scrobbler } from '../scrobbler';

export type WatchStatus = {
  progressPercent: number;
  completed: boolean;
  progressSeconds: number;
  totalDuration: number;
};

export async function getLocalMovieWatchStatus(entry: LocalEntry): Promise<WatchStatus> {
  const mediaId = `local_${entry.id}`;
  try {
    const p = await getVodWatchProgress(mediaId, 'movie');
    if (!p || !p.total_duration || p.total_duration <= 0) {
      return { progressPercent: 0, completed: false, progressSeconds: 0, totalDuration: 0 };
    }
    const percent = Math.min(100, Math.round((p.progress_seconds / p.total_duration) * 100));
    return {
      progressPercent: percent,
      completed: percent >= 90,
      progressSeconds: p.progress_seconds,
      totalDuration: p.total_duration,
    };
  } catch {
    return { progressPercent: 0, completed: false, progressSeconds: 0, totalDuration: 0 };
  }
}

export async function getLocalEpisodeWatchStatus(entry: LocalEntry): Promise<WatchStatus> {
  try {
    const p = await getEpisodeProgress(entry.id);
    if (!p || !p.total_duration || p.total_duration <= 0) {
      return { progressPercent: 0, completed: p?.completed === 1, progressSeconds: 0, totalDuration: 0 };
    }
    const progSec = p.progress_seconds ?? 0;
    const totDur = p.total_duration ?? 0;
    const percent = totDur > 0 ? Math.min(100, Math.round((progSec / totDur) * 100)) : 0;
    return {
      progressPercent: percent,
      completed: p.completed === 1 || percent >= 90,
      progressSeconds: progSec,
      totalDuration: totDur,
    };
  } catch {
    return { progressPercent: 0, completed: false, progressSeconds: 0, totalDuration: 0 };
  }
}

export async function markLocalMovieWatched(entry: LocalEntry, watched: boolean): Promise<void> {
  const mediaId = `local_${entry.id}`;
  try {
    if (watched) {
      const dur = entry.runtime ? entry.runtime * 60 : 3600;
      await recordVodWatch(
        mediaId,
        'movie',
        'local',
        entry.title,
        entry.poster || entry.localArt?.poster || undefined,
      );
      await updateVodWatchProgress(mediaId, 'movie', dur, dur);
      // Sync to Trakt / Simkl if connected
      if (entry.tmdbId || entry.imdbId) {
        void scrobbler.markAsWatched({
          title: entry.title,
          year: entry.year ? String(entry.year) : undefined,
          imdbId: entry.imdbId || undefined,
          tmdbId: entry.tmdbId || undefined,
          type: 'movie',
          progressPercent: 100,
        }).catch(() => {});
      }
    } else {
      const dbInstance = await (db as any).dbPromise;
      await dbInstance.execute(
        'DELETE FROM vod_history WHERE media_id = ? AND media_type = ?',
        [mediaId, 'movie']
      );
    }
  } catch (e) {
    console.error('[local-watch] Failed to mark local movie watched:', e);
  }
}

export async function markLocalEpisodeWatched(
  entry: LocalEntry,
  seriesTitle: string,
  watched: boolean,
): Promise<void> {
  const seriesKey = (entry.imdbId || (entry.tmdbId ? `tmdb_${entry.tmdbId}` : null) || seriesTitle).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const seriesId = `local_${seriesKey}`;
  const season = entry.season ?? 1;
  const ep = entry.episode ?? 1;
  const epTitle = entry.title || `Episode ${ep}`;

  try {
    if (watched) {
      const dur = entry.runtime ? entry.runtime * 60 : 1800;
      await recordVodWatch(
        seriesId,
        'series',
        'local',
        seriesTitle,
        entry.poster || entry.localArt?.poster || undefined,
        season,
        ep,
        epTitle
      );
      await recordEpisodeWatch(
        entry.id,
        seriesId,
        'local',
        season,
        ep,
        epTitle,
        dur,
        dur
      );
      // Sync to Trakt / Simkl if connected
      if (entry.tmdbId || entry.imdbId) {
        void scrobbler.markAsWatched({
          title: seriesTitle,
          year: entry.year ? String(entry.year) : undefined,
          imdbId: entry.imdbId || undefined,
          tmdbId: entry.tmdbId || undefined,
          type: 'series',
          season,
          episode: ep,
          progressPercent: 100,
        }).catch(() => {});
      }
    } else {
      const dbInstance = await (db as any).dbPromise;
      await dbInstance.execute(
        'DELETE FROM episode_history WHERE episode_id = ?',
        [entry.id]
      );
    }
  } catch (e) {
    console.error('[local-watch] Failed to mark local episode watched:', e);
  }
}

export function useLocalMovieWatchStatus(entry: LocalEntry | null | undefined): WatchStatus {
  const [status, setStatus] = useState<WatchStatus>({
    progressPercent: 0,
    completed: false,
    progressSeconds: 0,
    totalDuration: 0,
  });

  const refresh = useCallback(() => {
    if (!entry) return;
    getLocalMovieWatchStatus(entry).then(setStatus);
  }, [entry?.id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return status;
}

export function useLocalEpisodeWatchStatus(entry: LocalEntry | null | undefined): WatchStatus {
  const [status, setStatus] = useState<WatchStatus>({
    progressPercent: 0,
    completed: false,
    progressSeconds: 0,
    totalDuration: 0,
  });

  const refresh = useCallback(() => {
    if (!entry) return;
    getLocalEpisodeWatchStatus(entry).then(setStatus);
  }, [entry?.id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return status;
}
