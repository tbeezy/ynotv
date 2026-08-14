// Working-tree value-preservation audit: compares the uncommitted working tree
// against a git baseline (snapshots staged in .audit-base by the caller).
//   A. v3 dark: every old .modern-ui-v3 rule declaration preserved (resolved-
//      identical in the new rule, or covered by a token whose dark value
//      equals the old literal).
//   B. v3 light: same for light-gated rules using the token's light value.
//   C. v1/v2 base: base rules now consuming v3-only tokens must resolve (with
//      v3/v2 tokens removed) to the old base value.
//   D. token mutation: any token defined in both baseline and working tree must
//      have an identical value.
import fs from 'node:fs';
import path from 'node:path';

const baseDir = path.resolve(process.argv[2] || '.audit-base');
const readCss = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const uiDir = path.join(process.cwd(), 'packages/ui/src');
// Deleted v3 decls whose value is computed-identical to a base literal (the
// base keeps the shorter/older spelling, e.g. transition timing defaults).
const DELETED_V3_EQUIV = new Set(['opacity0.2sease']); // == base 'opacity 0.2s'
const changed = [
  'components/BackgroundContextMenu.css',
  'components/ChannelPanel.css',
  'components/CategoryStrip.css',
  'components/Settings.css',
  'components/settings/CategoryManager.css',
  'components/settings/ChannelManager.css',
  'components/sports/SportsHub.css',
  'components/sports/styles/GameDetail.css',
  'components/ProgramContextMenu.css',
  'components/stremio/StremioHome.css',
  'components/vod/AlphabetRail.css',
  'components/AdvancedSearchModal.css',
  'components/vod/HeroSection.css',
  'components/vod/HorizontalCarousel.css',
  'components/vod/MediaCard.css',
  'components/vod/MovieDetail.css',
  'components/vod/SeriesDetail.css',
  'styles/ModernV3.css',
  'styles/ModernV2.css',
  'light-theme-overrides.css',
];
const v3File = 'styles/ModernV3.css';
const v2File = 'styles/ModernV2.css';

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}
function parseRules(css) {
  const clean = stripComments(css);
  const rules = [];
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf('{', i);
    if (open === -1) break;
    const selector = clean.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') depth--;
      j++;
    }
    const body = clean.slice(open + 1, j - 1);
    i = j;
    if (!selector || selector.startsWith('@')) continue;
    const decls = [];
    const declRe = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
    let m;
    while ((m = declRe.exec(body))) {
      decls.push({ prop: m[1].trim().toLowerCase(), value: m[2].trim().replace(/!important$/, '').trim() });
    }
    rules.push({ selector: normSel(selector), decls, isV3: selector.includes('.modern-ui-v3'), isLight: selector.includes('[data-theme="light"]') });
  }
  return rules;
}
function normSel(s) {
  return s.replace(/\s+/g, ' ').trim();
}
const NAMED2HEX = { white: '#fff', black: '#000', red: '#f00' };
function norm(v) {
  let s = v.replace(/\s+/g, '').toLowerCase();
  s = s.replace(/\b(white|black|red)\b/g, m => NAMED2HEX[m]);
  return s;
}
function findVars(value) {
  const out = [];
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith('var(', i)) {
      let depth = 1;
      let j = i + 4;
      while (j < value.length && depth > 0) {
        if (value[j] === '(') depth++;
        else if (value[j] === ')') depth--;
        j++;
      }
      out.push({ start: i, end: j - 1, raw: value.slice(i, j) });
      i = j - 1;
    }
  }
  return out;
}
function topLevelComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) return i;
  }
  return -1;
}
function resolve(value, tokenMap, depth = 0) {
  if (depth > 10) return value;
  const vars = findVars(value);
  let out = value;
  for (const v of vars) {
    const inner = v.raw.slice(4, -1);
    const comma = topLevelComma(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fb = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    const def = tokenMap.get(name);
    let sub;
    if (def !== undefined) sub = resolve(def, tokenMap, depth + 1);
    else if (fb !== undefined) sub = resolve(fb, tokenMap, depth + 1);
    else sub = v.raw;
    out = out.split(v.raw).join(sub);
  }
  return out;
}

const fullMap = new Map();
const v3Dark = new Map();
const v3Light = new Map();
const firstDefFile = new Map();
function collectTokens(css, into, file) {
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = re.exec(css))) {
    if (!into.has(m[1])) into.set(m[1], m[2].trim());
    if (!firstDefFile.has(m[1])) firstDefFile.set(m[1], file);
  }
}
for (const rel of changed) {
  const css = readCss(path.join(uiDir, rel));
  collectTokens(css, fullMap, rel);
  if (rel === v3File) {
    const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(css))) {
      if (!v3Dark.has(m[1])) v3Dark.set(m[1], m[2].trim());
      v3Light.set(m[1], m[2].trim());
    }
  }
}
const v2Only = new Map();
if (fs.existsSync(path.join(uiDir, v2File))) {
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = re.exec(readCss(path.join(uiDir, v2File))))) {
    if (!v2Only.has(m[1])) v2Only.set(m[1], m[2].trim());
  }
}
const baseMap = new Map();
for (const [t, v] of fullMap) {
  const df = firstDefFile.get(t);
  if (df === v3File || df === v2File) continue;
  baseMap.set(t, v);
}

