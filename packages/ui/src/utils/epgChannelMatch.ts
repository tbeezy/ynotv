/**
 * Channel-name cleanup and the cleaning-based EPG match tier.
 *
 * Providers decorate channel names with things that carry no identity:
 * region markers (`|DE| ARD-ALPHA HD`, `UK | Sky Cinema`, `[US] Nick`), quality
 * and codec tags (HD, FHD, 4K, HEVC…) and packaging words (RAW, VIP, BACKUP).
 * A feed's display name is usually the bare name, so the provider name never
 * matches by string and only a fuzzy score could save it.
 *
 * This tier CLEANS both sides and compares what is left. It is opt-in and
 * deliberately conservative, because cleaning is what creates collisions:
 * `|FR| Disney Channel` and `|ES| Disney Channel` both clean to
 * `disneychannel`. So a cleaned name only produces a match when exactly one EPG
 * channel has it (or exactly one *agrees on the region*), and a cleaned name
 * that fits nothing is never guessed at.
 *
 * Nothing here touches the provider's stored or displayed name — it is a
 * matching-time view only, exactly like the case-folded tvg-id alias.
 */

/** Quality / codec / packaging words that carry no channel identity. */
export const DEFAULT_STRIP_TOKENS: readonly string[] = [
  // Quality
  'hd', 'fhd', 'uhd', 'qhd', 'sd', '4k', '8k', '1080p', '1080i',
  '720p', '576p', '480p', '360p', 'hq',
  // Codec / container
  'hevc', 'h265', 'x265', 'h264', 'x264', 'avc', 'mpeg4',
  // Packaging / feed words
  'raw', 'backup', 'vip', 'multi', 'multiaudio',
];

/**
 * 2-letter markers that look like a region code but are really quality tags
 * (`(HD)`, `|SD|`). They are still stripped as tags, just never recorded as a
 * region — otherwise `Nick (SD)` and `Nick (HD)` would look like different
 * countries.
 */
const NON_REGION_MARKERS = new Set([
  'hd', 'sd', 'fhd', 'uhd', '4k', '8k', '3d', 'tv', 'hq', 'hdr', 'av',
]);

/** Tokens the Dice scorer ignores (kept as-is for parity with the old scorer). */
const SCORE_NOISE_TOKENS = new Set([
  'hd', 'fhd', 'uhd', '4k', 'sd', '1080p', '720p', '480p',
  'us', 'uk', 'ca', 'au', 'east', 'west', 'channel', 'tv', 'the',
]);

/** `|DE|`, `[US]`, `(UK)`, `{DE}` — a marker and nothing else. */
const DELIMITED_MARKER = /^[|[(]{1,2}([A-Za-z]{2})[\]|)]{1,2}:?$/;
/** `|DE`, `DE|`, `DE:` — one delimiter side, or the prefix form. */
const HALF_MARKER = /^(?:\|([A-Za-z]{2})|([A-Za-z]{2})[|:]|([A-Za-z]{2})\|)$/;

