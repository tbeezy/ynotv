/**
 * Helpers for Stremio/Nuvio subtitle add-on tracks.
 *
 * Subtitle add-ons (GTSubs, SubDL, OpenSubtitles v3, ...) return pure metadata:
 * an array of `{ id, url, lang }` entries. Nothing is downloaded up front — a
 * track is only fetched when it is actually selected, which keeps us inside the
 * per-server translation queues that eager batch downloading instantly trips.
 */
import type { TFunction } from 'i18next';
import { LANG_MAP, fromSubSourceLang, toSubSourceLang } from '../services/subsource';
import type { StremioSubtitle } from '../types/stremio';

/** Max tracks kept per language. GTSubs alone returns ~179 per language. */
export const ADDON_TRACKS_PER_LANGUAGE = 15;

export interface AddonSubtitleTrack extends StremioSubtitle {
  /** Canonical 2-letter code derived from the add-on's (often non-standard) tag. */
  langCode: string;
  /** Stable identity across sessions — used for React keys, status maps and filenames. */
  trackKey: string;
  /** Add-on name shown as the origin badge. */
  origin: string;
  /** Template entry with no real source release behind it (e.g. GTSubs `info:*`). */
  generic: boolean;
  /** How many tracks this language actually offered, before the per-language cap. */
  totalInLanguage: number;
}

/** Queue state reported by translation add-ons while a track is being produced. */
export interface AddonQueueState {
  queued: boolean;
  full: boolean;
  position: number | null;
  eta: string | null;
}

/**
 * Add-on language tags the SubSource map does not know, and whose two-character
 * fallback is wrong. OpenSubtitles v3 labels Brazilian Portuguese `pob`, which
 * the fallback shortens to the non-existent `po` — those tracks then never
 * match a Portuguese (`pt`) selection and stay invisible in the modal.
 */
const ADDON_LANG_ALIASES: Record<string, string> = {
  pob: 'pt',
  'pt-br': 'pt',
};

/** Every 2-letter code the SubSource language map recognises. */
const KNOWN_LANG_CODES = new Set(Object.keys(LANG_MAP).filter((code) => code.length === 2));

/**
 * Normalize an add-on language tag to a 2-letter code. Add-ons use non-standard
 * tags (`argt`, `engt`, `abgt`), which fall through the SubSource name map and
 * are reduced to their first two characters.
 */
export function normalizeSubtitleLang(code?: string): string {
  if (!code) return '';
  const lower = code.toLowerCase().trim();

  const alias = ADDON_LANG_ALIASES[lower];
  if (alias) return alias;

  try {
    const mapped = fromSubSourceLang(toSubSourceLang(lower));
    if (KNOWN_LANG_CODES.has(mapped)) return mapped;

    // GTSubs appends `t` to mark a translated track (`engt`, `argt`), so the
    // untagged form is worth another try: it is what turns a regional tag like
    // `pobt` into `pob` and then into `pt` instead of the bogus `po`.
    const stripped = lower.length > 2 && lower.endsWith('t') ? lower.slice(0, -1) : '';
    if (stripped) {
      const strippedAlias = ADDON_LANG_ALIASES[stripped];
      if (strippedAlias) return strippedAlias;
      const mappedStripped = fromSubSourceLang(toSubSourceLang(stripped));
      if (KNOWN_LANG_CODES.has(mappedStripped)) return mappedStripped;
    }

    return mapped || lower.slice(0, 2);
  } catch {
    return lower.slice(0, 2);
  }
}

const languageDisplayNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return null; // older engines — the uppercase tag is the fallback
  }
})();

/**
 * Human name for an add-on language tag (`eng` → `English`). Most add-ons name
 * their tracks themselves, but release-backed ones (OpenSubtitles v3) send only
 * a numeric subtitle id, so the language is the only useful thing to show.
 */
export function subtitleLanguageName(code?: string): string {
  const langCode = normalizeSubtitleLang(code);
  if (!langCode) return 'Subtitle';
  try {
    const name = languageDisplayNames?.of(langCode);
    if (name && name.toLowerCase() !== langCode.toLowerCase()) return name;
  } catch {
    /* unknown tag — fall through to the code itself */
  }
  return langCode.toUpperCase();
}

