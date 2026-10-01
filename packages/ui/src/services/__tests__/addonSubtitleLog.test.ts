/**
 * The add-on subtitle trace is the only place the pipeline is observable at
 * runtime, so its two sinks need pinning: the diagnostics ring is always
 * written (a user can copy it without having prepared anything), while the
 * console sink only speaks once the trace or debug logging is opted into.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addonSubError,
  addonSubLangSummary,
  addonSubLog,
  addonSubPreview,
  isAddonSubtitleTraceEnabled,
  setAddonSubtitleTraceEnabled,
} from '../addonSubtitleLog';
import { useSubtitleDebugStore } from '../../stores/subtitleDebugStore';

const ring = () => useSubtitleDebugStore.getState().entries;

describe('add-on subtitle trace', () => {
  beforeEach(() => {
    useSubtitleDebugStore.getState().clearSubLogs();
    setAddonSubtitleTraceEnabled(false);
    vi.restoreAllMocks();
  });

  it('always records to the diagnostics ring, even while opted out', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    addonSubLog('fetch', 'GTSubs → https://subs.example.test/ar.json');

    expect(ring()).toHaveLength(1);
    expect(ring()[0].area).toBe('addon:fetch');
    expect(ring()[0].msg).toContain('GTSubs');
    expect(info).not.toHaveBeenCalled();
    expect(isAddonSubtitleTraceEnabled()).toBe(false);
  });

  it('reaches the console once the Settings -> Debug switch is on', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    setAddonSubtitleTraceEnabled(true);

    addonSubLog('download', 'wrote subtitles/stremio__GTSubs__Arabic__tt1__ar__abcd1234.srt');

    expect(isAddonSubtitleTraceEnabled()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('[Stremio][addon-subs][download]');
  });

  it('keeps a failure in the ring and off the console while opted out', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    addonSubError('load', 'download failed for https://subs.example.test/ar.srt', new Error('HTTP 503'));

    expect(ring()[0].area).toBe('addon:load');
    expect(ring()[0].msg).toContain('HTTP 503');
    expect(error).not.toHaveBeenCalled();
  });

  it('summarises a track list busiest language first', () => {
    expect(
      addonSubLangSummary([
        { lang: 'en' },
        { lang: 'en' },
        { lang: 'ar' },
      ])
    ).toBe('en=2, ar=1');

    expect(addonSubLangSummary([{ langCode: 'ar' }, { langCode: 'ar' }, { langCode: 'pob' }], 'langCode')).toBe(
      'ar=2, pob=1'
    );
    expect(addonSubLangSummary([])).toBe('none');
    expect(addonSubLangSummary(undefined)).toBe('none');
  });

  it('flattens and caps a response body preview', () => {
    expect(addonSubPreview('  Your process\nhas been   queued  ')).toBe('Your process has been queued');
    expect(addonSubPreview('')).toBe('(empty)');
    expect(addonSubPreview(null)).toBe('(empty)');

    const long = addonSubPreview('x'.repeat(300), 120);
    expect(long).toHaveLength(121); // capped body + the ellipsis
    expect(long.endsWith('…')).toBe(true);
  });
});
