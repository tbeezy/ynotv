/**
 * Helpers for playing through the Jellyfin web client's own play queue.
 *
 * When playback starts from a Jellyfin playlist (or an album, or a "play next"
 * queue) the embedded page hands the whole list to its playback manager, so the
 * real play order lives in the page — the bridge captures it into the handoff
 * payload. These helpers resolve that order: which queue entry is playing, and
 * which one comes next/previous, so the player follows the playlist instead of
 * guessing the next episode of the series.
 */

import type { JellyfinQueueItem } from '../types/media';

/** Normalize a Jellyfin item id the way the bridge does (dash-stripped). */
export function normalizeJellyfinItemId(id: string | null | undefined): string {
  return String(id || '').replace(/-/g, '');
}

/** True when the queue has something to navigate through. */
export function hasJellyfinQueue(queue: JellyfinQueueItem[] | null | undefined): boolean {
  return Array.isArray(queue) && queue.length > 1;
}

/** Index of the queue entry for `itemId`, or -1 when it is not in the queue. */
export function jellyfinQueueIndex(
  queue: JellyfinQueueItem[] | null | undefined,
  itemId: string | null | undefined,
): number {
  if (!Array.isArray(queue) || queue.length === 0) return -1;
  const clean = normalizeJellyfinItemId(itemId);
  if (!clean) return -1;
  return queue.findIndex((item) => normalizeJellyfinItemId(item?.id) === clean);
}

/**
 * The queue entry after (or before) the one playing, or null at the queue
 * boundary — or when the queue does not contain the playing item at all, in
 * which case callers should fall back to series-episode navigation.
 */
export function adjacentJellyfinQueueItem(
  queue: JellyfinQueueItem[] | null | undefined,
  itemId: string | null | undefined,
  direction: 'next' | 'prev',
  capturedIndex?: number | null,
): { item: JellyfinQueueItem; index: number } | null {
  const position = resolveJellyfinQueuePosition(queue, itemId, capturedIndex);
  if (!position || !queue) return null;
  const target = direction === 'next' ? position.index + 1 : position.index - 1;
  if (target < 0 || target >= queue.length) return null;
  return { item: queue[target], index: target };
}

/**
 * 0-based position of the playing item plus the queue length, or null when the
 * item is not part of the queue. The id is matched first (the bridge normalizes
 * both sides); `capturedIndex` from the handoff payload is only a fallback for
 * the rare case where the playing item's id cannot be found in the queue.
 */
export function resolveJellyfinQueuePosition(
  queue: JellyfinQueueItem[] | null | undefined,
  itemId: string | null | undefined,
  capturedIndex?: number | null,
): { index: number; total: number } | null {
  if (!Array.isArray(queue) || queue.length === 0) return null;
  const index = jellyfinQueueIndex(queue, itemId);
  if (index >= 0) return { index, total: queue.length };
  if (capturedIndex != null && capturedIndex >= 0 && capturedIndex < queue.length) {
    return { index: capturedIndex, total: queue.length };
  }
  return null;
}

/**
 * Display label for a queue entry: its name, else its S/E numbers, else the
 * series name, else the caller's fallback (queue entries the page never opened
 * carry no metadata until the frontend resolves them).
 */
export function jellyfinQueueItemLabel(
  item: JellyfinQueueItem | null | undefined,
  fallback = '',
): string {
  if (!item) return fallback;
  const name = (item.name || '').trim();
  if (name) return name;
  if (item.indexNumber != null) {
    return item.parentIndexNumber != null
      ? `S${item.parentIndexNumber} E${item.indexNumber}`
      : `E${item.indexNumber}`;
  }
  return (item.seriesName || '').trim() || fallback;
}
