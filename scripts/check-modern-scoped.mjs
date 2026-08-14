// CI-style check: any `.modern-ui` / `.modern-ui-v3` scoped rule in the version
// sheets (ModernV2.css / ModernV3.css) that still carries a literal surface
// value OUTSIDE a var() fallback is a regression: the whole refactor exists to
// make every v2/v3 look token-driven so a future version redefines tokens
// instead of stacking override rules. A literal inside `var(--x, <literal>)`
// is fine (that is the thin-consumer pattern: value preserved by the fallback,
// token is the source of truth).
//
// "Surface value" = a color (hex / rgb / hsl / hwb / lab / lch / oklab / oklch /
// color / color-mix / light-dark), a gradient, a filter function (blur,
// saturate, brightness, contrast, drop-shadow, grayscale, sepia, hue-rotate,
// invert, opacity), or non-zero border-radius — on surface properties
// (background, border, color, shadow, filter, radius, outline, scrollbar-color,
// fill, stroke, accent-color). Neutral resets (transparent, currentcolor, none,
// 0, unset, initial, inherit, revert, revert-layer, auto) are allowed literal
// per the established convention (the light-sheet fold kept them).
//
// Parsing is a small state machine (comments, strings, braces) so `*/` inside a
// comment (e.g. `--cat-title-*/`) can never truncate the comment, and decls are
// matched with their true source line numbers.
//
// Exit code 1 when violations are found so it can run in CI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '../packages/ui/src/styles');
const FILES = ['ModernV2.css', 'ModernV3.css'];

// surface properties — a literal on any of these must be token-driven
const SURFACE_PROPS = new Set([
  'background', 'background-color', 'background-image',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-radius', 'outline', 'outline-color', 'outline-style', 'outline-width',
  'color', 'box-shadow', 'text-shadow', 'filter', 'backdrop-filter',
  '-webkit-backdrop-filter', 'scrollbar-color', 'fill', 'stroke', 'accent-color',
]);

// literals that count as "surface" (colors, gradients, filters)
const SURFACE_RE =
  /(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|blur|saturate|brightness|contrast|drop-shadow|grayscale|sepia|hue-rotate|invert|opacity)\(|\b(?:white|black|red|green|blue|gray|grey)\b)/g;

// neutral values that are allowed literal (resets, not surfaces)
const NEUTRAL = new Set([
  'transparent', 'currentcolor', 'none', '0', '0px', '0%', 'unset', 'initial',
  'inherit', 'revert', 'revert-layer', 'auto',
]);

// mask every var(...) span (including nested parens) so literals inside a
// fallback don't count
function maskVars(value) {
  let masked = value;
  const re = /var\(/g;
  let m;
  while ((m = re.exec(value))) {
    let d = 1;
    let j = m.index + 4;
    while (j < value.length && d > 0) {
      if (value[j] === '(') d++;
      else if (value[j] === ')') d--;
      j++;
    }
    masked = masked.slice(0, m.index) + ' '.repeat(j - m.index) + masked.slice(j);
  }
  return masked;
}

function isNeutral(maskedValue) {
  const v = maskedValue.trim();
  if (NEUTRAL.has(v.toLowerCase())) return true;
  // a lone zero reset (0 / 0px / 0%)
  return /^-?0(\.0+)?(px|em|rem|%)?$/.test(v);
}

// --- state-machine parse: returns rules [{ line, selector, decls: [{line, prop, value}] }] ---
function parseRules(css) {
  const rules = [];
  let i = 0;
  let line = 1;
  const n = css.length;
  // tokenize: skip comments and strings, find rule braces + decls
  // We collect raw chunks with their starting line.
  while (i < n) {
    const c = css[i];
    if (c === '/') {
      if (css[i + 1] === '/') { while (i < n && css[i] !== '\n') i++; continue; }
      if (css[i + 1] === '*') {
        i += 2;
        while (i < n && !(css[i] === '*' && css[i + 1] === '/')) { if (css[i] === '\n') line++; i++; }
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n && css[i] !== q) { if (css[i] === '\n') line++; i++; }
      i++;
      continue;
    }
    if (c === '\n') { line++; i++; continue; }
    if (c !== '{' && c !== '}') { i++; continue; }
    if (c === '{') {
      // scan back to the previous '}' (or start) for the selector text
      let selStart = i - 1;
      while (selStart >= 0 && css[selStart] !== '}' && css[selStart] !== ';' && css[selStart] !== '\n') selStart--;
      const selector = css.slice(selStart + 1, i).trim();
      // find matching close
      let depth = 1;
      let j = i + 1;
      let close = -1;
      while (j < n && depth > 0) {
        const cc = css[j];
        if (cc === '/' && css[j + 1] === '*') { j += 2; while (j < n && !(css[j] === '*' && css[j + 1] === '/')) { if (css[j] === '\n') line++; j++; } j += 2; continue; }
        if (cc === '"' || cc === "'") { const q = cc; j++; while (j < n && css[j] !== q) { if (css[j] === '\n') line++; j++; } j++; continue; }
        if (cc === '{') depth++;
        else if (cc === '}') { depth--; if (depth === 0) { close = j; break; } }
        if (cc === '\n') line++;
        j++;
      }
      if (close === -1) break;
      const body = css.slice(i + 1, close);
      const decls = [];
      const declRe = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
      let dm;
      while ((dm = declRe.exec(body))) {
        const declLine = line - body.slice(dm.index).split('\n').length + 1;
        decls.push({ line: declLine, prop: dm[1].trim().toLowerCase(), value: dm[2].trim() });
      }
      const selLine = line - body.split('\n').length - 1;
      rules.push({ line: selLine, selector, decls });
      i = close + 1;
      continue;
    }
    i++;
  }
  return rules;
}

let violations = 0;
for (const file of FILES) {
  const full = path.join(root, file);
  const css = fs.readFileSync(full, 'utf8');
  for (const rule of parseRules(css)) {
    if (!rule.selector.includes('.modern-ui')) continue;
    for (const d of rule.decls) {
      if (d.prop.startsWith('--')) continue;
      if (!SURFACE_PROPS.has(d.prop)) continue;
      const raw = d.value;
      const masked = maskVars(raw);
      if (isNeutral(masked)) continue;
      if (/^var\(/.test(masked.trim())) continue; // whole value inside var()
      // border-radius: any non-zero geometry is a surface literal
      const lits = d.prop === 'border-radius'
        ? (masked.replace(/!important/g, '').match(/[^\s,]+/g) || []).filter((t) => !isNeutral(t))
        : (masked.match(SURFACE_RE) || []);
      if (!lits || lits.length === 0) continue;
      violations++;
      console.log(`${file}:${rule.line}  ${rule.selector.split('\n').join(' ').slice(0, 90)}  { ${d.prop}: ${raw.slice(0, 60)} }  << ${[...new Set(lits)].join(', ')}`);
    }
  }
}

if (violations === 0) {
  console.log('check-modern-scoped: OK — no literal surface values outside var() fallbacks in .modern-ui scoped rules.');
  process.exit(0);
}
console.error(`check-modern-scoped: FAIL — ${violations} literal surface value(s) outside var() fallbacks.`);
process.exit(1);
