// Audit: every var(--x) usage in the CSS corpus must be defined somewhere,
// and v3-only tokens must be consumed with a fallback (2-arg var()) in base rules.
// Also flags the invalid-at-computed-value bug class: a longhand color property
// (border-color, background-color, outline-color, ...) consuming a token whose
// value is a full shorthand ('1px solid rgba(...)', shadows, padding, ...) —
// the substitution is invalid and the declaration silently becomes unset.
import fs from 'node:fs';
import path from 'node:path';

// Resolve the ui package whether this runs from the repo root or from packages/ui.
const cwd = process.cwd();
const uiDir = fs.existsSync(path.join(cwd, 'packages/ui/src')) ? path.join(cwd, 'packages/ui') : cwd;
const root = path.join(uiDir, 'src');
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.css')) files.push(p);
  }
}
walk(root);

const defined = new Map(); // token -> Set<file>
const used = []; // {token, file, hasFallback, line}

for (const f of files) {
  const css = fs.readFileSync(f, 'utf8');
  // definitions: --name: anywhere (approx, matches custom prop declarations)
  const defRe = /(--[\w-]+)\s*:/g;
  let m;
  while ((m = defRe.exec(css))) {
    if (!defined.has(m[1])) defined.set(m[1], new Set());
    defined.get(m[1]).add(f);
  }
  // usages: var(--name or var(--name, fallback
  const useRe = /var\(\s*(--[\w-]+)(\s*,\s*[^)]*)?\)/g;
  while ((m = useRe.exec(css))) {
    const line = css.slice(0, m.index).split('\n').length;
    used.push({ token: m[1], file: f, hasFallback: !!m[2], line });
  }
}

const undefinedTokens = [...new Set(used.filter(u => !defined.has(u.token)).map(u => u.token))];
console.log('=== UNDEFINED TOKENS (used but never defined) ===');
for (const t of undefinedTokens) {
  const refs = used.filter(u => u.token === t);
  console.log(`${t}  (${refs.length} refs, e.g. ${refs.slice(0,3).map(r => `${r.file.split('/').pop()}:${r.line}`).join(', ')})`);
}
if (undefinedTokens.length === 0) console.log('(none)');

// Tokens defined ONLY in ModernV3.css (v3-gated) consumed in base/component files
// without a fallback -> would be undefined in v1/v2.
const v3File = path.join(uiDir, 'src/styles/ModernV3.css');
const v3Only = [...defined.entries()].filter(([, files]) => files.size === 1 && files.has(v3File)).map(([t]) => t);
console.log('\n=== v3-ONLY TOKENS consumed in base/component files WITHOUT fallback ===');
let risky = 0;
for (const u of used) {
  if (!v3Only.includes(u.token)) continue;
  const isV3File = u.file === v3File || u.file.includes('ModernV2.css') || u.file.includes('ModernThemeBase.css');
  if (isV3File) continue; // inside theme files it's fine (same scope or version-gated)
  if (!u.hasFallback) {
    risky++;
    console.log(`${u.token}  ${u.file.split('/').pop()}:${u.line}`);
  }
}
if (risky === 0) console.log('(none — all v3-only tokens consumed with fallbacks in base rules)');

// Tokens defined ONLY in ModernV2.css consumed in base files without fallback (v1 risk)
const v2File = path.join(uiDir, 'src/styles/ModernV2.css');
const v2Only = [...defined.entries()].filter(([, files]) => files.size === 1 && files.has(v2File)).map(([t]) => t);
console.log('\n=== v2-ONLY TOKENS consumed in base/component files WITHOUT fallback ===');
let risky2 = 0;
for (const u of used) {
  if (!v2Only.includes(u.token)) continue;
  const isTheme = u.file === v2File || u.file === v3File || u.file.includes('ModernThemeBase.css');
  if (isTheme) continue;
  if (!u.hasFallback) {
    risky2++;
    console.log(`${u.token}  ${u.file.split('/').pop()}:${u.line}`);
  }
}
if (risky2 === 0) console.log('(none)');

