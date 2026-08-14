// De-stack redundancy check: flags `.modern-ui-v3` scoped rules in
// ModernV3.css whose `var(--x, F)` fallback exactly equals one of `--x`'s
// defined values in the same file. Such a rule adds nothing over a base
// consumer that resolves the same token — it can be deleted (de-stacked) once
// the base consumes the token, and its !important disappears.
//
// A rule can be KEPT intentionally — it is load-bearing when a higher-
// specificity sheet (themes.css `[data-theme^="dark-"]`, ModernThemeBase
// light, the light sheet) would override the base consumer, or when the base
// consumes a *different* token for the same property. Keep those by putting
// the annotation directly above the rule:
//
//     /* @de-stack-protected: themes.css [data-theme^="dark-"] recolors this
//        per-accent at higher specificity than the base */
//
// Protected rules are reported as notes but do not fail the check.
//
// Tokens defined outside ModernV3.css (e.g. --accent-primary, --surface-*)
// are not resolved — only tokens defined in this file are compared, matching
// the fold's contract ("token's defined value" = the v3 token block). A
// fallback matching ANY definition (dark or light) of the token is flagged:
// it proves the fallback is redundant in at least one context.
//
// Exit code 1 when an unprotected redundant rule is found, so it can run in CI.
//
// A curated baseline (de-stack-baseline.json) lists load-bearing rules whose
// fallback == token but which cannot move to a base (themes.css dark-*/
// glass-* per-accent rules, light values only present in the light token
// block, or the base consuming a different token). New redundant rules that
// are NOT in the baseline fail the check — de-stack them or add a baseline
// entry with a reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const v3File = path.resolve(scriptDir, '../packages/ui/src/styles/ModernV3.css');
const baseline = JSON.parse(fs.readFileSync(path.join(scriptDir, 'de-stack-baseline.json'), 'utf8'));
const baselinePatterns = Object.keys(baseline.patterns || {});

// --- state-machine parse (comments/strings/braces aware) ---
function parseRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < n && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n && css[i] !== q) i++;
      i++;
      continue;
    }
    if (c !== '{') { i++; continue; }
    // scan back to the previous rule's '}' / ';', skipping any comments
    // (comment text can legally contain ';' or '}', which would otherwise
    // truncate the selector)
    let selStart = i - 1;
    while (selStart >= 0) {
      const c = css[selStart];
      if (c === '}' || c === ';') break;
      if (c === '/' && css[selStart - 1] === '*') {
        let k = selStart - 2;
        while (k >= 0 && !(css[k] === '/' && css[k + 1] === '*')) k--;
        selStart = k - 1;
        continue;
      }
      selStart--;
    }
    // strip leading comments/whitespace (the first rule's banner would
    // otherwise pollute the selector)
    let selector = css.slice(selStart + 1, i).trim().replace(/^(\/\*[\s\S]*?\*\/\s*)+/, '').trim();
    let depth = 1;
    let j = i + 1;
    let close = -1;
    while (j < n && depth > 0) {
      const cc = css[j];
      if (cc === '/' && css[j + 1] === '*') { j += 2; while (j < n && !(css[j] === '*' && css[j + 1] === '/')) j++; j += 2; continue; }
      if (cc === '"' || cc === "'") { const q = cc; j++; while (j < n && css[j] !== q) j++; j++; continue; }
      if (cc === '{') depth++;
      else if (cc === '}') { depth--; if (depth === 0) { close = j; break; } }
      j++;
    }
    if (close === -1) break;
    const body = css.slice(i + 1, close);
    const decls = [];
    const declRe = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
    let dm;
    while ((dm = declRe.exec(body))) decls.push({ prop: dm[1].trim().toLowerCase(), value: dm[2].trim() });
    rules.push({ start: selStart + 1, selector, decls });
    i = close + 1;
  }
  return rules;
}

// --- normalize a CSS value for comparison (case + whitespace, drop !important) ---
function norm(v) {
  return v
    .replace(/!important/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,:()])\s*/g, '$1')
    .trim()
    .toLowerCase();
}

// --- extract token name + fallback from `var(--tok, fallback) !important` ---
function varParts(value) {
  const m = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([\s\S]*))?\)$/i.exec(value.trim().replace(/!important\s*$/i, '').trim());
  if (!m) return null;
  return { token: m[1], fallback: (m[2] === undefined ? '' : m[2].trim()) };
}

const css = fs.readFileSync(v3File, 'utf8');
const rules = parseRules(css);

// token definitions: token -> set of normalized values across all blocks
const tokenDefs = new Map();
for (const r of rules) {
  if (!/^html\.modern-ui-v3/.test(r.selector)) continue; // token blocks only
  for (const d of r.decls) {
    if (!d.prop.startsWith('--')) continue;
    if (!tokenDefs.has(d.prop)) tokenDefs.set(d.prop, new Set());
    tokenDefs.get(d.prop).add(norm(d.value));
  }
}

// annotation comments: positions of comments containing @de-stack-protected
const protectedComments = [];
const comRe = /\/\*([\s\S]*?)\*\//g;
let cm;
while ((cm = comRe.exec(css))) {
  if (cm[1].includes('@de-stack-protected')) protectedComments.push({ start: cm.index, end: comRe.lastIndex });
}

const verbose = process.argv.includes('--verbose');
let violations = 0;
let notes = 0;

for (const r of rules) {
  const sel = r.selector.replace(/\s+/g, ' ');
  if (!sel.includes('.modern-ui-v3')) continue; // v3 consumers only
  if (r.decls.every((d) => d.prop.startsWith('--'))) continue; // token blocks
  const protectedHere = protectedComments.some((p) => p.end <= r.start && r.start - p.end < 400);

  // baseline: load-bearing rules that legitimately stay scoped
  const baselineEntry = baselinePatterns.find((p) => sel.startsWith(p));

  for (const d of r.decls) {
    if (d.prop.startsWith('--')) continue;
    const vp = varParts(d.value);
    if (!vp || !vp.fallback) continue;
    const defs = tokenDefs.get(vp.token);
    if (!defs) continue; // global token (accent-primary, surface-*) — not our contract
    if (!defs.has(norm(vp.fallback))) continue;
    if (protectedHere) {
      notes++;
      if (verbose) console.log(`  NOTE (protected) ${sel.slice(0, 80)}  { ${d.prop}: ${d.value.slice(0, 50)} }`);
    } else if (baselineEntry) {
      notes++;
      if (verbose) console.log(`  NOTE (baseline) ${sel.slice(0, 80)}  { ${d.prop}: ${d.value.slice(0, 50)} }  <- ${baseline.patterns[baselineEntry]}`);
    } else {
      violations++;
      console.log(`DE-STACK  ${sel.slice(0, 80)}  { ${d.prop}: ${d.value.slice(0, 50)} }  -- fallback == ${vp.token}`);
    }
  }
}

if (violations === 0 && notes === 0) {
  console.log('check-de-stack: OK — no .modern-ui-v3 consumers with fallback == token value.');
  process.exit(0);
} else if (violations === 0) {
  console.log(`check-de-stack: OK — ${notes} fallback==token declaration(s) covered by the load-bearing baseline (see scripts/de-stack-baseline.json), 0 redundant.`);
  process.exit(0);
} else {
  console.error(`check-de-stack: FAIL — ${violations} redundant .modern-ui-v3 rule(s) with fallback == token value. De-stack them (move the consumer into the base) or annotate /* @de-stack-protected: <reason> */ if load-bearing.`);
  process.exit(1);
}