/** Lowercase alphanumerics only — the comparison key for a token or name. */
function tokenKey(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A bare 2-letter word that could be a country code. `(HD)` and `|SD|` are
 * excluded: they are tags wearing a marker's shape, never regions.
 */
function isRegionCode(token: string): boolean {
  return /^[A-Za-z]{2}$/.test(token) && !NON_REGION_MARKERS.has(token.toLowerCase());
}

/** Split a user-supplied tag list into individual word tokens. */
export function parseStripTags(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input.join(',') : (input ?? '');
  return raw
    .split(/[,;\n]/)
    .flatMap(part => part.split(/\s+/))
    .map(part => tokenKey(part))
    .filter(Boolean);
}

/**
 * Returns true if an external store change should overwrite the local input text.
 * Prevents overwriting in-progress typing (trailing commas, whitespace, capitalization)
 * when the parsed tokens of the input already match the store.
 */
export function shouldSyncStripTagsInput(currentInput: string, storeTags: string[] | undefined): boolean {
  const currentParsed = parseStripTags(currentInput).join(',');
  const storeParsed = (storeTags ?? []).join(',');
  return currentParsed !== storeParsed;
}

/** Every token to treat as noise: built-ins plus the user's own words. */
export function stripTokenSet(extraTags?: string | string[]): Set<string> {
  const tokens = new Set<string>(DEFAULT_STRIP_TOKENS);
  for (const tag of parseStripTags(extraTags)) tokens.add(tag);
  return tokens;
}

/**
 * Region codes declared by the name, in order of appearance: `|DE| A`, `A |DE`,
 * `[US] A`, `DE: A`. A bare 2-letter word (`Sky DE`), a longer code or a
 * quality marker in a region's clothing is never one of these.
 */
export function extractRegionTags(name: string): string[] {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const regions: string[] = [];
  const record = (code: string | undefined) => {
    if (!code) return;
    const lower = code.toLowerCase();
    if (NON_REGION_MARKERS.has(lower)) return;
    const upper = lower.toUpperCase();
    if (!regions.includes(upper)) regions.push(upper);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const delimited = token.match(DELIMITED_MARKER);
    if (delimited) {
      record(delimited[1]);
      continue;
    }
    const half = token.match(HALF_MARKER);
    if (half) {
      const code = half[1] ?? half[2] ?? half[3];
      // `|DE` carries its own delimiter and is always a marker. The bare forms
      // (`DE:`, `DE|`) only count at the start, or after a standalone pipe
      // (`UK | Sky Cinema`) — `Sport DE:` further in is just text.
      const prevIsPipe = i > 0 && /^\|+$/.test(tokens[i - 1]);
      if (token.startsWith('|') || prevIsPipe || i === 0) record(code);
      continue;
    }
    // `UK | Sky Cinema` — a code followed by a standalone pipe-ish token.
    if (i + 1 < tokens.length && /^\|+$/.test(tokens[i + 1]) && isRegionCode(token)) {
      record(token);
    }
  }
  return regions;
}

/**
 * The name with region markers, quality/codec tags and the user's extra words
 * removed. Original casing and the remaining words are preserved (this is shown
 * back to the user, so `ARD-alpha` must not become `ardalpha`).
 */
export function cleanChannelName(name: string, extraTags?: string | string[]): string {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const strip = stripTokenSet(extraTags);
  const kept: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const key = tokenKey(token);
    if (!key) continue;
    // Region marker (any of its shapes) — never part of an identity.
    if (DELIMITED_MARKER.test(token) || HALF_MARKER.test(token)) continue;
    // Standalone pipe left over from `UK | Sky Cinema`, and the code before it.
    if (/^\|+$/.test(token)) continue;
    if (i + 1 < tokens.length && /^\|+$/.test(tokens[i + 1]) && isRegionCode(token)) continue;
    if (strip.has(key)) continue;
    kept.push(token.replace(/^[|:.,\-_]+|[|:.,\-_]+$/g, ''));
  }
  return kept.filter(Boolean).join(' ');
}

/** Comparison key for a cleaned name: lowercase alphanumerics only. */
export function cleanMatchKey(name: string, extraTags?: string | string[]): string {
  return cleanChannelName(name, extraTags).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Candidates are cleaned once per run, not once per channel.
 *
 * A run resolves every needing channel against the whole candidate list, so the
 * same display name would otherwise be cleaned once per channel — tens of
 * thousands of times for a large feed, and the cleaning is the expensive half of
 * the comparison. Keyed by the candidate object and the tag set that produced
 * the value, so changing the user's tags can never read a stale entry.
 */
const cleanedNameCache = new WeakMap<object, { tags: string; value: string }>();

function tagsSignature(extraTags?: string | string[]): string {
  return extraTags === undefined ? '' : parseStripTags(extraTags).sort().join(',');
}

function cachedCleanName(candidate: NameMatchCandidate, extraTags?: string | string[]): string {
  if (!candidate || typeof candidate !== 'object') return '';
  const tags = tagsSignature(extraTags);
  const hit = cleanedNameCache.get(candidate);
  if (hit && hit.tags === tags) return hit.value;
  const value = cleanChannelName(candidate.display_name, extraTags);
  cleanedNameCache.set(candidate, { tags, value });
  return value;
}

function normalizeTokens(str: string, noise: Set<string> = SCORE_NOISE_TOKENS): string[] {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !noise.has(t));
}