// Intentional, value-invisible token mutations — each one is REQUIRED by a
// de-stack/fold and changes no computed value (the old token value was either
// never visible — always overridden by the scoped rule it replaced — or only
// fed a base fallback that v1/v2 never reach because the token sheet isn't
// loaded). Kept explicit so a real accidental mutation can never hide behind
// them.
const INTENTIONAL_TOKEN_MUTATIONS = {
  '--sm-input-transition':
    'de-stack: old value (border-color 0.2s ease, ...) was always overridden by the .modern-ui-v3 .form-group input rule (all 0.2s ease); the deleted rule made the token the resolved source, so the token must now BE the v3 value',
};

console.log('=== D. TOKEN MUTATION (baseline vs working tree) ===');
let mut = 0;
for (const rel of changed) {
  const base = path.join(baseDir, rel.replace(/[\\/]/g, '_'));
  const cur = path.join(uiDir, rel);
  if (!fs.existsSync(base)) { console.log(`${rel}: NO BASELINE SNAPSHOT`); continue; }
  const oldMap = new Map();
  collectTokens(readCss(base), oldMap, rel);
  const newMap = new Map();
  collectTokens(readCss(cur), newMap, rel);
  for (const [t, v] of oldMap) {
    if (newMap.has(t) && newMap.get(t) !== v) {
      if (INTENTIONAL_TOKEN_MUTATIONS[t]) {
        console.log(`${t}: intentional (${INTENTIONAL_TOKEN_MUTATIONS[t]})`);
        continue;
      }
      mut++;
      console.log(`${t}: "${v}" -> "${newMap.get(t)}" (${rel})`);
    }
  }
}
console.log(mut === 0 ? 'OK — no token value mutations (only additions).' : `${mut} MUTATED`);

console.log('\n=== A/B. V3 RULE VALUE PRESERVATION (dark + light) ===');
const oldV3 = new Map();
const newV3 = new Map();
{
  const base = path.join(baseDir, v3File.replace(/[\\/]/g, '_'));
  for (const r of parseRules(readCss(base))) {
    if (!r.isV3) continue;
    if (!oldV3.has(r.selector)) oldV3.set(r.selector, { dark: [], light: [] });
    oldV3.get(r.selector)[r.isLight ? 'light' : 'dark'].push(...r.decls);
  }
  for (const r of parseRules(readCss(path.join(uiDir, v3File)))) {
    if (!r.isV3) continue;
    if (!newV3.has(r.selector)) newV3.set(r.selector, { dark: [], light: [] });
    newV3.get(r.selector)[r.isLight ? 'light' : 'dark'].push(...r.decls);
  }
}
// tokens defined in the working tree (used to verify folded-away v2 rules):
// every definition value (a token can be defined per-version, so first-wins
// would hide the v2 value of a token v3 redefines) plus base-rule literals
// and var() fallbacks, so geometry kept literal in the bases also counts.
const wtSurfaces = new Set();
const wtDeclValues = new Set();
for (const rel of changed) {
  const css = readCss(path.join(uiDir, rel));
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = re.exec(css))) wtSurfaces.add(norm(m[2]));
  for (const r of parseRules(css)) {
    for (const d of r.decls) {
      if (d.prop.startsWith('--')) continue;
      wtDeclValues.add(norm(d.value));
      if (r.isV3 || r.selector.includes('.modern-ui') || r.selector.includes('[data-theme="light"]')) continue;
      wtSurfaces.add(norm(d.value));
      for (const v of findVars(d.value)) {
        const inner = v.raw.slice(4, -1);
        const comma = topLevelComma(inner);
        const fb = comma === -1 ? undefined : inner.slice(comma + 1).trim();
        if (fb !== undefined) wtSurfaces.add(norm(fb));
      }
    }
  }
}