/** 32-bit FNV-1a, rendered as 8 lowercase hex characters. */
export function hashSubtitleKey(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * GTSubs ships generic `info:*` entries (`/subtitle/info/ar.srt`) alongside one
 * entry per source release. The generic ones are not matched to a release, so
 * they are only worth offering when nothing else exists for that language.
 */
export function isGenericAddonSubtitle(sub: Pick<StremioSubtitle, 'id' | 'url'>): boolean {
  const id = (sub.id || '').toLowerCase();
  if (id.startsWith('info:')) return true;
  const url = (sub.url || '').toLowerCase();
  return /\/subtitle\/info\//.test(url);
}

/**
 * Turn raw add-on metadata into the capped, de-duplicated track list the UI
 * stores in memory and offers on demand.
 */
export function selectAddonTracks(
  subs: StremioSubtitle[] | undefined | null,
  perLanguage: number = ADDON_TRACKS_PER_LANGUAGE
): AddonSubtitleTrack[] {
  const groups = new Map<string, AddonSubtitleTrack[]>();
  const languageOrder: string[] = [];

  for (const sub of subs || []) {
    if (!sub || !sub.url) continue;
    const langCode = normalizeSubtitleLang(sub.lang);
    if (!langCode) continue;

    const track: AddonSubtitleTrack = {
      ...sub,
      langCode,
      origin: sub.addonName || 'Addon',
      generic: isGenericAddonSubtitle(sub),
      trackKey: hashSubtitleKey(`${sub.addonName || ''}|${sub.url}`),
      totalInLanguage: 0,
    };

    let list = groups.get(langCode);
    if (!list) {
      list = [];
      groups.set(langCode, list);
      languageOrder.push(langCode);
    }
    list.push(track);
  }

  const seenKeys = new Set<string>();
  const out: AddonSubtitleTrack[] = [];

  for (const langCode of languageOrder) {
    const list = groups.get(langCode)!;
    const specific = list.filter((track) => !track.generic);
    const usable = specific.length > 0 ? specific : list;
    const capped = perLanguage > 0 ? usable.slice(0, perLanguage) : usable;

    for (const track of capped) {
      let key = track.trackKey;
      let suffix = 2;
      while (seenKeys.has(key)) {
        key = `${track.trackKey}-${suffix++}`;
      }
      seenKeys.add(key);
      out.push({ ...track, trackKey: key, totalInLanguage: usable.length });
    }
  }

  return out;
}

/**
 * Pick the auto-load candidate for a language: the first release-backed track
 * (add-on order is the add-on's own preference order).
 */
export function pickBestAddonTrack(
  tracks: AddonSubtitleTrack[],
  targetLang: string
): AddonSubtitleTrack | null {
  if (!targetLang) return null;
  return (
    tracks.find((track) => track.langCode === targetLang && !track.generic) ||
    tracks.find((track) => track.langCode === targetLang) ||
    null
  );
}

/**
 * A label that is really just an identifier: the release-backed add-ons send a
 * bare subtitle id (`1234567`) or repeat the language tag, and showing either as
 * the track name tells the user nothing.
 */
function isPlaceholderAddonLabel(
  label: string,
  track: Pick<StremioSubtitle, 'id' | 'lang'>
): boolean {
  if (!/[a-z]/i.test(label)) return true; // "1234567", "12.", "---"
  const lower = label.toLowerCase();
  if (lower === (track.id || '').trim().toLowerCase()) return true;
  if (lower === (track.lang || '').trim().toLowerCase()) return true;
  const langCode = normalizeSubtitleLang(track.lang);
  return Boolean(langCode) && lower === langCode;
}

/**
 * Name shown for a track. A descriptive add-on label wins; otherwise the track
 * is named after its language rather than its internal id.
 */
export function addonTrackLabel(track: Pick<StremioSubtitle, 'id' | 'label' | 'lang'>): string {
  const label = (track.label || '').trim();
  if (label && !isPlaceholderAddonLabel(label, track)) return label;
  return subtitleLanguageName(track.lang);
}

/**
 * The underlying file name when the add-on exposes one (OpenSubtitles v3 does),
 * minus its extension. It is a whole release name, so the modal keeps it out of
 * the row text and shows it on hover — it is the only thing that tells two
 * same-language rows apart.
 */
export function addonTrackDetail(track: { subtitleFileName?: string }): string {
  const file = (track.subtitleFileName || '').trim();
  if (!file) return '';
  return file.replace(/\.(srt|ass|ssa|sub|vtt)$/i, '');
}

function sanitizeFilenamePart(val: string | undefined, fallback: string, maxLength: number): string {
  if (!val) return fallback;
  const cleaned = val
    .replace(/ /g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_');
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

export interface AddonSubtitleFilenameParts {
  addonName?: string;
  label?: string;
  metaId?: string;
  lang?: string;
  /** Stable tail (see hashSubtitleKey) — replaces the old array index. */
  key: string;
  ext: string;
}

/**
 * Build the on-disk name for a downloaded add-on track. The leading parts are
 * parsed back out by SubtitleControlModal/usePlayback (addon, label, language),
 * so only the tail is free to change.
 */
export function buildAddonSubtitleFilename(parts: AddonSubtitleFilenameParts): string {
  const cleanAddon = sanitizeFilenamePart(parts.addonName, 'Addon', 30);
  const cleanLabel = sanitizeFilenamePart(parts.label, 'Subtitle', 40);
  const cleanMetaId = sanitizeFilenamePart(parts.metaId, 'unknown', 30);
  const cleanLang = sanitizeFilenamePart(parts.lang, 'und', 10);
  const cleanKey = sanitizeFilenamePart(parts.key, 'track', 16);
  return `stremio__${cleanAddon}__${cleanLabel}__${cleanMetaId}__${cleanLang}__${cleanKey}.${parts.ext}`;
}

const QUEUE_FULL_RE = /queue is currently full/i;
const QUEUE_PENDING_RE = /your process has been queued/i;
const QUEUE_TRANSLATING_RE = /translating/i;
const QUEUE_POSITION_RE = /Position:\s*#\s*(\d+)/i;
const QUEUE_ETA_RE = /(?:Translating\.\.\.\s*)?\((~?\s*\d+\s*(?:minutes?|mins?|seconds?|secs?|hours?|hrs?))\)/i;
/** Placeholder cues span the whole video; real subtitles never do. */
const PLACEHOLDER_SPAN_RE = /00:00:00[,.]000\s*-->\s*(?:0?2:00:00|01:59:5\d)[,.]000/;

/**
 * Detect a translation-queue placeholder. Finished GTSubs files also open with
 * short banner cues (version, credits, donation link), so cue *count* alone is
 * not a safe signal — match the queue wording, and fall back to the single
 * two-hour cue these add-ons emit while a job is pending.
 */
export function parseQueuePlaceholder(text?: string | null): AddonQueueState {
  const body = (text || '').slice(0, 4000);
  if (!body) return { queued: false, full: false, position: null, eta: null };

  if (QUEUE_FULL_RE.test(body)) {
    return { queued: true, full: true, position: null, eta: null };
  }

  if (QUEUE_PENDING_RE.test(body) || QUEUE_TRANSLATING_RE.test(body)) {
    const posMatch = QUEUE_POSITION_RE.exec(body);
    const etaMatch = QUEUE_ETA_RE.exec(body);
    return {
      queued: true,
      full: false,
      position: posMatch ? parseInt(posMatch[1], 10) : null,
      eta: etaMatch ? etaMatch[1].trim() : null,
    };
  }

  const cueCount = (body.match(/-->/g) || []).length;
  if (cueCount <= 3 && PLACEHOLDER_SPAN_RE.test(body)) {
    return { queued: true, full: false, position: null, eta: null };
  }

  return { queued: false, full: false, position: null, eta: null };
}

/**
 * Single source of truth for how a translation-queue state is worded. Both the
 * player's toast and the subtitle modal's row badge render this same string, so
 * the two surfaces cannot drift apart.
 *
 * `translator` must be bound to the `subtitles` namespace: the `t` returned by
 * `useTranslation('subtitles')`, or `i18n.getFixedT(null, 'subtitles')`.
 */
export function addonQueueStatusText(
  queue: AddonQueueState,
  translator: TFunction<'subtitles'>
): string {
  if (queue.full) return translator('addonQueueFull');

  const queued =
    queue.position === null ? null : translator('addonQueued', { position: queue.position });
  if (!queue.eta) return queued ?? translator('addonQueuedUnknown');

  // An estimate on its own ("~3 minutes") reads like a duration rather than a
  // job in progress, so it always travels with the verb it belongs to.
  const translating = translator('addonTranslating', { eta: queue.eta });
  return queued ? `${queued} (${translating})` : translating;
}
