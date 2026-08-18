import { db } from '../db';

/**
 * SQLite-backed key/value persistence for UI stores (Stremio library, watch
 * history, ...). Replaces localStorage for these stores so their size never
 * competes for the WebView2 localStorage quota (~10 MB) that power users can
 * exhaust.
 *
 * How it keeps the UI synchronous:
 * - First load: state is bootstrapped synchronously from localStorage (the old
 *   location) so first paint has data immediately.
 * - In parallel, the authoritative copy is loaded from SQLite and merged; once
 *   loaded, writes go to SQLite and the localStorage copy is dropped.
 */

const memoryCache = new Map<string, string>();
let migrationPromise: Promise<void> | null = null;

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    console.warn(`[appKv] Failed to read localStorage key "${key}":`, e);
    return null;
  }
}

function removeLocalStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {
    console.warn(`[appKv] Failed to remove localStorage key "${key}":`, e);
  }
}

/**
 * Migrate the old localStorage value for `key` into SQLite (if not already
 * done), then remove the localStorage copy. Idempotent and safe to call
 * repeatedly.
 */
export function migrateFromLocalStorage(key: string): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const entries = await db.appKv.toArray();
      for (const entry of entries) {
        memoryCache.set(entry.key, entry.value);
      }
    })().catch((e) => {
      console.warn('[appKv] Failed to load persisted values:', e);
      migrationPromise = null; // allow retry
    });
  }
  return migrationPromise.then(async () => {
    // Merge any localStorage value still present (fresh data written before
    // this migration ran, e.g. by an older version of the app).
    const raw = readLocalStorage(key);
    if (raw !== null && raw !== memoryCache.get(key)) {
      await db.appKv.put({ key, value: raw });
      memoryCache.set(key, raw);
    }
    removeLocalStorage(key);
  });
}

/** Write a value for `key` to SQLite (and the sync memory cache). */
export async function writeAppKv(key: string, value: string): Promise<void> {
  memoryCache.set(key, value);
  try {
    await db.appKv.put({ key, value });
  } catch (e) {
    console.warn(`[appKv] Failed to persist "${key}":`, e);
  }
}

/**
 * Synchronously read the current value for `key`. Returns the in-memory value
 * if present, otherwise the old localStorage copy (bootstrapping), otherwise
 * null. Prefer this only for first-paint seeding; use `loadAppKv` for the
 * authoritative value.
 */
export function readAppKvSync(key: string): string | null {
  if (memoryCache.has(key)) return memoryCache.get(key)!;
  return readLocalStorage(key);
}

/** Load the authoritative value for `key` from SQLite (falling back to localStorage). */
export async function loadAppKv(key: string): Promise<string | null> {
  await migrateFromLocalStorage(key);
  if (memoryCache.has(key)) return memoryCache.get(key)!;
  try {
    const row = await db.appKv.get(key);
    if (row) {
      memoryCache.set(key, row.value);
      return row.value;
    }
  } catch (e) {
    console.warn(`[appKv] Failed to read "${key}":`, e);
  }
  return null;
}

