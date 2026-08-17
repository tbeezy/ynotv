import { recordVodWatch, recordEpisodeWatch, getEpisodeProgress } from '../db';
import type { Playlist, PlaylistItem } from '../stores/vodPlaylistStore';
import { useActivePlaylistStore, isActivePlaylistItem } from '../stores/activePlaylistStore';
import { useVodPlaylistProgressStore, type PlaylistItemProgressSnapshot } from '../stores/vodPlaylistProgressStore';
import type { PlaylistItemProgress } from '../hooks/usePlaylistProgress';
import type { VodPlayInfo } from '../types/media';

/**
 * True when a playlist item's source has been removed or disabled, so the
 * item can't be played anymore. Items without a sourceId (rare/manual) stay
 * visible. While sources are still loading (null) nothing is treated as
 * hidden, so the UI never flashes items away during startup.
 */
export function isPlaylistItemHidden(item: PlaylistItem, enabledSources: Set<string> | null): boolean {
  if (!enabledSources) return false;
  return !!item.sourceId && !enabledSources.has(item.sourceId);
}

/**
 * Build the canonical VodPlayInfo for a playlist item, mirroring what
 * SeriesDetail/MovieDetail pass to playback so that resume and progress
 * tracking work exactly like normal VOD playback.
 *
 * For episodes the mediaId uses the `seriesId_ep_episodeId` shape the
 * playback progress-save and resume paths key on.
 */
export function playlistItemToVodInfo(item: PlaylistItem): VodPlayInfo {
  const isEpisode = item.itemType === 'episode';
  return {
    url: item.directUrl || '',
    title: item.title,
    type: isEpisode ? 'series' : 'movie',
    source_id: item.sourceId,
    mediaId: isEpisode && item.seriesId ? `${item.seriesId}_ep_${item.mediaId}` : item.mediaId,
    seriesId: item.seriesId,
    seasonNum: item.seasonNum,
    episodeNum: item.episodeNum,
    episodeId: isEpisode ? item.mediaId : undefined,
    episodeInfo: isEpisode
      ? `S${item.seasonNum ?? 0} E${item.episodeNum ?? 0}${item.episodeTitle ? ` · ${item.episodeTitle}` : ''}`
      : undefined,
    backdropUrl: item.backdropUrl || undefined,
    posterUrl: item.poster || undefined,
  };
}

/**
 * Find the most recently watched item of a playlist. Items with no watch
 * history (watchedAt 0) are ignored; returns null when nothing was watched.
 */
/**
 * Build the progress map for a set of playlist items from the DB history rows
 * (episode_history + vod_history), filling any gaps from the localStorage
 * snapshots so playlists keep resume/last-watched info even after a cache
 * clear wiped the history tables. Keyed by playlist item id.
 */
export function buildPlaylistProgressMap(
  items: PlaylistItem[],
  episodes: Record<string, { progress_seconds: number; total_duration: number; completed: boolean; watched_at: number }>,
  movies: Record<string, { progress_seconds: number; total_duration: number; watched_at: number }>,
  snapshots: Record<string, PlaylistItemProgressSnapshot>
): Map<string, PlaylistItemProgress> {
  const next = new Map<string, PlaylistItemProgress>();

  // DB history is the source of truth while it exists (freshest data).
  for (const item of items) {
    if (item.itemType === 'episode') {
      const p = episodes[item.mediaId];
      if (!p) continue;
      const dur = p.total_duration;
      const prog = p.progress_seconds;
      const completed = p.completed || (dur > 0 && prog / dur >= 0.9);
      next.set(item.id, {
        progressSeconds: prog,
        totalDuration: dur,
        completed,
        percent: dur > 0 ? Math.min(100, (prog / dur) * 100) : 0,
        watchedAt: p.watched_at || 0,
      });
    } else {
      const p = movies[item.mediaId];
      if (!p) continue;
      const dur = p.total_duration;
      const prog = p.progress_seconds;
      next.set(item.id, {
        progressSeconds: prog,
        totalDuration: dur,
        completed: dur > 0 && prog / dur >= 0.9,
        percent: dur > 0 ? Math.min(100, (prog / dur) * 100) : 0,
        watchedAt: p.watched_at || 0,
      });
    }
  }

  // Fall back to localStorage snapshots for items the DB has no history for
  // (e.g. after "Clear All Cached Data" wiped the history tables).
  for (const item of items) {
    if (next.has(item.id)) continue;
    const snap = snapshots[item.id];
    if (!snap) continue;
    const dur = snap.totalDuration;
    next.set(item.id, {
      progressSeconds: snap.progressSeconds,
      totalDuration: dur,
      completed: snap.completed || (dur > 0 && snap.progressSeconds / dur >= 0.9),
      percent: dur > 0 ? Math.min(100, (snap.progressSeconds / dur) * 100) : 0,
      watchedAt: snap.watchedAt || 0,
    });
  }

  return next;
}

