/**
 * On-demand download of a single Stremio/Nuvio subtitle add-on track.
 *
 * Add-ons are only ever asked for the one track the user actually needs: an
 * eager batch download of every returned track floods translation add-ons
 * (GTSubs allows 10 concurrent jobs) and litters app data with files nobody
 * reads.
 */
import { BaseDirectory, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { addonTrackLabel, buildAddonSubtitleFilename, parseQueuePlaceholder, type AddonSubtitleTrack } from '../utils/stremioSubs';
import { addonSubError, addonSubLog, addonSubPreview } from './addonSubtitleLog';

export interface AddonSubtitleDownload {
  /** Absolute path handed to mpv. */
  filePath: string;
  /** Path relative to the app-local data directory. */
  relPath: string;
  ext: 'srt' | 'vtt';
  text: string;
}

/**
 * Add-on URLs routinely contain invalid raw characters (spaces, unencoded
 * brackets). Normalise only when the URL already carries escapes.
 */
export function encodeSubtitleUrl(url: string): string {
  if (!url) return '';
  try {
    return url.includes('%') ? encodeURI(decodeURI(url)) : encodeURI(url);
  } catch {
    return url;
  }
}

export function detectSubtitleExt(url: string, text: string): 'srt' | 'vtt' {
  const isVtt = url.toLowerCase().includes('.vtt') || text.includes('WEBVTT');
  return isVtt ? 'vtt' : 'srt';
}

/** Download one track and store it under `<appLocalData>/subtitles/`. */
export async function downloadAddonSubtitle(
  track: AddonSubtitleTrack,
  metaId: string
): Promise<AddonSubtitleDownload> {
  const safeUrl = encodeSubtitleUrl(track.url);
  if (!safeUrl) throw new Error('Subtitle track has no URL');

  addonSubLog('download', `${track.origin} ${track.lang} → ${safeUrl}`);

  let text: string;
  let status = 0;
  const proxy = window.fetchProxy;
  if (proxy?.fetch) {
    const res = await proxy.fetch(safeUrl);
    status = res?.data?.status ?? 0;
    if (res?.error) {
      addonSubError('download', `proxy failed for ${safeUrl}`, res.error);
      throw new Error(res.error);
    }
    if (!res?.data?.ok) {
      addonSubError('download', `HTTP ${res?.data?.status ?? 'error'} for ${safeUrl}`, addonSubPreview(res?.data?.text, 160));
      throw new Error(`HTTP ${res?.data?.status ?? 'error'} for ${safeUrl}`);
    }
    text = res.data.text ?? '';
  } else {
    const res = await fetch(safeUrl);
    status = res.status;
    if (!res.ok) {
      addonSubError('download', `HTTP ${res.status} for ${safeUrl}`);
      throw new Error(`HTTP ${res.status} for ${safeUrl}`);
    }
    text = await res.text();
  }

  const ext = detectSubtitleExt(track.url, text);
  addonSubLog(
    'download',
    `HTTP ${status || '?'} — ${text.length} char(s), ${ext}; head: ${addonSubPreview(text, 160)}`
  );
  const filename = buildAddonSubtitleFilename({
    addonName: track.origin,
    label: addonTrackLabel(track),
    metaId,
    lang: track.lang,
    key: track.trackKey,
    ext,
  });
  const relPath = `subtitles/${filename}`;
  let filePath = '';

  if (!parseQueuePlaceholder(text).queued) {
    const appDir = await appLocalDataDir();
    await mkdir('subtitles', { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
    await writeTextFile(relPath, text, { baseDir: BaseDirectory.AppLocalData });
    filePath = await join(appDir, relPath);
    addonSubLog('download', `wrote ${relPath}`);
  } else {
    const queue = parseQueuePlaceholder(text);
    addonSubLog(
      'download',
      `queue placeholder (full=${queue.full}, position=${queue.position}, eta=${queue.eta}) — nothing written to disk`
    );
  }

  return { filePath, relPath, ext, text };
}
