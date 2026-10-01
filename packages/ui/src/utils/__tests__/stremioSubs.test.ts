import { describe, expect, it } from 'vitest';
import {
  ADDON_TRACKS_PER_LANGUAGE,
  addonQueueStatusText,
  addonTrackDetail,
  addonTrackLabel,
  buildAddonSubtitleFilename,
  hashSubtitleKey,
  isGenericAddonSubtitle,
  normalizeSubtitleLang,
  parseQueuePlaceholder,
  pickBestAddonTrack,
  selectAddonTracks,
  type AddonQueueState,
} from '../stremioSubs';
import type { StremioSubtitle } from '../../types/stremio';

/**
 * Fixtures are synthetic, built to the shape the translation add-ons actually
 * serve — short banner cues followed by real cues, and the three placeholder
 * bodies they emit while a job is pending. No captured payloads: the wording
 * the parser keys on is the add-on's own public template text.
 */
function sub(overrides: Partial<StremioSubtitle>): StremioSubtitle {
  return {
    id: '1:1000:ar',
    url: 'https://subs.example.test/subtitle/movie/tt0000001/1000/ar.srt',
    lang: 'argt',
    addonName: 'GTSubs',
    ...overrides,
  };
}

/** A finished file: banner cues first, then the real cues. */
const ADDON_FINISHED_SAMPLE = [
  '1',
  '00:00:00,000 --> 00:00:05,000',
  '• Subtitle add-on •',
  'release-tag',
  '2',
  '00:00:05,000 --> 00:00:10,000',
  '• Subtitle add-on •',
  'https://example.test/donate',
  '3',
  '00:00:10,000 --> 00:00:15,000',
  'Sample cue one',
  '4',
  '00:01:59,455 --> 00:02:02,447',
  'Sample cue two',
  '5',
  '00:02:03,535 --> 00:02:04,331',
  'Sample cue three',
].join('\n');

const ADDON_QUEUE_FULL_SAMPLE = [
  '1',
  '00:00:00,000 --> 02:00:00,000',
  '• Subtitle add-on •',
  'Queue is currently full.',
  'Please try again later.',
].join('\n');

const ADDON_QUEUED_SAMPLE = [
  '1',
  '00:00:00,000 --> 02:00:00,000',
  '• Subtitle add-on •',
  'Your process has been queued',
  'Position: #9',
].join('\n');

describe('normalizeSubtitleLang', () => {
  it('maps non-standard add-on tags to 2-letter codes', () => {
    expect(normalizeSubtitleLang('argt')).toBe('ar');
    expect(normalizeSubtitleLang('engt')).toBe('en');
    expect(normalizeSubtitleLang('abgt')).toBe('ab');
  });

  it('resolves regional tags whose 2-character fallback is not a real code', () => {
    // OpenSubtitles v3 labels Brazilian Portuguese `pob`, which the fallback
    // shortened to `po` — a code no `pt` selection can ever match.
    expect(normalizeSubtitleLang('pob')).toBe('pt');
    expect(normalizeSubtitleLang('pobt')).toBe('pt');
    expect(normalizeSubtitleLang('pt-br')).toBe('pt');
  });

  it('passes through standard codes and tolerates empties', () => {
    expect(normalizeSubtitleLang('en')).toBe('en');
    expect(normalizeSubtitleLang('spa')).toBe('es');
    expect(normalizeSubtitleLang(undefined)).toBe('');
    expect(normalizeSubtitleLang('')).toBe('');
  });
});

