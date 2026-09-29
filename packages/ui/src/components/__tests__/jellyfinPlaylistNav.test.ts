/**
 * Source-contract tests for Jellyfin playlist playback.
 *
 * The player's prev/next and auto-play now prefer the play queue the embedded
 * Jellyfin page reported (a playlist can mix series, movies and episodes) and
 * only fall back to the series episode list. That preference lives in the
 * component tree, which the node test environment cannot render, so these
 * assertions pin the wiring in the real sources — and, critically, that the
 * queue branch is reached BEFORE the series-episode branch it must override.
 *
 * The queue logic itself (matching, adjacency, boundaries) is unit-tested in
 * utils/__tests__/jellyfinQueue.test.ts, and the capture side in
 * services/__tests__/jellyfinBridge.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', '..');
const read = (...parts: string[]) => readFileSync(resolve(srcRoot, ...parts), 'utf8');

const app = read('App.tsx');
const nowPlayingBar = read('components', 'NowPlayingBar.tsx');
const queueModal = read('components', 'jellyfin', 'JellyfinQueueModal.tsx');
const jellyfinPage = read('components', 'JellyfinPage.tsx');
const mediaTypes = read('types', 'media.ts');

/** Source of one App.tsx handler, from its declaration to the next one. */
function handlerSource(name: string): string {
  const start = app.indexOf(`const ${name} = useCallback(async () => {`);
  expect(start, `${name} not found in App.tsx`).toBeGreaterThan(-1);
  const next = app.indexOf('\n  const ', start + 1);
  return app.slice(start, next > start ? next : undefined);
}

describe('Jellyfin play-queue navigation wiring', () => {
  it('carries the queue from the bridge payload onto the play info', () => {
    expect(jellyfinPage).toContain('queue?: {');
    expect(mediaTypes).toContain('jellyfinQueue?: JellyfinQueueItem[]');
    expect(mediaTypes).toContain('jellyfinQueueIndex?: number');
    expect(app).toContain('jellyfinQueue: payload.queue?.items,');
    expect(app).toContain('jellyfinQueueIndex:');
  });

  it('keeps the queue on the play info when switching items in place', () => {
    // playJellyfinTarget carries the queue (and the new position) across a jump,
    // otherwise the first prev/next would fall back to the series episode list.
    expect(app).toContain('jellyfinQueue: current.jellyfinQueue,');
    expect(app).toContain('jellyfinQueueIndex: queueIndex >= 0 ? queueIndex : undefined,');
  });

  it('walks the queue for next/previous before the series episode fallback', () => {
    for (const [handler, direction] of [
      ['handleChannelUp', "'prev'"],
      ['handleChannelDown', "'next'"],
    ] as const) {
      const source = handlerSource(handler);
      const queueBranch = source.indexOf('hasJellyfinQueue(vodInfo.jellyfinQueue)');
      const seriesBranch = source.indexOf("vodInfo.source_id === 'jellyfin'", queueBranch + 1);
      expect(queueBranch, `${handler} does not consult the play queue`).toBeGreaterThan(-1);
      expect(source).toContain(`adjacentJellyfinQueueItem(`);
      expect(source).toContain(direction);
      // The queue branch must be the first thing the handler does: the series
      // branch below it is a fallback, and a movie in a playlist has no series.
      expect(queueBranch).toBeLessThan(seriesBranch > -1 ? seriesBranch : source.length);
      expect(queueBranch).toBeLessThan(source.indexOf("vodInfo?.type === 'series'"));
    }
  });

  it('auto-plays the next queue item before the next series episode', () => {
    const queueBranch = app.indexOf("hasJellyfinQueue(vodInfo?.jellyfinQueue)");
    const episodeBranch = app.indexOf("vodInfo?.jellyfinEpisodes?.length && vodInfo.jellyfinItemId");
    expect(queueBranch).toBeGreaterThan(-1);
    expect(episodeBranch).toBeGreaterThan(-1);
    expect(queueBranch).toBeLessThan(episodeBranch);
    // Reaching the end of a playlist must not fall through to the local-series
    // lookup (a Jellyfin series id means nothing to the VOD database).
    const queueBlock = app.slice(queueBranch, episodeBranch);
    expect(queueBlock).toContain('reached the end of the captured play queue');
  });
});

describe('Jellyfin play-queue UI wiring', () => {
  it('shows where playback comes from and opens the queue from the badge', () => {
    expect(nowPlayingBar).toContain('resolveJellyfinQueuePosition');
    expect(nowPlayingBar).toContain('isJellyfinQueueActive');
    expect(nowPlayingBar).toContain('jellyfinQueueIndicator');
    expect(nowPlayingBar).toContain('onClick={onJellyfinQueueClick}');
    expect(nowPlayingBar).toContain('jellyfinQueueNextLabel');
    // The badge says "from playlist" (the page name when the playlist is known).
    expect(nowPlayingBar).toContain("{t('fromPlaylist')}");
    expect(nowPlayingBar).toContain('vodInfo?.jellyfinQueueName');
    // Rendered exactly once per layout (clean and classic), never duplicated.
    // A plain total of two would also pass with both badges stacked in one
    // layout, so count either side of the classic layout's info row.
    const classicStart = nowPlayingBar.indexOf('npb-info-row');
    expect(classicStart).toBeGreaterThan(-1);
    const rendersIn = (source: string) => (source.match(/\{jellyfinQueueIndicator\}/g) || []).length;
    expect(rendersIn(nowPlayingBar.slice(0, classicStart)), 'clean layout').toBe(1);
    expect(rendersIn(nowPlayingBar.slice(classicStart)), 'classic layout').toBe(1);
  });

  it('keeps prev/next visible through the whole queue and stops at the ends', () => {
    const source = nowPlayingBar;
    expect(source).toContain('jellyfinQueuePos.index > 0');
    expect(source).toContain('jellyfinQueuePos.index < jellyfinQueuePos.total - 1');
    // Buttons for a movie in a playlist would otherwise be hidden by the
    // episode-only condition.
    expect(source).toContain('const isQueueNav = isPlaylistActive || isJellyfinQueueActive;');
    expect(source).toContain('{isQueueNav || isEpisodeNav ? <NextIcon /> : <ChannelDownIcon />}');
  });

  it('lists every queue entry and jumps to the clicked one', () => {
    expect(queueModal).toContain('vodInfo?.jellyfinQueue || []');
    expect(queueModal).toContain('onClick={() => onPlayItem(index)}');
    expect(queueModal).toContain("{i18n.t('player:currentlyPlaying')}");
    expect(queueModal).toContain("{i18n.t('player:nextUp')}");
    // Entries without metadata are resolved once from the API.
    expect(queueModal).toContain('/Users/${encodeURIComponent(userId)}/Items');
    expect(app).toContain('<JellyfinQueueModal');
    expect(app).toContain('onJellyfinQueueClick={() => setJellyfinQueueOpen(true)}');
  });

  it('resets the queue overlay when playback stops', () => {
    expect(app).toContain('setJellyfinQueueOpen(false);');
  });
});
