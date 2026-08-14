import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the KV service so tests drive hydration directly without Tauri/SQLite.
vi.mock('../../services/appKv', () => ({
  readAppKvSync: vi.fn(() => null),
  loadAppKv: vi.fn(async () => null),
  writeAppKv: vi.fn(async () => {}),
  migrateFromLocalStorage: vi.fn(async () => {}),
}));
vi.mock('../../services/tauri-bridge', () => ({
  registerOnAppClose: vi.fn(),
}));

import { bindStoreToKv } from '../persistToKv';
import { sanitizeLibraryValue, sanitizeWatchState, type LibraryKvValue, type WatchKvValue } from '../kvSchemas';
import { readAppKvSync, loadAppKv } from '../../services/appKv';

const libItem = { id: 'tt1234567', type: 'movie', name: 'Test Movie' };

// Raw strings in every shape the `stremio-library` key has had.
const LEGACY_LIB_RAW = JSON.stringify({ state: { library: [libItem] }, version: 0 });
const CURRENT_LIB_RAW = JSON.stringify({ library: [libItem] });
const BARE_LIB_RAW = JSON.stringify([libItem]);
const MISMATCHED_LIB_RAW = JSON.stringify({ library: { not: 'an array' } });
const GARBAGE_LIB_RAW = JSON.stringify({ totally: 'wrong shape' });

const watchEntry = { metaId: 'tt1234567', type: 'movie', name: 'Test Movie', progressFraction: 0.5, watchedAt: 1700000000000 };
const LEGACY_WATCH_RAW = JSON.stringify({ state: { history: [watchEntry], episodeProgress: { v1: { videoId: 'v1' } } }, version: 0 });
const CURRENT_WATCH_RAW = JSON.stringify({ history: [watchEntry], episodeProgress: { v1: { videoId: 'v1' } } });
const BARE_WATCH_RAW = JSON.stringify([watchEntry]);

/** Drive a binding through both hydration paths and return what got applied. */
async function hydrate<T>(
  parse: (raw: string) => T,
  sanitize: (value: T) => T | null,
  bootstrapRaw: string | null,
  storedRaw: string | null
): Promise<Array<T | null>> {
  const applied: Array<T | null> = [];
  vi.mocked(readAppKvSync).mockReturnValue(bootstrapRaw);
  vi.mocked(loadAppKv).mockResolvedValue(storedRaw);
  const binding = bindStoreToKv<T>(
    'test-key',
    parse,
    (value) => void applied.push(value),
    (state) => JSON.stringify(state),
    () => null as T,
    () => () => {},
    sanitize
  );
  await binding.whenReady;
  return applied;
}

beforeEach(() => {
  vi.mocked(readAppKvSync).mockReset();
  vi.mocked(loadAppKv).mockReset();
  vi.mocked(readAppKvSync).mockReturnValue(null);
  vi.mocked(loadAppKv).mockResolvedValue(null);
});