describe('hashSubtitleKey', () => {
  it('is deterministic, filename safe and 8 characters long', () => {
    const a = hashSubtitleKey('Addon|https://example.test/a.srt');
    const b = hashSubtitleKey('Addon|https://example.test/a.srt');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('separates different urls', () => {
    expect(hashSubtitleKey('a')).not.toBe(hashSubtitleKey('b'));
  });
});

describe('isGenericAddonSubtitle', () => {
  it('flags template entries with no source release behind them', () => {
    expect(isGenericAddonSubtitle({ id: 'info:ar', url: 'https://subs.example.test/subtitle/info/ar.srt' })).toBe(true);
    expect(isGenericAddonSubtitle({ id: 'x', url: 'https://subs.example.test/subtitle/movie/tt1/1000/ar.srt' })).toBe(false);
  });
});

describe('selectAddonTracks', () => {
  it('derives language codes, keys and origin from raw metadata', () => {
    const tracks = selectAddonTracks([sub({})]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].langCode).toBe('ar');
    expect(tracks[0].origin).toBe('GTSubs');
    expect(tracks[0].trackKey).toMatch(/^[0-9a-f]{8}$/);
    expect(tracks[0].totalInLanguage).toBe(1);
  });

  it('caps per language but reports the uncapped total', () => {
    const many: StremioSubtitle[] = Array.from({ length: 179 }, (_, i) =>
      sub({ id: `${i}:ar`, url: `https://subs.example.test/subtitle/movie/tt1/${i}/ar.srt` })
    );
    const tracks = selectAddonTracks(many);
    expect(tracks).toHaveLength(ADDON_TRACKS_PER_LANGUAGE);
    expect(tracks.every((t) => t.totalInLanguage === 179)).toBe(true);
  });

  it('keeps language diversity rather than truncating globally', () => {
    const mixed = [
      ...Array.from({ length: 40 }, (_, i) => sub({ id: `a${i}`, url: `https://x.test/a/${i}.srt`, lang: 'argt' })),
      ...Array.from({ length: 40 }, (_, i) => sub({ id: `s${i}`, url: `https://x.test/s/${i}.srt`, lang: 'spa' })),
    ];
    const tracks = selectAddonTracks(mixed);
    expect(new Set(tracks.map((t) => t.langCode))).toEqual(new Set(['ar', 'es']));
    expect(tracks).toHaveLength(ADDON_TRACKS_PER_LANGUAGE * 2);
  });

  it('drops generic entries when release-backed entries exist', () => {
    const tracks = selectAddonTracks([
      sub({ id: 'info:ar', url: 'https://subs.example.test/subtitle/info/ar.srt' }),
      sub({ id: '1:1000:ar', url: 'https://subs.example.test/subtitle/movie/tt1/1000/ar.srt' }),
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe('1:1000:ar');
  });

  it('keeps generic entries when they are all a language has', () => {
    const tracks = selectAddonTracks([sub({ id: 'info:ar', url: 'https://subs.example.test/subtitle/info/ar.srt' })]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].generic).toBe(true);
  });

  it('ignores entries without a url or language and de-duplicates keys', () => {
    const tracks = selectAddonTracks([
      sub({ id: 'no-url', url: '' }),
      sub({ id: 'no-lang', url: 'https://x.test/1.srt', lang: '' }),
      sub({ id: 'dup1', url: 'https://x.test/same.srt' }),
      sub({ id: 'dup2', url: 'https://x.test/same.srt' }),
    ]);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].trackKey).not.toBe(tracks[1].trackKey);
  });

  it('tolerates missing input', () => {
    expect(selectAddonTracks(undefined)).toEqual([]);
    expect(selectAddonTracks(null)).toEqual([]);
  });
});

describe('pickBestAddonTrack', () => {
  it('prefers a release-backed track in the requested language', () => {
    const tracks = selectAddonTracks([
      sub({ id: 'info:ar', url: 'https://subs.example.test/subtitle/info/ar.srt' }),
      sub({ id: '1:1000:ar', url: 'https://subs.example.test/subtitle/movie/tt1/1000/ar.srt' }),
      sub({ id: 'info:en', url: 'https://subs.example.test/subtitle/info/en.srt', lang: 'engt' }),
    ]);
    expect(pickBestAddonTrack(tracks, 'ar')?.id).toBe('1:1000:ar');
    expect(pickBestAddonTrack(tracks, 'en')?.id).toBe('info:en');
  });

  it('returns nothing for an unavailable language or empty target', () => {
    const tracks = selectAddonTracks([sub({})]);
    expect(pickBestAddonTrack(tracks, 'fr')).toBeNull();
    expect(pickBestAddonTrack(tracks, '')).toBeNull();
  });
});

