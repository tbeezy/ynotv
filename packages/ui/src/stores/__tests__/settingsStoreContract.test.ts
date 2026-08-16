import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useSettingsStore } from '../settingsStore';

/**
 * Consumer contract test for the settings store.
 *
 * Every consumer selects settings with either a slice selector
 * (`useSettingsStore((s) => s.foo)`) or a one-off `getState()` read
 * (`useSettingsStore.getState().foo`). A typo in one of those keys is a
 * runtime `undefined` — tsc can't catch it because zustand's selector
 * parameter is untyped at the call site (`(s: SettingsState) => unknown`).
 *
 * This test statically scans every non-test source file for those two forms
 * and asserts each extracted key is a real key of the store's state, so a
 * misspelled selector fails CI instead of silently breaking a component.
 */
const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walkSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) && !/\.d\.ts$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Selector forms we support: `(s) => s.foo` and `.getState().foo`. */
const SLICE_SELECTOR_RE = /useSettingsStore\(\(s\)\s*=>\s*s\.([A-Za-z0-9_]+)/g;
const GET_STATE_RE = /useSettingsStore\.getState\(\)\.([A-Za-z0-9_]+)/g;

function extractKeys(source: string, re: RegExp): string[] {
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

describe('useSettingsStore consumer contract', () => {
  const storeKeys = new Set<string>(Object.keys(useSettingsStore.getState()));

  it('exposes subtitleSettings + setter (regression for the subtitle migration)', () => {
    expect(storeKeys.has('subtitleSettings')).toBe(true);
    expect(storeKeys.has('setSubtitleSettings')).toBe(true);
  });

  const files = walkSourceFiles(SRC_DIR);
  const consumers = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return src.includes('useSettingsStore');
  });

  it('finds consumers to scan', () => {
    expect(consumers.length).toBeGreaterThan(10);
  });

  for (const file of consumers) {
    // SRC_DIR is a platform path (\ on Windows); normalize both sides so the
    // test names show a clean relative path.
    const relative = file.replace(/\\/g, '/').replace(SRC_DIR.replace(/\\/g, '/') + '/', '');
    const src = readFileSync(file, 'utf8');
    const sliceKeys = extractKeys(src, SLICE_SELECTOR_RE);
    const getStateKeys = extractKeys(src, GET_STATE_RE);
    const allKeys = [...sliceKeys, ...getStateKeys];
    const missing = [...new Set(allKeys)].filter((k) => !storeKeys.has(k));

    it(`selectors in ${relative} resolve against SettingsState`, () => {
      expect(missing).toEqual([]);
    });
  }
});