/**
 * Sørensen-Dice-style token overlap score (0–1, +0.2 substring bonus).
 * Unchanged behaviour: the built-in noise list is what the EPG editor has
 * always scored with.
 */
export function scoreChannelMatch(channelName: string, epgDisplayName: string): number {
  if (!channelName || !epgDisplayName) return 0;
  const a = normalizeTokens(channelName);
  const b = normalizeTokens(epgDisplayName);
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const t of setA) {
    if (setB.has(t)) shared++;
  }

  const score = (2 * shared) / (setA.size + setB.size);
  const normA = a.join(' ');
  const normB = b.join(' ');
  const bonus = (normA.includes(normB) || normB.includes(normA)) ? 0.2 : 0;
  return Math.min(1.2, score + bonus);
}

export interface NameMatchCandidate {
  id: string;
  display_name: string;
  source_id?: string;
  icon_url?: string;
  /** Present when the candidate is a playlist channel, so it can be excluded. */
  stream_id?: string;
}

/** How a cleaned match was found — surfaced in the Automatch Missing report. */
export type CleanMatchVia = 'clean-exact' | 'clean-scored' | 'none';

/** How many refusing candidates are carried back for a one-click choice. */
export const MAX_REFUSAL_CHOICES = 8;

export interface CleanNameMatchResult<T extends NameMatchCandidate> {
  match: (T & { score: number; via: CleanMatchVia }) | null;
  /** More than one EPG channel owns the cleaned name and the region can't split them. */
  ambiguous: boolean;
  /** The cleaned name that was tried ('' when cleaning left nothing). */
  cleanedName: string;
  /**
   * The candidates we refused to choose between, so the caller can hand the
   * decision to the user instead of dropping it: any that agree on the region
   * come first, then the rest, capped at {@link MAX_REFUSAL_CHOICES}.
   */
  choices: T[];
  /** How many candidates shared the cleaned name — the refusal's real count. */
  totalChoices: number;
}

/** Do the two region sets agree? An empty side agrees with anything. */
function regionsAgree(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some(code => b.includes(code));
}

/**
 * The candidate list, indexed so resolving a channel doesn't re-read all of it.
 *
 * A run resolves thousands of channels against a feed of tens of thousands of
 * names. Building these maps per channel made a run take minutes (measured: 12ms
 * per channel for a 20k-name feed — 744s for 60k channels), so the index is
 * built once and reused.
 */
export interface CleanNameIndex<T extends NameMatchCandidate> {
  /** Every candidate, in feed order — used only by the low-threshold fallback. */
  candidates: T[];
  /** Cleaned comparison key → the candidates that own it. */
  byKey: Map<string, T[]>;
  /** Informative token → the candidates carrying it (seeds the fuzzy stage). */
  byToken: Map<string, T[]>;
  /** Cleaned display name per candidate, cleaned once instead of per channel. */
  cleaned: Map<T, string>;
}

/**
 * Index a feed for cleaned-name matching. Build once per run, reuse per channel.
 */
export function prepareCleanNameIndex<T extends NameMatchCandidate>(
  candidates: T[],
  extraTags?: string | string[],
): CleanNameIndex<T> {
  const byKey = new Map<string, T[]>();
  const byToken = new Map<string, T[]>();
  const cleaned = new Map<T, string>();

  for (const candidate of candidates || []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const clean = cachedCleanName(candidate, extraTags);
    cleaned.set(candidate, clean);

    const key = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(candidate);
      else byKey.set(key, [candidate]);
    }

    // Deduped: a channel named `Sky Sky Sport` must be indexed once per token,
    // or the seed set would carry duplicates that get scored repeatedly.
    for (const token of new Set(normalizeTokens(clean))) {
      const bucket = byToken.get(token);
      if (bucket) bucket.push(candidate);
      else byToken.set(token, [candidate]);
    }
  }

  return { candidates: candidates || [], byKey, byToken, cleaned };
}