describe('addonTrackLabel', () => {
  it('keeps a descriptive add-on label', () => {
    expect(addonTrackLabel({ id: '1:1000:ar', lang: 'argt', label: '  BluRay  ' })).toBe('BluRay');
    expect(addonTrackLabel({ id: 'x', lang: 'eng', label: 'BluRay fix' })).toBe('BluRay fix');
  });

  it('names an id-only track after its language', () => {
    // OpenSubtitles v3 sends no label at all — only a numeric subtitle id.
    expect(addonTrackLabel({ id: '1234567', lang: 'eng' })).toBe('English');
    expect(addonTrackLabel({ id: '1234567', lang: 'eng', label: '1234567' })).toBe('English');
    expect(addonTrackLabel({ id: '', lang: 'argt' })).toBe('Arabic');
  });

  it('treats a bare language tag as a placeholder label', () => {
    expect(addonTrackLabel({ id: '1', lang: 'eng', label: 'eng' })).toBe('English');
    expect(addonTrackLabel({ id: '1', lang: 'eng', label: 'EN' })).toBe('English');
  });

  it('falls back to the uppercase tag for unknown languages', () => {
    expect(addonTrackLabel({ id: '1', lang: 'zz' })).toBe('ZZ');
    expect(addonTrackLabel({ id: '1', lang: '' })).toBe('Subtitle');
  });
});

describe('addonTrackDetail', () => {
  it('exposes the add-on file name without its extension', () => {
    expect(addonTrackDetail({ subtitleFileName: 'Example.Movie.en.srt' })).toBe('Example.Movie.en');
    expect(addonTrackDetail({ subtitleFileName: 'Movie.1080p.ass' })).toBe('Movie.1080p');
    expect(addonTrackDetail({})).toBe('');
    expect(addonTrackDetail({ subtitleFileName: '   ' })).toBe('');
  });

  it('keeps a whole release name intact', () => {
    // These names are the whole release, which is why the modal shows them on
    // hover rather than in the row text.
    expect(
      addonTrackDetail({
        subtitleFileName: 'Example.Movie.2020.1080p.BluRay.H264.AAC-GRP.en.srt',
      })
    ).toBe('Example.Movie.2020.1080p.BluRay.H264.AAC-GRP.en');
  });
});

describe('buildAddonSubtitleFilename', () => {
  it('keeps the shape the modal and playback hook parse', () => {
    const name = buildAddonSubtitleFilename({
      addonName: 'GTSubs',
      label: '1:1000:ar',
      metaId: 'tt0000001',
      lang: 'argt',
      key: 'deadbeef',
      ext: 'srt',
    });
    const parts = name.split('__');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('stremio');
    expect(parts[1]).toBe('GTSubs');
    expect(parts[2]).toBe('11000ar');
    expect(parts[3]).toBe('tt0000001');
    expect(parts[4]).toBe('argt');
    expect(parts[5]).toBe('deadbeef.srt');
  });

  it('sanitizes separators and spaces out of every part', () => {
    const name = buildAddonSubtitleFilename({
      addonName: 'My Addon__X',
      label: 'A B/C',
      metaId: 'tt1_2',
      lang: 'ar',
      key: 'k-1',
      ext: 'vtt',
    });
    expect(name.replace(/\.(srt|vtt)$/, '')).not.toMatch(/[^a-zA-Z0-9_]/);
    expect(name.split('__')).toHaveLength(6);
    expect(name.endsWith('.vtt')).toBe(true);
  });

  it('never creates double underscores from multiple spaces or punctuation', () => {
    const name = buildAddonSubtitleFilename({
      addonName: 'OpenSubtitles   v3 (VIP)',
      label: 'Movie - 1080p -- WebRip',
      metaId: 'tt0000001',
      lang: 'en',
      key: 'abc',
      ext: 'srt',
    });
    const parts = name.split('__');
    expect(parts).toHaveLength(6);
    expect(parts[1]).toBe('OpenSubtitles_v3_VIP');
    expect(parts[2]).toBe('Movie_1080p_WebRip');
  });

  it('substitutes fallbacks for missing parts', () => {
    const name = buildAddonSubtitleFilename({ key: 'k', ext: 'srt' });
    expect(name.split('__')).toHaveLength(6);
    expect(name).toContain('Addon');
    expect(name).toContain('und');
  });
});

