import type { LocalEntry, LocalGroup } from './types';

/**
 * Review rows are per series folder / movie — never per file — so a "review
 * group" is the unit the user matches, skips or removes. These identity helpers
 * are shared by the review list and by LocalTab's identify queue: the queue
 * reports a resolved group with the very same key the list uses for its row, so
 * a row can be dropped exactly when its identify flow really finished (and left
 * alone when the flow was cancelled).
 */

/** Stable identity of a review unit: the movie's entry id, or the series key. */
export function reviewGroupKey(g: LocalGroup): string {
  return g.kind === 'movie' ? g.entry.id : g.key;
}

/** Every entry id in a review unit (a single movie, or all episodes of a show). */
export function reviewGroupIds(g: LocalGroup): string[] {
  return g.kind === 'movie' ? [g.entry.id] : g.episodes.map((e) => e.id);
}

/** The entries the IdentifyModal works on for a review unit. */
export function reviewGroupEntries(g: LocalGroup): LocalEntry[] {
  return g.kind === 'movie' ? [g.entry] : g.episodes;
}