/**
 * Resolve a channel name against EPG candidates using cleaned names.
 *
 * 1. Clean both sides. Nothing left on the channel side → no match, ever.
 *    The channel's own row is dropped: matching a channel against itself
 *    resolves nothing, and in playlist mode the channel is always among its own
 *    candidates.
 * 2. Exactly one candidate with the same cleaned name → match.
 * 3. Several, but exactly one agrees on the region (`|FR| Disney Channel`) →
 *    match; otherwise ambiguous and **skipped**, never guessed.
 * 4. Otherwise fall back to the Dice score over cleaned names, thresholded —
 *    the same scoring the editor has always used, minus the decorations. Only
 *    candidates sharing a token with the channel are scored; below a 20%
 *    threshold the scorer's substring bonus can fire with no shared token at
 *    all, so that slider range scans the whole feed instead.
 *
 * Pass a {@link CleanNameIndex} to reuse across channels; an array is accepted
 * for one-off calls and indexed on the spot.
 */
export function matchByCleanName<T extends NameMatchCandidate>(
  channelName: string,
  candidatesOrIndex: CleanNameIndex<T> | T[],
  threshold: number,
  extraTags?: string | string[],
  /** The channel being matched, when candidates come from the playlist itself. */
  selfStreamId?: string,
): CleanNameMatchResult<T> {
  const cleanedName = cleanChannelName(channelName, extraTags);
  const key = cleanMatchKey(channelName, extraTags);
  const empty: CleanNameMatchResult<T> = {
    match: null, ambiguous: false, cleanedName, choices: [], totalChoices: 0,
  };
  if (!key) return empty;

  const index: CleanNameIndex<T> = Array.isArray(candidatesOrIndex)
    ? prepareCleanNameIndex(candidatesOrIndex, extraTags)
    : candidatesOrIndex;
  if (!index || index.candidates.length === 0) return empty;

  const isSelf = (candidate: T) =>
    Boolean(selfStreamId) && Boolean(candidate.stream_id) && candidate.stream_id === selfStreamId;

  const sameName = (index.byKey.get(key) ?? []).filter(c => !isSelf(c));
  if (sameName.length > 0) {
    // Region markers decide both cases: a single candidate is still wrong if it
    // declares a different country (`|US| Nick` vs a lone `|UK| Nick`), and a
    // collision is resolvable when exactly one candidate agrees.
    const channelRegions = extractRegionTags(channelName);
    const agreeing = sameName.filter(c => regionsAgree(channelRegions, extractRegionTags(c.display_name)));
    if (agreeing.length === 1) {
      return { match: { ...agreeing[0], score: 1, via: 'clean-exact' }, ambiguous: false, cleanedName, choices: [], totalChoices: 0 };
    }
    // Undecidable: guessing here writes a real channel's guide onto this one, so
    // the decision goes back to the caller as a list of candidates to choose
    // from. Every candidate that shares the cleaned name is offered — the user
    // may know something the region markers don't — but the ones whose region
    // agrees are listed first, since that is almost always the intended one.
    const ordered = [
      ...sameName.filter(c => agreeing.includes(c)),
      ...sameName.filter(c => !agreeing.includes(c)),
    ];
    return {
      match: null,
      ambiguous: true,
      cleanedName,
      choices: ordered.slice(0, MAX_REFUSAL_CHOICES),
      totalChoices: sameName.length,
    };
  }

  // No identical cleaned name — score the cleaned forms, seeded by shared
  // tokens (only those can produce a score at or above the threshold).
  let seed: T[];
  if (threshold <= 0.2) {
    seed = index.candidates;
  } else {
    const seen = new Set<T>();
    seed = [];
    for (const token of normalizeTokens(cleanedName)) {
      for (const candidate of index.byToken.get(token) ?? []) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          seed.push(candidate);
        }
      }
    }
  }

  let best: { candidate: T; score: number } | null = null;
  for (const candidate of seed) {
    if (isSelf(candidate)) continue;
    const candidateClean = index.cleaned.get(candidate)
      ?? cleanChannelName(candidate.display_name, extraTags);
    const score = scoreChannelMatch(cleanedName, candidateClean);
    if (!best || score > best.score) best = { candidate, score };
  }
  if (best && best.score >= threshold) {
    return {
      match: { ...best.candidate, score: best.score, via: 'clean-scored' },
      ambiguous: false,
      cleanedName,
      choices: [],
      totalChoices: 0,
    };
  }
  return empty;
}