describe('parseQueuePlaceholder', () => {
  it('detects a full translation queue', () => {
    expect(parseQueuePlaceholder(ADDON_QUEUE_FULL_SAMPLE)).toEqual({ queued: true, full: true, position: null, eta: null });
  });

  it('detects a queued job and extracts its position', () => {
    expect(parseQueuePlaceholder(ADDON_QUEUED_SAMPLE)).toEqual({ queued: true, full: false, position: 9, eta: null });
  });

  it('detects an actively translating job and extracts its estimated time', () => {
    const text = '1\n00:00:00,000 --> 02:00:00,000\n• Subtitle add-on •\nTranslating... (~3 minutes)';
    expect(parseQueuePlaceholder(text)).toEqual({ queued: true, full: false, position: null, eta: '~3 minutes' });
  });

  it('reports an unknown position and no eta when the add-on omits them', () => {
    const text = '1\n00:00:00,000 --> 02:00:00,000\n• Subtitle add-on •\nYour process has been queued';
    expect(parseQueuePlaceholder(text)).toEqual({ queued: true, full: false, position: null, eta: null });
  });

  it('does not flag a finished file that opens with banner cues', () => {
    expect(parseQueuePlaceholder(ADDON_FINISHED_SAMPLE)).toEqual({ queued: false, full: false, position: null, eta: null });
  });

  it('uses the two-hour cue span as a fallback signal', () => {
    const text = '1\n00:00:00,000 --> 02:00:00,000\n• Subtitle add-on •\nPlease wait';
    expect(parseQueuePlaceholder(text)).toEqual({ queued: true, full: false, position: null, eta: null });
  });

  it('ignores empty or unrelated content', () => {
    expect(parseQueuePlaceholder('')).toEqual({ queued: false, full: false, position: null, eta: null });
    expect(parseQueuePlaceholder(null)).toEqual({ queued: false, full: false, position: null, eta: null });
    expect(parseQueuePlaceholder('1\n00:00:00,000 --> 00:00:02,000\nHello there').queued).toBe(false);
  });
});

describe('addonQueueStatusText', () => {
  /** Real i18n bindings, so a missing key or placeholder fails the test too. */
  async function subtitlesT() {
    const { default: i18n } = await import('../../i18n');
    return i18n.getFixedT(null, 'subtitles');
  }

  function queue(overrides: Partial<AddonQueueState> = {}): AddonQueueState {
    return { queued: true, full: false, position: null, eta: null, ...overrides };
  }

  it('words every queue state and always labels the wait estimate', async () => {
    const t = await subtitlesT();

    expect(addonQueueStatusText(queue({ full: true }), t)).toBe('Queue full');
    expect(addonQueueStatusText(queue({ position: 9 }), t)).toBe('Queued #9');
    expect(addonQueueStatusText(queue({ eta: '~3 minutes' }), t)).toBe('Translating… ~3 minutes');
    expect(addonQueueStatusText(queue({}), t)).toBe('Queued');
  });

  it('keeps the position and the estimate together instead of dropping one', async () => {
    const t = await subtitlesT();

    // The toast used to render the position only, while the modal badge also
    // showed the ETA — both now come from this one string.
    expect(addonQueueStatusText(queue({ position: 9, eta: '~3 minutes' }), t)).toBe(
      'Queued #9 (Translating… ~3 minutes)'
    );
  });
});