// ── Shorthand-in-longhand check ────────────────────────────────────────────
// A var() whose substituted value is a full shorthand is invalid at
// computed-value time in a color-only longhand (border-color -> currentcolor,
// background-color -> transparent, ...). We classify every token value as
// "single color" vs "not a color" (composite / function / length / keyword)
// and flag color-longhand consumers of non-color tokens.

const COLOR_PROPS = new Set([
  'color',
  'background-color',
  'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color',
  'text-decoration-color', 'text-emphasis-color', 'column-rule-color', 'caret-color',
  'scrollbar-color',
  'fill', 'stroke',
  '-webkit-text-fill-color', '-webkit-text-stroke-color',
  '-webkit-border-top-color', '-webkit-border-right-color', '-webkit-border-bottom-color', '-webkit-border-left-color',
]);

const NAMED_COLORS = new Set((
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
  'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
  'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
  'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
  'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
  'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
  'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
  'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
  'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
  'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
  'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
  'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
  'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
  'whitesmoke yellow yellowgreen'
).split(/\s+/));

const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/;
const CSS_WIDE = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);

const tokenValues = new Map(); // token -> raw value (first definition wins)
for (const f of files) {
  const css = fs.readFileSync(f, 'utf8')
    // preserve newlines so line numbers stay accurate
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  // capture the FULL token name (with the -- prefix) so keys match var(--x) refs
  const defRe = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = defRe.exec(css))) {
    if (!tokenValues.has(m[1])) tokenValues.set(m[1], m[2].trim());
  }
}

const colorSafeMemo = new Map();
function isColorSafe(token, seen = new Set()) {
  if (colorSafeMemo.has(token)) return colorSafeMemo.get(token);
  if (seen.has(token)) return true; // cycle — can't be a shorthand chain, assume safe
  const nextSeen = new Set(seen).add(token);
  const raw = tokenValues.get(token);
  if (raw === undefined) return true; // runtime-injected / undefined -> assume color
  const v = raw.trim();
  let safe;
  if (v.startsWith('var(')) {
    const inner = /^var\(\s*(--[\w-]+)/.exec(v);
    safe = inner ? isColorSafe(inner[1], nextSeen) : true;
  } else if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
    safe = true;
  } else if (CSS_WIDE.has(v.toLowerCase())) {
    safe = true;
  } else if (NAMED_COLORS.has(v.toLowerCase())) {
    safe = true;
  } else if (COLOR_FN.test(v)) {
    safe = true;
  } else {
    // single component with no color marker (lengths, blur(), keywords) or a
    // multi-component composite ('1px solid rgba(...)', shadows, paddings, ...)
    safe = !hasTopLevelSep(v);
  }
  colorSafeMemo.set(token, safe);
  return safe;
}

// true when the value contains whitespace/comma at paren-depth 0 (a composite)
function hasTopLevelSep(v) {
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && (c === ' ' || c === '\t' || c === '\n' || c === ',')) return true;
  }
  return false;
}

// Properties whose grammar is exactly one non-list value — substituting a
// multi-component token (a shorthand like '1px solid rgba(...)' or a comma
// list) is invalid at computed-value time and silently unsets the property.
const ATOMIC_PROPS = new Set([
  'opacity', 'z-index', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'word-spacing',
  'text-transform', 'white-space', 'text-align', 'vertical-align', 'direction', 'visibility',
  'pointer-events', 'user-select', 'object-fit', 'flex-grow', 'flex-shrink', 'order',
  'overflow-x', 'overflow-y', 'mix-blend-mode', 'isolation', 'float', 'clear', 'display',
  'resize', 'box-sizing', 'perspective', 'transform-style', 'backface-visibility',
  'text-overflow', 'text-decoration-style', 'outline-style', 'outline-width',
  'border-collapse', 'table-layout', 'caption-side', 'empty-cells', 'list-style-type',
  'list-style-position', 'scroll-behavior', 'fill-opacity', 'stroke-opacity', 'stroke-width',
  'flex-basis', 'tab-size', 'text-indent', 'word-break', 'overflow-wrap', 'hyphens',
  'writing-mode', 'orphans', 'widows', 'font-stretch', 'font-kerning', 'font-optical-sizing',
  'text-justify', 'text-rendering', 'text-underline-offset', 'text-size-adjust', 'text-orientation',
]);