describe('KV hydration schema layer', () => {
  it('never hydrates a non-array from the legacy zustand persist wrapper', async () => {
    const applied = await hydrate<LibraryKvValue>(
      (raw) => JSON.parse(raw),
      sanitizeLibraryValue,
      LEGACY_LIB_RAW,
      null
    );
    expect(applied).toEqual([{ library: [libItem] }]);
    expect(Array.isArray(applied[0]!.library)).toBe(true);
  });

  it('hydrates the current and bare-array shapes', async () => {
    const current = await hydrate<LibraryKvValue>((raw) => JSON.parse(raw), sanitizeLibraryValue, CURRENT_LIB_RAW, null);
    expect(current).toEqual([{ library: [libItem] }]);
    const bare = await hydrate<LibraryKvValue>((raw) => JSON.parse(raw), sanitizeLibraryValue, BARE_LIB_RAW, null);
    expect(bare).toEqual([{ library: [libItem] }]);
  });

  it('rejects mismatched shapes instead of hydrating them', async () => {
    const mismatched = await hydrate<LibraryKvValue>((raw) => JSON.parse(raw), sanitizeLibraryValue, MISMATCHED_LIB_RAW, null);
    expect(mismatched).toEqual([]); // nothing applied — store keeps its default

    const garbage = await hydrate<LibraryKvValue>((raw) => JSON.parse(raw), sanitizeLibraryValue, GARBAGE_LIB_RAW, null);
    expect(garbage).toEqual([]);
  });

  it('rejects malformed JSON without throwing', async () => {
    const applied = await hydrate<LibraryKvValue>((raw) => JSON.parse(raw), sanitizeLibraryValue, '{not json', null);
    expect(applied).toEqual([]);
  });

  it('hydrates from both the bootstrap and the authoritative store', async () => {
    const applied = await hydrate<LibraryKvValue>(
      (raw) => JSON.parse(raw),
      sanitizeLibraryValue,
      LEGACY_LIB_RAW,
      CURRENT_LIB_RAW
    );
    // Bootstrap applied first, then the authoritative SQLite copy.
    expect(applied).toHaveLength(2);
    expect(applied[0]).toEqual({ library: [libItem] });
    expect(applied[1]).toEqual({ library: [libItem] });
  });

  it('does not let a stale SQLite load stomp a change made before it resolved', async () => {
    const applied: Array<LibraryKvValue | null> = [];
    let onChangeCb: (() => void) | null = null;
    vi.mocked(readAppKvSync).mockReturnValue(null);
    vi.mocked(loadAppKv).mockResolvedValue(CURRENT_LIB_RAW);

    const binding = bindStoreToKv<LibraryKvValue>(
      'test-key',
      (raw) => JSON.parse(raw),
      (value) => void applied.push(value),
      (state) => JSON.stringify(state),
      () => null as unknown as LibraryKvValue,
      (fn) => {
        onChangeCb = fn;
        return () => {};
      },
      sanitizeLibraryValue
    );

    // A store change lands while the authoritative SQLite load is still in
    // flight — the newer in-memory state must win over the stale stored blob.
    onChangeCb!();
    await binding.whenReady;
    expect(applied).toEqual([]);
  });

  it('watch history: legacy wrapper, current, and bare-array all hydrate to an array', async () => {
    const legacy = await hydrate<WatchKvValue>((raw) => JSON.parse(raw), sanitizeWatchState, LEGACY_WATCH_RAW, null);
    expect(legacy).toEqual([{ history: [watchEntry], episodeProgress: { v1: { videoId: 'v1' } } }]);
    expect(Array.isArray(legacy[0]!.history)).toBe(true);

    const current = await hydrate<WatchKvValue>((raw) => JSON.parse(raw), sanitizeWatchState, CURRENT_WATCH_RAW, null);
    expect(current).toEqual([{ history: [watchEntry], episodeProgress: { v1: { videoId: 'v1' } } }]);

    const bare = await hydrate<WatchKvValue>((raw) => JSON.parse(raw), sanitizeWatchState, BARE_WATCH_RAW, null);
    expect(bare).toEqual([{ history: [watchEntry], episodeProgress: {} }]);
  });

  it('watch history: missing episodeProgress defaults to {} and bad shapes are rejected', async () => {
    const noProgress = await hydrate<WatchKvValue>(
      (raw) => JSON.parse(raw),
      sanitizeWatchState,
      JSON.stringify({ history: [watchEntry] }),
      null
    );
    expect(noProgress).toEqual([{ history: [watchEntry], episodeProgress: {} }]);

    const bad = await hydrate<WatchKvValue>(
      (raw) => JSON.parse(raw),
      sanitizeWatchState,
      JSON.stringify({ history: { not: 'an array' } }),
      null
    );
    expect(bad).toEqual([]);
  });
});

describe('sanitize functions (unit)', () => {
  it('sanitizeLibraryValue handles every historical shape', () => {
    expect(sanitizeLibraryValue(JSON.parse(LEGACY_LIB_RAW))).toEqual({ library: [libItem] });
    expect(sanitizeLibraryValue(JSON.parse(CURRENT_LIB_RAW))).toEqual({ library: [libItem] });
    expect(sanitizeLibraryValue(JSON.parse(BARE_LIB_RAW))).toEqual({ library: [libItem] });
    expect(sanitizeLibraryValue(JSON.parse(MISMATCHED_LIB_RAW))).toBeNull();
    expect(sanitizeLibraryValue(null)).toBeNull();
    expect(sanitizeLibraryValue('a string')).toBeNull();
    expect(sanitizeLibraryValue(42)).toBeNull();
  });

  it('sanitizeWatchState handles every historical shape', () => {
    expect(sanitizeWatchState(JSON.parse(LEGACY_WATCH_RAW))).toEqual({
      history: [watchEntry],
      episodeProgress: { v1: { videoId: 'v1' } },
    });
    expect(sanitizeWatchState(JSON.parse(CURRENT_WATCH_RAW))).toEqual({
      history: [watchEntry],
      episodeProgress: { v1: { videoId: 'v1' } },
    });
    expect(sanitizeWatchState(JSON.parse(BARE_WATCH_RAW))).toEqual({ history: [watchEntry], episodeProgress: {} });
    expect(sanitizeWatchState({ history: null })).toBeNull();
  });
});
