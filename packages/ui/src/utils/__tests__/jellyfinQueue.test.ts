import { describe, it, expect } from 'vitest';
import {
  normalizeJellyfinItemId,
  hasJellyfinQueue,
  jellyfinQueueIndex,
  adjacentJellyfinQueueItem,
  resolveJellyfinQueuePosition,
  jellyfinQueueItemLabel,
} from '../jellyfinQueue';
import type { JellyfinQueueItem } from '../../types/media';

const A = '5b12f80a-4f3c-4a2c-9f1e-1a2b3c4d5e6f';
const B = '6c23f90b-5a4d-5b3d-af2e-3b4c5d6e7f70';
const C = '7d34a01c6b5e6c4eb03f4c5d6e7f8081';

const item = (over: Partial<JellyfinQueueItem>): JellyfinQueueItem => ({
  id: '',
  ...over,
});

const queue: JellyfinQueueItem[] = [
  item({ id: A, name: 'First Movie', type: 'Movie' }),
  item({ id: B, name: 'Second Episode', type: 'Episode', parentIndexNumber: 2, indexNumber: 3 }),
  item({ id: C, name: 'Third Track', type: 'Audio' }),
];

describe('normalizeJellyfinItemId', () => {
  it('strips dashes and tolerates null/undefined', () => {
    expect(normalizeJellyfinItemId(A)).toBe(A.replace(/-/g, ''));
    expect(normalizeJellyfinItemId(null)).toBe('');
    expect(normalizeJellyfinItemId(undefined)).toBe('');
  });
});

describe('hasJellyfinQueue', () => {
  it('requires more than one entry', () => {
    expect(hasJellyfinQueue(queue)).toBe(true);
    expect(hasJellyfinQueue([item({ id: A })])).toBe(false);
    expect(hasJellyfinQueue([])).toBe(false);
    expect(hasJellyfinQueue(null)).toBe(false);
    expect(hasJellyfinQueue(undefined)).toBe(false);
  });
});

describe('jellyfinQueueIndex', () => {
  it('finds the playing item regardless of dash formatting', () => {
    expect(jellyfinQueueIndex(queue, B)).toBe(1);
    expect(jellyfinQueueIndex(queue, B.replace(/-/g, ''))).toBe(1);
  });

  it('returns -1 for an item outside the queue or an empty queue', () => {
    expect(jellyfinQueueIndex(queue, 'ffffffffffffffffffffffffffffffff')).toBe(-1);
    expect(jellyfinQueueIndex(queue, null)).toBe(-1);
    expect(jellyfinQueueIndex([], A)).toBe(-1);
    expect(jellyfinQueueIndex(null, A)).toBe(-1);
  });
});

describe('adjacentJellyfinQueueItem', () => {
  it('walks the queue in playlist order, crossing series and media types', () => {
    expect(adjacentJellyfinQueueItem(queue, A, 'next')?.item.name).toBe('Second Episode');
    expect(adjacentJellyfinQueueItem(queue, A, 'next')?.index).toBe(1);
    expect(adjacentJellyfinQueueItem(queue, B, 'next')?.item.name).toBe('Third Track');
    expect(adjacentJellyfinQueueItem(queue, C, 'prev')?.item.name).toBe('Second Episode');
    expect(adjacentJellyfinQueueItem(queue, B, 'prev')?.item.name).toBe('First Movie');
  });

  it('stops at the queue boundaries instead of wrapping', () => {
    expect(adjacentJellyfinQueueItem(queue, C, 'next')).toBeNull();
    expect(adjacentJellyfinQueueItem(queue, A, 'prev')).toBeNull();
  });

  it('returns null when the playing item is not in the queue (series fallback)', () => {
    expect(adjacentJellyfinQueueItem(queue, 'ffffffffffffffffffffffffffffffff', 'next')).toBeNull();
    expect(adjacentJellyfinQueueItem(null, A, 'next')).toBeNull();
  });
});

describe('resolveJellyfinQueuePosition', () => {
  it('reports a 1-based-able position with the queue length', () => {
    expect(resolveJellyfinQueuePosition(queue, A)).toEqual({ index: 0, total: 3 });
    expect(resolveJellyfinQueuePosition(queue, C)).toEqual({ index: 2, total: 3 });
  });

  it('is null for items that are not in the queue', () => {
    expect(resolveJellyfinQueuePosition(queue, null)).toBeNull();
    expect(resolveJellyfinQueuePosition([], A)).toBeNull();
  });

  it('falls back to the index the bridge captured when the id is unknown', () => {
    expect(resolveJellyfinQueuePosition(queue, 'ffffffffffffffffffffffffffffffff', 1)).toEqual({
      index: 1,
      total: 3,
    });
    // The id match always wins over a stale captured index.
    expect(resolveJellyfinQueuePosition(queue, A, 2)).toEqual({ index: 0, total: 3 });
    // An out-of-range captured index is ignored rather than trusted.
    expect(resolveJellyfinQueuePosition(queue, 'ffffffffffffffffffffffffffffffff', 9)).toBeNull();
    expect(resolveJellyfinQueuePosition(queue, 'ffffffffffffffffffffffffffffffff', null)).toBeNull();
  });
});

describe('adjacentJellyfinQueueItem with a captured index', () => {
  it('walks from the captured index when the id lookup fails', () => {
    expect(adjacentJellyfinQueueItem(queue, 'ffffffffffffffffffffffffffffffff', 'next', 0)?.item.name).toBe(
      'Second Episode',
    );
    expect(adjacentJellyfinQueueItem(queue, 'ffffffffffffffffffffffffffffffff', 'next', 2)).toBeNull();
  });
});

describe('jellyfinQueueItemLabel', () => {
  it('prefers the item name', () => {
    expect(jellyfinQueueItemLabel(queue[0])).toBe('First Movie');
  });

  it('falls back to S/E numbers, then the series name, then the caller fallback', () => {
    expect(jellyfinQueueItemLabel(item({ id: A, parentIndexNumber: 2, indexNumber: 3 }))).toBe('S2 E3');
    expect(jellyfinQueueItemLabel(item({ id: A, indexNumber: 4 }))).toBe('E4');
    expect(jellyfinQueueItemLabel(item({ id: A, seriesName: 'Some Show' }))).toBe('Some Show');
    expect(jellyfinQueueItemLabel(item({ id: A }), 'Loading…')).toBe('Loading…');
    expect(jellyfinQueueItemLabel(null, 'Loading…')).toBe('Loading…');
  });
});