/**
 * Snapshot the currently playing item's progress into the playlist progress
 * store (localStorage) when a playlist item is what's actually playing. The
 * DB history this mirrors is wiped by "Clear All Cached Data", so the
 * snapshot keeps playlists' resume hints and "last watched" info intact.
 */
export function snapshotPlaylistProgress(
  vodInfo: VodPlayInfo | null | undefined,
  position: number,
  duration: number
): void {
  if (!vodInfo || position <= 0 || duration <= 0) return;
  const active = useActivePlaylistStore.getState();
  if (!active.activePlaylistId || active.currentIndex < 0) return;
  const item = active.items[active.currentIndex];
  if (!item || !isActivePlaylistItem(vodInfo, item)) return;
  useVodPlaylistProgressStore.getState().setProgress(item.id, {
    progressSeconds: Math.floor(position),
    totalDuration: Math.floor(duration),
    completed: position / duration >= 0.9,
    watchedAt: Date.now(),
  });
}

export function findLastWatchedItem(
  items: PlaylistItem[],
  progressMap: ReadonlyMap<string, PlaylistItemProgress>
): PlaylistItem | null {
  let best: PlaylistItem | null = null;
  let bestAt = 0;
  for (const item of items) {
    const p = progressMap.get(item.id);
    const at = p?.watchedAt ?? 0;
    if (at > bestAt) {
      best = item;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Sort playlists so the most recently watched one comes first (by the latest
 * watched_at among each playlist's items). Never-played playlists sink below
 * the watched ones, keeping their original relative order (stable sort).
 */
export function sortPlaylistsByLastPlayed(
  playlists: Playlist[],
  progressMap: ReadonlyMap<string, PlaylistItemProgress>
): Playlist[] {
  const lastPlayedAt = (pl: Playlist): number => {
    let max = 0;
    for (const item of pl.items) {
      const at = progressMap.get(item.id)?.watchedAt ?? 0;
      if (at > max) max = at;
    }
    return max;
  };
  return [...playlists].sort((a, b) => lastPlayedAt(b) - lastPlayedAt(a));
}

/**
 * Record a playlist item into vod_history (the Recent rail) and episode
 * progress, mirroring the recording done by SeriesDetail/MovieDetail when a
 * video starts. Existing episode resume position is preserved so replaying an
 * item never wipes its progress.
 */
export async function recordPlaylistItemWatch(item: PlaylistItem): Promise<void> {
  if (item.itemType === 'movie') {
    await recordVodWatch(item.mediaId, 'movie', item.sourceId || '', item.title, item.poster || undefined);
    return;
  }
  if (!item.seriesId) return;

  // Preserve any existing episode progress instead of resetting it.
  let resumePosition = 0;
  let duration = 0;
  try {
    const progress = await getEpisodeProgress(item.mediaId);
    if (progress && (progress.progress_seconds ?? 0) > 10 && (progress.total_duration ?? 0) > 0) {
      resumePosition = progress.progress_seconds ?? 0;
      duration = progress.total_duration ?? 0;
    }
  } catch (err) {
    console.warn('[Playlist] Failed to read existing episode progress:', err);
  }

  await recordVodWatch(
    item.seriesId,
    'series',
    item.sourceId || '',
    item.seriesTitle || item.title,
    item.poster || undefined,
    item.seasonNum,
    item.episodeNum,
    item.episodeTitle || `Episode ${item.episodeNum ?? 0}`
  );
  await recordEpisodeWatch(
    item.mediaId,
    item.seriesId,
    item.sourceId || '',
    item.seasonNum ?? 0,
    item.episodeNum ?? 0,
    item.episodeTitle || '',
    resumePosition,
    duration
  );
}