// List-accepting properties — a bare color is never a valid item in their
// grammar (transition/animation/transform/filter want durations, functions,
// shadows, names, ...). Comma-separated lists ARE valid here (var() substitutes
// the token stream, so e.g. 'transition: var(--x)' with a multi-property list
// is legal) — only a single color value is always wrong.
const LIST_PROPS = new Set([
  'transition', 'animation', 'box-shadow', 'text-shadow', 'filter', 'backdrop-filter',
  'transform', 'font-family', 'background-image', 'will-change',
  'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay',
  'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
  'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state',
  'transform-origin', 'perspective-origin', 'border-image', 'border-image-slice',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-column',
  'grid-row', 'grid-area', 'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow', 'grid-template', 'grid',
  'mask', 'clip-path', 'offset-path', 'font-variation-settings', 'counter-increment',
  'counter-reset', 'quotes',
]);

// token's value has >1 top-level component (space- or comma-separated)
function isMultiComponentToken(token, seen = new Set()) {
  if (seen.has(token)) return false;
  const raw = tokenValues.get(token);
  if (raw === undefined) return false; // runtime-injected — can't judge
  const v = raw.trim();
  const next = new Set(seen).add(token);
  if (v.startsWith('var(')) {
    const inner = /^var\(\s*(--[\w-]+)/.exec(v);
    return inner ? isMultiComponentToken(inner[1], next) : false;
  }
  return hasTopLevelSep(v);
}
function fallbackIsMultiComponent(fb) {
  const t = fb.trim();
  const m = /^var\(\s*(--[\w-]+)/.exec(t);
  if (m) return isMultiComponentToken(m[1]);
  return hasTopLevelSep(t);
}

// token resolves to a bare color (hex / color function / color-mix). Named
// colors are deliberately NOT treated as bare (an identifier could be a legit
// value in some of these grammars, e.g. font-family).
function isDefinitelyBareColor(token, seen = new Set()) {
  if (seen.has(token)) return false;
  const raw = tokenValues.get(token);
  if (raw === undefined) return false;
  const v = raw.trim();
  const next = new Set(seen).add(token);
  if (v.startsWith('var(')) {
    const inner = /^var\(\s*(--[\w-]+)/.exec(v);
    return inner ? isDefinitelyBareColor(inner[1], next) : false;
  }
  return /^#[0-9a-fA-F]{3,8}$/.test(v) || COLOR_FN.test(v);
}
function fallbackIsBareColor(fb) {
  const t = fb.trim();
  const m = /^var\(\s*(--[\w-]+)/.exec(t);
  if (m) return isDefinitelyBareColor(m[1]);
  return /^#[0-9a-fA-F]{3,8}$/.test(t) || COLOR_FN.test(t);
}

const typeBugs = []; // {kind: 'color'|'atomic'|'list', prop, token, fallback, file, line}
for (const f of files) {
  const css = fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  const declRe = /([a-zA-Z-]+)\s*:\s*([^;{}]*)/g;
  let dm;
  while ((dm = declRe.exec(css))) {
    const prop = dm[1].toLowerCase();
    if (prop.startsWith('--')) continue;
    const inColor = COLOR_PROPS.has(prop);
    const inAtomic = ATOMIC_PROPS.has(prop);
    const inList = LIST_PROPS.has(prop);
    if (!inColor && !inAtomic && !inList) continue;
    const value = dm[2];
    const line = css.slice(0, dm.index).split('\n').length;
    if (inColor) {
      // color longhands are all-color, so EVERY var() matters
      const varRe = /var\(\s*(--[\w-]+)(\s*,\s*([^)]*))?\)/g;
      let vm;
      while ((vm = varRe.exec(value))) {
        const token = vm[1];
        const fallback = vm[3] ? vm[3].trim() : null;
        if (!isColorSafe(token)) {
          typeBugs.push({ kind: 'color', prop, token, fallback: null, file: f, line });
        } else if (!tokenValues.has(token) && fallback !== null) {
          // token is runtime-injected: only the fallback applies — it must be a color too
          const fbToken = /^var\(\s*(--[\w-]+)/.exec(fallback);
          const fallbackIsColor = fbToken ? isColorSafe(fbToken[1]) : isRawColorSafe(fallback);
          if (!fallbackIsColor) typeBugs.push({ kind: 'color', prop, token, fallback, file: f, line });
        }
      }
    } else if (inAtomic || inList) {
      // for these, a var() is only interesting when it is the ENTIRE value —
      // as one component of a larger value it's fine (e.g. '0 0 15px var(--accent-glow)')
      const raw = value.trim().replace(/!important\s*$/, '').trim();
      const sole = /^var\(\s*(--[\w-]+)(\s*,\s*([^)]*))?\)$/.exec(raw);
      if (!sole) continue;
      const token = sole[1];
      const fallback = sole[3] ? sole[3].trim() : null;
      if (inAtomic) {
        if (isMultiComponentToken(token)) {
          typeBugs.push({ kind: 'atomic', prop, token, fallback: null, file: f, line });
        } else if (!tokenValues.has(token) && fallback !== null && fallbackIsMultiComponent(fallback)) {
          typeBugs.push({ kind: 'atomic', prop, token, fallback, file: f, line });
        }
      } else {
        if (isDefinitelyBareColor(token)) {
          typeBugs.push({ kind: 'list', prop, token, fallback: null, file: f, line });
        } else if (!tokenValues.has(token) && fallback !== null && fallbackIsBareColor(fallback)) {
          typeBugs.push({ kind: 'list', prop, token, fallback, file: f, line });
        }
      }
    }
  }
}

// classify a raw literal (not a token ref) as a single color
function isRawColorSafe(v) {
  const t = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return true;
  if (CSS_WIDE.has(t.toLowerCase()) || NAMED_COLORS.has(t.toLowerCase())) return true;
  if (COLOR_FN.test(t)) return true;
  if (t.startsWith('var(')) {
    const inner = /^var\(\s*(--[\w-]+)/.exec(t);
    return inner ? isColorSafe(inner[1]) : true;
  }
  return !hasTopLevelSep(t);
}

console.log('\n=== LONGHAND COLOR PROPS consuming full-shorthand token values ===');
let risky3 = 0;
for (const b of typeBugs.filter(b => b.kind === 'color')) {
  risky3++;
  const detail = b.fallback
    ? `var(${b.token}, ${b.fallback}) — token is runtime-injected, fallback must be a single color`
    : `var(${b.token}) — token value is not a single color`;
  console.log(`${b.prop}: ${detail}  ${b.file.split('/').pop()}:${b.line}`);
}
if (typeBugs.filter(b => b.kind === 'color').length === 0) console.log('(none)');

console.log('\n=== SINGLE-VALUE LONGHANDS consuming multi-component tokens ===');
for (const b of typeBugs.filter(b => b.kind === 'atomic')) {
  risky3++;
  const detail = b.fallback
    ? `var(${b.token}, ${b.fallback}) — token is runtime-injected, fallback is a multi-component value`
    : `var(${b.token}) — token value is multi-component (shorthand/list), invalid here`;
  console.log(`${b.prop}: ${detail}  ${b.file.split('/').pop()}:${b.line}`);
}
if (typeBugs.filter(b => b.kind === 'atomic').length === 0) console.log('(none)');

console.log('\n=== LIST PROPERTIES consuming bare-color tokens ===');
for (const b of typeBugs.filter(b => b.kind === 'list')) {
  risky3++;
  const detail = b.fallback
    ? `var(${b.token}, ${b.fallback}) — token is runtime-injected, fallback is a bare color`
    : `var(${b.token}) — token value is a bare color, not a valid item for ${b.prop}`;
  console.log(`${b.prop}: ${detail}  ${b.file.split('/').pop()}:${b.line}`);
}
if (typeBugs.filter(b => b.kind === 'list').length === 0) console.log('(none)');

// Fail the build when a v2/v3-only token is consumed without a fallback in a
// base/component rule — that is the cascade-collision bug class the migration
// exists to prevent. (The undefined-token section above stays informational:
// several tokens are injected at runtime via setProperty and are intentionally
// not defined in CSS.) Same for the shorthand-in-longhand class above.
process.exit(risky > 0 || risky2 > 0 || risky3 > 0 ? 1 : 0);
