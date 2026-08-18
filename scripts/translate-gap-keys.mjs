// Translate the genuine translation gaps flagged by check-locales.mjs
// (sentences / grammar-bearing strings that were missed, NOT loanwords).
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'packages/ui/src/i18n/locales';
const en = JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8'));

const KEYS = [
  'stremio.local',
  'settings.failover.autoClusterTitle',
  'settings.strem.badgePastePlaceholder',
  'vod.batchReview',
  'stremio.profileNotFound',
  'stremio.backToEpisodes',
  'stremio.viewMember',
  'stremio.searchVideos',
  'stremio.watchedLabel',
  'stremio.addonAlreadyInstalled',
  'stremio.loginFailed',
  'stremio.syncFailed',
  'common.syncingBatchWithPrefix',
  'settings.theme.copied',
  'epg.description',
  'settings.about.documentation',
  'sports.tabs.leaders',
  'sports.filterSuggestions',
  'updates.later',
  'vod.itemCount_one',
  'vod.itemCount_other',
  'vod.itemCount_few',
  'vod.itemCount_many',
  'vod.itemCount_two',
  'vod.itemCount_zero',
];

function getPath(o, key) {
  return key.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
}
function setPath(o, key, value) {
  const parts = key.split('.');
  let x = o;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (x[parts[i]] == null) x[parts[i]] = {};
    x = x[parts[i]];
  }
  x[parts[parts.length - 1]] = value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function translate(text, target) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json[0].map((seg) => seg[0]).join('');
}
function protect(text) {
  const names = [...text.matchAll(/\{\{([a-zA-Z]+)\}\}/g)].map((m) => m[1]);
  let i = 0;
  const body = text.replace(/\{\{([a-zA-Z]+)\}\}/g, () => `@@P${i++}@@`);
  return { body, names };
}
function restore(body, names) {
  let out = body;
  names.forEach((name, i) => {
    out = out
      .replace(new RegExp(`@@\\s*[PПpп]\\s*${i}\\s*@@`, 'g'), `{{${name}}}`)
      .replace(new RegExp(`@@[PПpп]${i}@@`, 'g'), `{{${name}}}`);
  });
  return out;
}

const langs = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'en.json');
const jobs = [];
for (const lang of langs) {
  const file = path.join(DIR, lang);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pending = KEYS.filter((k) => getPath(doc, k) === getPath(en, k));
  if (pending.length > 0) jobs.push({ lang, file, doc, pending });
}

const CONCURRENCY = 4;
let idx = 0;
let failures = 0;
async function worker() {
  while (true) {
    const j = jobs[idx++];
    if (!j) return;
    const { lang, file, doc, pending } = j;
    const langCode = lang.replace(/\.json$/, '');
    let changed = false;
    for (const key of pending) {
      const enVal = getPath(en, key);
      const { body, names } = protect(enVal);
      try {
        const translated = await translate(body, langCode);
        const restored = restore(translated, names);
        const missing = names.filter((n) => !restored.includes(`{{${n}}}`));
        if (missing.length > 0) {
          console.error(`!! ${lang} ${key}: missing placeholders ${missing.join(',')} — kept English`);
          failures += 1;
          continue;
        }
        setPath(doc, key, restored);
        changed = true;
      } catch (e) {
        console.error(`!! ${lang} ${key}: ${e.message}`);
        failures += 1;
        continue;
      }
      await sleep(50);
    }
    if (changed) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
          break;
        } catch (e) {
          if (attempt === 9) throw e;
          await sleep(300 + attempt * 200);
        }
      }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const total = jobs.reduce((a, j) => a + j.pending.length, 0);
console.log(`translated ${total - failures}/${total} (${failures} failures)`);
