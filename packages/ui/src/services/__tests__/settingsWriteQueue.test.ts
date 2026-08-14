/**
 * Regression tests for the serialized write queue in tauri-bridge.ts.
 *
 * Bridge.updateSettings / saveSource / deleteSource all do a non-atomic
 * get → merge → set → save cycle. Before the queue, two concurrent writes
 * could interleave: both read the pre-merge snapshot, then the last one to
 * write back persisted its stale snapshot, silently reverting the other
 * write (the epgView reset-to-'traditional' bug).
 *
 * The fake below mimics the Rust plugin-store backend with artificial
 * latency so the old interleaving would be deterministic; the queue must
 * serialize the full read-modify-write cycle instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fake plugin-store backend ────────────────────────────────────────────────
// Mirrors the Rust semantics: `get` returns [value, exists], `set` mutates the
// in-memory cache, `save` persists (no-op here). Artificial latency on get/set
// makes the pre-queue race deterministic.
const { mockInvoke, backends, pathToRid } = (() => {
  const backends = new Map<number, Map<string, unknown>>();
  const pathToRid = new Map<string, number>();
  let nextRid = 1;

  const tick = () => new Promise((r) => setTimeout(r, 5));

  const mockInvoke = vi.fn(
    async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
      switch (cmd) {
        case 'plugin:store|load': {
          const rid = nextRid++;
          backends.set(rid, new Map());
          pathToRid.set(String(args.path), rid);
          return rid;
        }
        case 'plugin:store|get': {
          await tick();
          const b = backends.get(Number(args.rid))!;
          const key = String(args.key);
          return [b.get(key), b.has(key)];
        }
        case 'plugin:store|set': {
          await tick();
          backends.get(Number(args.rid))!.set(String(args.key), args.value);
          return null;
        }
        case 'plugin:store|save':
        case 'plugin:store|delete':
          await tick();
          return null;
        default:
          throw new Error(`unexpected command: ${cmd}`);
      }
    },
  );

  return { mockInvoke, backends, pathToRid };
})();

// @tauri-apps/api/core's `invoke` delegates to window.__TAURI_INTERNALS__.
// Provide it up front so the real invoke (and initPolyfills at module import)
// works against the fake backend.
Object.defineProperty(globalThis, 'window', {
  value: {
    __TAURI_INTERNALS__: {
      invoke: mockInvoke,
      transformCallback: () => 0,
    },
  },
  configurable: true,
  writable: true,
});

type BridgeModule = typeof import('../tauri-bridge');
let Bridge: BridgeModule['Bridge'];

beforeEach(async () => {
  backends.clear();
  pathToRid.clear();
  mockInvoke.mockClear();
  localStorage.clear();
  // Fresh module per test: getStore() caches a single store instance, and a
  // fresh backend was just created, so re-import to start clean.
  vi.resetModules();
  ({ Bridge } = await import('../tauri-bridge'));
});

describe('serialized settings write queue', () => {
  it('preserves both keys when updateSettings calls race', async () => {
    // Fire two partial updates without awaiting — the classic clobber pattern:
    // an epgView change racing a savedVolume write.
    const p1 = Bridge.updateSettings({ epgView: 'alternate' });
    const p2 = Bridge.updateSettings({ savedVolume: 42 });
    await Promise.all([p1, p2]);

    const settings = await Bridge.getSettings();
    expect(settings.data.epgView).toBe('alternate');
    expect(settings.data.savedVolume).toBe(42);
  });

  it('serializes later writes on top of earlier ones', async () => {
    await Bridge.updateSettings({ epgView: 'traditional' });
    const p1 = Bridge.updateSettings({ epgView: 'alternate' });
    const p2 = Bridge.updateSettings({ channelFontSize: 13 });
    await Promise.all([p1, p2]);

    const settings = await Bridge.getSettings();
    expect(settings.data.epgView).toBe('alternate');
    expect(settings.data.channelFontSize).toBe(13);
  });

  it('does not lose sources when saveSource calls race', async () => {
    const p1 = Bridge.saveSource({ id: 'a', name: 'First' });
    const p2 = Bridge.saveSource({ id: 'b', name: 'Second' });
    await Promise.all([p1, p2]);

    const sources = (await Bridge.getSources()).data as Array<{ id: string }>;
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps disk authoritative: getSettings does not merge localStorage', async () => {
    // Seed a stale localStorage blob that would have masked the disk store
    // under the old wholesale merge.
    localStorage.setItem('app-settings', JSON.stringify({ theme: 'stale-theme' }));

    await Bridge.updateSettings({ theme: 'dark-cyan' });
    const settings = await Bridge.getSettings();
    expect(settings.data.theme).toBe('dark-cyan');
  });

  it('mirrors updates to localStorage for synchronous hydration', async () => {
    await Bridge.updateSettings({ epgView: 'alternate' });
    const parsed = JSON.parse(localStorage.getItem('app-settings')!);
    expect(parsed.epgView).toBe('alternate');
  });
});
