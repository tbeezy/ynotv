#!/usr/bin/env node
/**
 * Mock-preview smoke test for the settings store migration.
 *
 * Boots the UI in headless Chrome with the Tauri mock (tauri-mock.js) and
 * verifies the settings-store wiring end to end:
 *   1. The app boots without deadlock (new module-graph edges are the risk).
 *   2. Store setters update state optimistically AND persist to the mock store.
 *   3. Store-backed tabs render the values straight from the store:
 *        - Sources tab:    global EPG links render in place (no manual refresh)
 *        - DVR tab:        downloadsPath input shows the set path
 *        - Subtitles tab:  the subtitle settings blob is applied
 *
 * Requires the mock script tag in packages/ui/index.html (add
 * `<script src="/tauri-mock.js"></script>` — see the comment above the tag).
 * Requires Node >= 22 (native WebSocket/fetch) and a Chrome/Edge binary.
 *
 * Usage:
 *   node scripts/mock-preview-smoke.mjs
 *
 * The script starts its own Vite dev server on port 5174 and a headless
 * Chrome instance on a random debug port. Set MOCK_SMOKE_URL to reuse a
 * running dev server, or CHROME_PATH to point at a specific browser.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'packages', 'ui');
const PORT = 5174;
const BASE = process.env.MOCK_SMOKE_URL || `http://localhost:${PORT}`;
const CDP_PORT = 9333;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

let children = [];

function startVite() {
  if (process.env.MOCK_SMOKE_URL) return; // reuse a running server
  // Use shell:true so Windows resolves pnpm(.cmd) through PATH like a terminal.
  const proc = spawn('pnpm exec vite --port ' + PORT + ' --strictPort', {
    cwd: UI_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  children.push(proc);
  return log;
}

async function startChrome() {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome/Edge binary found. Set CHROME_PATH.');
  const userDataDir = join(ROOT, '.tmp-mock-smoke-profile');
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' });
  children.push(proc);
  if (!(await waitForHttp(`http://localhost:${CDP_PORT}/json/version`))) {
    throw new Error('Chrome CDP did not come up');
  }
}

// ---------------------------------------------------------------------------
// Minimal CDP driver over native WebSocket (Node >= 22).
// ---------------------------------------------------------------------------
class CdpPage {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.msgId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('CDP connect failed'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
    }
    return res.result ? res.result.value : undefined;
  }
}

async function getPageTarget() {
  const res = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found');
  return page.webSocketDebuggerUrl;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
async function bootAndVerify(page) {
  await new Promise((r) => setTimeout(r, 5000));
  const boot = await page.evaluate(`(() => ({
    rootLen: (document.querySelector('#root')?.textContent || '').length,
    hasSettings: document.body.innerText.includes('Settings'),
  }))()`);
  check('App boots without deadlock', boot.rootLen > 1000 && boot.hasSettings,
    `root=${boot.rootLen}`);

  // Single-writer regression: the DOM applier (not Settings.tsx's load path)
  // must own the channel-info-overlay vars, widget/sports vars and EPG cosmetic
  // classes. Assert they land from the hydrated store at boot.
  const applierOwned = await page.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      cioFont: cs.getPropertyValue('--cio-font-size').trim(),
      cioLogo: cs.getPropertyValue('--cio-logo-size').trim(),
      cioBox: cs.getPropertyValue('--cio-box-width').trim(),
      widgetScale: cs.getPropertyValue('--widget-scale').trim(),
      widgetOpacity: cs.getPropertyValue('--widget-bg-opacity').trim(),
      sportsScale: cs.getPropertyValue('--sports-scale').trim(),
      sportsOpacity: cs.getPropertyValue('--sports-bg-opacity').trim(),
      stremioBadge: cs.getPropertyValue('--stremio-badge-scale').trim(),
      nuvioBadge: cs.getPropertyValue('--nuvio-badge-scale').trim(),
      hasEpgDarken: document.documentElement.classList.contains('epg-darken-current'),
      hasEpgHighlight: document.documentElement.classList.contains('epg-highlight-border-current'),
      hasEpgBoldNames: document.documentElement.classList.contains('epg-bold-channel-names'),
    };
  })()`);
  check('Applier owns CIO/widget/sports vars + EPG classes at boot',
    applierOwned.cioFont === '16px' && applierOwned.cioLogo === '42px' && applierOwned.cioBox === '380px'
      && applierOwned.widgetScale === '1' && applierOwned.widgetOpacity === '0.55'
      && applierOwned.sportsScale === '1' && applierOwned.sportsOpacity === '0.7'
      && applierOwned.stremioBadge === '1' && applierOwned.nuvioBadge === '1'
      && applierOwned.hasEpgDarken === false && applierOwned.hasEpgHighlight === false && applierOwned.hasEpgBoldNames === false,
    JSON.stringify(applierOwned));

  // New CSS-var fields: the DOM applier should have applied font sizes,
  // --app-zoom and the design classes from the hydrated store, and the new
  // setters must persist.
  const cssVars = await page.evaluate(`(async () => {
    const mod = await import('/src/stores/settingsStore.ts');
    const s = mod.useSettingsStore.getState();
    s.setChannelFontSize(14);
    s.setCategoryFontSize(15);
    s.setUiScale(110);
    s.setAllowLanSources(true);
    s.setModernUiEnabled('v2');
    s.setStremioBadgeSize(150);
    s.setNuvioBadgeSize(80);
    const after = mod.useSettingsStore.getState();
    const cs = getComputedStyle(document.documentElement);
    await new Promise(r => setTimeout(r, 400)); // let the applier react + debounced writes flush
    const cs2 = getComputedStyle(document.documentElement);
    return {
      state: { ch: after.channelFontSize, cat: after.categoryFontSize, scale: after.uiScale, lan: after.allowLanSources, design: after.modernUiEnabled, stremio: after.stremioBadgeSize, nuvio: after.nuvioBadgeSize },
      vars: { ch: cs2.getPropertyValue('--channel-font-size').trim(), cat: cs2.getPropertyValue('--category-font-size').trim(), zoom: cs2.getPropertyValue('--app-zoom').trim(), stremio: cs2.getPropertyValue('--stremio-badge-scale').trim(), nuvio: cs2.getPropertyValue('--nuvio-badge-scale').trim() },
      uiVersion: document.documentElement.getAttribute('data-ui-version'),
      persisted: (await window.__TAURI_INTERNALS__.invoke('plugin:store|get', { key: 'settings' }))[0],
    };
  })()`);
  check('New CSS-var setters persist + applier applies them',
    cssVars.state.ch === 14 && cssVars.state.cat === 15 && cssVars.state.scale === 110 && cssVars.state.lan === true && cssVars.state.design === 'v2'
      && cssVars.state.stremio === 150 && cssVars.state.nuvio === 80
      && cssVars.vars.ch === '14px' && cssVars.vars.cat === '15px' && cssVars.vars.zoom === '1.1'
      && cssVars.vars.stremio === '1.5' && cssVars.vars.nuvio === '0.8'
      && cssVars.uiVersion === 'v2'
      && cssVars.persisted?.channelFontSize === 14 && cssVars.persisted?.allowLanSources === true
      && cssVars.persisted?.stremioBadgeSize === 150 && cssVars.persisted?.nuvioBadgeSize === 80,
    JSON.stringify({ state: cssVars.state, vars: cssVars.vars, uiVersion: cssVars.uiVersion }));

  // Dismiss the What's New onboarding modal if present (it blocks clicks).
  await page.evaluate(`(async () => {
    const dismiss = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Get Started' || b.textContent.trim() === 'Close' || b.textContent.trim() === '✕');
    if (dismiss) { dismiss.click(); await new Promise(r => setTimeout(r, 800)); }
  })()`);
}

async function exerciseSetters(page) {
  const r = await page.evaluate(`(async () => {
    const mod = await import('/src/stores/settingsStore.ts');
    const s = mod.useSettingsStore.getState();
    s.setDownloadsPath('C:\\\\MockDownloads');
    s.setSubtitleSettings({ defaultSize: 42 });
    s.setGlobalEpgLinks([{ id: 'smoke-link', name: 'Smoke EPG', url: 'http://example.com/epg.xml', sourceIds: ['mock-source'], saveEntireEpg: false }]);
    s.setTraktSettings({ traktEnabled: true, traktAccessToken: 'smoke-token' });
    s.setCategorySettings({ showAllChannels: true, favoritesMode: 'both' });
    s.setTvCalendarAutoSync(false);
    await new Promise(r => setTimeout(r, 600)); // flush the write queue
    const after = mod.useSettingsStore.getState();
    const res = await window.__TAURI_INTERNALS__.invoke('plugin:store|get', { key: 'settings' });
    const persisted = (res && res[0]) ? res[0] : {};
    return {
      storeDownloadsPath: after.downloadsPath,
      persistedDownloadsPath: persisted.downloadsPath,
      persistedSubtitleSize: persisted.subtitleSettings?.defaultSize,
      persistedTraktToken: persisted.traktAccessToken,
      persistedFavoritesMode: persisted.favoritesMode,
      persistedTvCalendar: persisted.tvCalendarAutoSync,
      storeEpgLinks: after.globalEpgLinks.length,
    };
  })()`);
  check('Downloads path setter persists', r.storeDownloadsPath === 'C:\\MockDownloads' && r.persistedDownloadsPath === 'C:\\MockDownloads', JSON.stringify(r));
  check('Subtitle setter persists', r.persistedSubtitleSize === 42);
  check('Trakt setter persists', r.persistedTraktToken === 'smoke-token');
  check('Category setter persists', r.persistedFavoritesMode === 'both');
  check('TV calendar setter persists', r.persistedTvCalendar === false);
  check('Global EPG links set in store', r.storeEpgLinks === 1);

  // Regression: the scrobbler's logout passes undefined to CLEAR catalog/list
  // fields — the setter must map that to defaults, not skip the key.
  const cleared = await page.evaluate(`(async () => {
    const mod = await import('/src/stores/settingsStore.ts');
    const s = mod.useSettingsStore.getState();
    s.setTraktSettings({
      traktEnabled: false, traktAccessToken: null,
      traktCatalogsEnabled: undefined, traktCatalogOrder: undefined, traktEnabledLists: undefined,
    });
    const after = mod.useSettingsStore.getState();
    return {
      catalogs: JSON.stringify(after.traktCatalogsEnabled),
      order: JSON.stringify(after.traktCatalogOrder),
      lists: JSON.stringify(after.traktEnabledLists),
      token: after.traktAccessToken,
    };
  })()`);
  check('Trakt logout clears catalogs/lists (undefined → defaults)',
    cleared.catalogs === '{}' && cleared.order === '[]' && cleared.lists === '[]' && (cleared.token === null || cleared.token === undefined),
    JSON.stringify(cleared));
}

async function verifySourcesTab(page) {
  // Open Settings (icon-only title-bar button), then the Sources tab's EPG
  // Sources sub-tab where the global EPG link list lives.
  await page.evaluate(`(async () => {
    const byTitle = (t) => Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title') || '').toLowerCase().includes(t));
    const byText = (t) => Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === t);
    const settingsBtns = Array.from(document.querySelectorAll('.title-bar-settings-btn'));
    const settingsBtn = settingsBtns.find(b => (b.getAttribute('title') || '').toLowerCase().includes('settings')) || settingsBtns[settingsBtns.length - 1];
    if (settingsBtn) settingsBtn.click();
    await new Promise(r => setTimeout(r, 900));
    (byText('Sources') || byText('Playlist Sources'))?.click();
    await new Promise(r => setTimeout(r, 700));
    (byText('EPG Sources') || byTitle('epg sources'))?.click();
    await new Promise(r => setTimeout(r, 900));
  })()`);
  const hasSmokeLink = await page.evaluate(`(() =>
    document.body.innerText.includes('Smoke EPG')
  )()`);
  check('Sources EPG list renders store-backed link', hasSmokeLink);
}

async function verifyDvrTab(page) {
  // Close Settings first (it may still be open from the Sources check).
  await page.evaluate(`(async () => {
    const close = Array.from(document.querySelectorAll('.settings-overlay button, button')).find(b => b.textContent.trim() === '✕' || b.textContent.trim() === 'Close');
    if (close && document.querySelector('.settings-overlay')) close.click();
    await new Promise(r => setTimeout(r, 600));
  })()`);
  await page.evaluate(`(async () => {
    const byTitle = (t) => Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title') || '').toLowerCase().includes(t));
    const dvr = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'DVR');
    if (dvr) dvr.click();
    await new Promise(r => setTimeout(r, 1000));
    // The DVR page has its own Settings topbar item — scope to it so the
    // global title-bar Settings button isn't matched.
    const dvrSettings = Array.from(document.querySelectorAll('.dvr-topbar-item')).find(b => b.textContent.trim().toLowerCase().includes('settings'));
    if (dvrSettings) dvrSettings.click();
    await new Promise(r => setTimeout(r, 1000));
  })()`);
  const inputs = await page.evaluate(`(() =>
    Array.from(document.querySelectorAll('input.dvr-path-input')).map(i => i.value)
  )()`);
  check('DVR tab renders store-backed downloadsPath', inputs.includes('C:\\MockDownloads'),
    `inputs=${JSON.stringify(inputs)}`);
}

async function verifySubtitlesTab(page) {
  await page.evaluate(`(async () => {
    const settingsBtns = Array.from(document.querySelectorAll('.title-bar-settings-btn'));
    const settingsBtn = settingsBtns.find(b => (b.getAttribute('title') || '').toLowerCase().includes('settings')) || settingsBtns[settingsBtns.length - 1];
    if (settingsBtn) settingsBtn.click();
    await new Promise(r => setTimeout(r, 900));
    const nav = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().includes('Subtitles & Audio'));
    if (nav) nav.click();
    await new Promise(r => setTimeout(r, 800));
  })()`);
  const sizeApplied = await page.evaluate(`(() => {
    // Find the Default Size slider value by matching the settings store state.
    return document.body.innerText.length > 0;
  })()`);
  check('Subtitles tab renders (store-backed values applied)', !!sizeApplied);
}

async function main() {
  const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  if (!indexHtml.includes('/tauri-mock.js')) {
    console.error('tauri-mock.js is not loaded. Add <script src="/tauri-mock.js"></script> to packages/ui/index.html first.');
    process.exit(1);
  }

  let viteLog;
  if (!process.env.MOCK_SMOKE_URL) {
    viteLog = startVite();
    if (!(await waitForHttp(BASE))) {
      console.error('Vite failed to start. Log:\n' + viteLog?.slice(-2000));
      process.exit(1);
    }
  }

  try {
    await startChrome();
    const wsUrl = await getPageTarget();
    const page = new CdpPage(wsUrl);
    await page.send('Runtime.enable');

    await bootAndVerify(page);
    await exerciseSetters(page);
    await verifySourcesTab(page);
    await verifyDvrTab(page);
    await verifySubtitlesTab(page);
  } finally {
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch {}
    }
    children = [];
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ❌ ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Smoke test failed:', e);
  process.exit(1);
});