let mismatches = 0;
const dropped = [];
for (const [sel, buckets] of oldV3) {
  for (const theme of ['dark', 'light']) {
    const map = theme === 'dark' ? v3Dark : v3Light;
    const oldDecls = buckets[theme];
    if (!oldDecls.length) continue;
    const newDecls = new Map((newV3.get(sel) || { [theme]: [] })[theme].map(d => [d.prop, d.value]));
    for (const d of oldDecls) {
      if (d.prop.startsWith('--') && INTENTIONAL_TOKEN_MUTATIONS[d.prop]) continue;
      const nv = newDecls.get(d.prop);
      if (nv === undefined) {
        const lit = norm(resolve(d.value, map));
        let covered = false;
        for (const tv of (theme === 'dark' ? [...v3Dark.values()] : [...v3Light.values()])) {
          if (norm(resolve(tv, map)) === lit) { covered = true; break; }
        }
        if (!covered && !wtDeclValues.has(norm(d.value)) && !DELETED_V3_EQUIV.has(norm(d.value))) {
          dropped.push(`${theme} ${sel} { ${d.prop}: ${d.value} }`);
          mismatches++;
        }
        continue;
      }
      if (norm(resolve(d.value, map)) !== norm(resolve(nv, map))) {
        mismatches++;
        console.log(`${theme} ${sel} { ${d.prop}: "${d.value}" -> "${nv}" }`);
      }
    }
  }
}
console.log(dropped.length ? `DROPPED (deleted, not covered by token value):\n  ${dropped.join('\n  ')}` : 'no dropped v3 declarations');
console.log(mismatches === 0 ? 'OK — all v3 dark/light values preserved.' : `${mismatches} v3 mismatches`);

console.log('\n=== C. V1/V2 BASE PRESERVATION (base rules now tokenized) ===');
let baseIssues = 0;
for (const rel of changed) {
  if (rel === v3File) continue;
  const base = path.join(baseDir, rel.replace(/[\\/]/g, '_'));
  if (!fs.existsSync(base)) continue;
  const oldBySel = new Map();
  for (const r of parseRules(readCss(base))) {
    if (!oldBySel.has(r.selector)) oldBySel.set(r.selector, []);
    oldBySel.get(r.selector).push(new Map(r.decls.map(d => [d.prop, d.value])));
  }
  const newBySel = new Map();
  for (const r of parseRules(readCss(path.join(uiDir, rel)))) {
    if (!newBySel.has(r.selector)) newBySel.set(r.selector, []);
    newBySel.get(r.selector).push(new Map(r.decls.map(d => [d.prop, d.value])));
  }
  for (const [sel, oldList] of oldBySel) {
    const newList = newBySel.get(sel) || [];
    for (let i = 0; i < oldList.length; i++) {
      const oldDecls = oldList[i];
      const newDecls = newList[i];
      if (!newDecls) {
        // A deleted rule is OK when every old surface value survives in the
        // working tree as a token definition, a base-rule literal, or a var()
        // fallback (the v2 shared-look fold: surfaces -> tokens, identical
        // geometry stays literal in the bases).
        const oldVals = [...oldDecls.values()];
        const allCovered = oldVals.every(v => wtSurfaces.has(norm(v)) || wtDeclValues.has(norm(v)));
        if (!allCovered) {
          const uncovered = oldVals.filter(v => !wtSurfaces.has(norm(v)) && !wtDeclValues.has(norm(v)));
          baseIssues++;
          console.log(`${rel} ${sel} — DELETED, values not covered by any token/base: ${uncovered.join(', ')}`);
        }
        continue;
      }
      for (const [prop, oldVal] of oldDecls) {
        const nv = newDecls.get(prop);
        if (nv === undefined || nv === oldVal) continue;
        const oldN = norm(resolve(oldVal, baseMap));
        const newN = norm(resolve(nv, baseMap));
        if (oldN === newN) continue;
        if (!nv.includes('var(')) {
          baseIssues++;
          console.log(`${rel} ${sel} { ${prop}: "${oldVal}" -> "${nv}" } (literal change, no token)`);
          continue;
        }
        baseIssues++;
        console.log(`${rel} ${sel} { ${prop}: "${oldVal}" -> "${nv}" }  resolved: "${oldN}" vs "${newN}"`);
      }
    }
  }
}
console.log(baseIssues === 0 ? 'OK — all v1/v2 base values preserved.' : `${baseIssues} base issues`);

console.log('\n=== E. WIRING (v3 rule tokens defined; light rules have light values) ===');
let wire = 0;
for (const r of parseRules(readCss(path.join(uiDir, v3File)))) {
  if (!r.isV3) continue;
  const map = r.isLight ? v3Light : v3Dark;
  for (const d of r.decls) {
    if (d.prop.startsWith('--')) continue;
    for (const v of findVars(d.value)) {
      const inner = v.raw.slice(4, -1);
      const comma = topLevelComma(inner);
      const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      if (!name.startsWith('--')) continue;
      if (!fullMap.has(name)) continue;
      // v2-defined tokens are valid for v3 rules: v3 loads ModernV2.css too.
      if (v2Only.has(name)) continue;
      if (!map.has(name)) {
        wire++;
        console.log(`${r.selector} { ${d.prop}: var(${name}) } — defined but not in ${r.isLight ? 'light' : 'dark'} map`);
      }
    }
  }
}
console.log(wire === 0 ? 'OK — all v3 rule tokens defined.' : `${wire} wiring issues`);

const fail = mut > 0 || mismatches > 0 || baseIssues > 0 || wire > 0;
console.log(`\nAUDIT RESULT: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
