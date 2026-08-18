import { useEffect, useMemo, useState } from 'react';
import type { LocalEntry, LocalGroup, LocalSortKey, ParsedFilename, SortDir } from './types';
import type { VodPlayInfo } from '../../types/media';

const KEY = 'ynotv.library.local.v1';
const FOLDERS_KEY = 'ynotv.library.local.folders.v1';
const subs = new Set<() => void>();

function read(): LocalEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as LocalEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: LocalEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* noop */
  }
  for (const s of subs) s();
}

export function readScannedFolders(): string[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    const saved: string[] = raw ? JSON.parse(raw) : [];
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function saveScannedFolders(folders: string[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* noop */
  }
  for (const s of subs) s();
}

export function addScannedFolder(folder: string): void {
  const norm = folder.trim();
  if (!norm) return;
  const existing = readScannedFolders();
  if (!existing.some((f) => f.toLowerCase() === norm.toLowerCase())) {
    saveScannedFolders([...existing, norm]);
  }
}

export function removeScannedFolder(folder: string): void {
  const norm = folder.replace(/\\/g, '/').toLowerCase();
  const existingFolders = readScannedFolders();
  const nextFolders = existingFolders.filter((f) => f.replace(/\\/g, '/').toLowerCase() !== norm);
  saveScannedFolders(nextFolders);

  // Remove all entries residing under this folder
  const currentEntries = read();
  const remaining = currentEntries.filter((e) => {
    const p = e.path.replace(/\\/g, '/').toLowerCase();
    const prefix = norm.endsWith('/') ? norm : `${norm}/`;
    return !p.startsWith(prefix) && p !== norm;
  });
  write(remaining);
}

export function useScannedFolders(): string[] {
  const [folders, setFolders] = useState<string[]>(() => readScannedFolders());
  useEffect(() => {
    const tick = () => setFolders(readScannedFolders());
    subs.add(tick);
    return () => {
      subs.delete(tick);
    };
  }, []);
  return folders;
}

export function readLocalLibrary(): LocalEntry[] {
  return read();
}

export function addLocalEntries(entries: LocalEntry[]): void {
  if (entries.length === 0) return;
  const existing = read();
  const byPath = new Map(existing.map((e) => [e.path, e]));
  for (const e of entries) byPath.set(e.path, e);
  write(Array.from(byPath.values()).sort((a, b) => b.addedAt - a.addedAt));
}

export function removeLocalEntry(id: string): void {
  write(read().filter((e) => e.id !== id));
}

export function removeLocalEntries(ids: string[]): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  write(read().filter((e) => !idSet.has(e.id)));
}

export function updateLocalEntries(ids: string[], patch: Partial<LocalEntry>): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  let changed = false;
  const next = read().map((e) => {
    if (!idSet.has(e.id)) return e;
    changed = true;
    return { ...e, ...patch };
  });
  if (changed) write(next);
}


export function useLocalLibrary(): LocalEntry[] {
  const [items, setItems] = useState<LocalEntry[]>(() => read());
  useEffect(() => {
    const tick = () => setItems(read());
    subs.add(tick);
    return () => {
      subs.delete(tick);
    };
  }, []);
  return items;
}

const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'm4v', 'mov', 'avi', 'wmv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'flv', 'ogv',
]);

export function isVideoFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTS.has(ext);
}

const NOISE = [
  '1080p', '720p', '2160p', '4k', 'uhd', 'hdr', 'hdr10', 'dv',
  'bluray', 'bdrip', 'brrip', 'webrip', 'web-dl', 'webdl', 'hdtv', 'dvdrip', 'remux',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', '10bit',
  'atmos', 'ddp', 'dts', 'ac3', 'aac',
  'yify', 'yts', 'rarbg', 'fgt', 'evo', 'psa',
];
const NOISE_RX = new RegExp(`\\b(${NOISE.join('|')})\\b`, 'gi');
const TV_RX =
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b|\bseason[\s._-]*(\d{1,2})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,3})\b/i;
const YEAR_RX = /\b(19\d{2}|20\d{2})\b/;

export function parseFilename(filename: string): ParsedFilename {
  const stem = filename.replace(/\.(mkv|mp4|m4v|mov|avi|wmv|webm|ts|m2ts|mpg|mpeg|flv|ogv)$/i, '');
  const tv = stem.match(TV_RX);
  const season = tv ? parseInt(tv[1] ?? tv[3] ?? tv[5], 10) : null;
  const episode = tv ? parseInt(tv[2] ?? tv[4] ?? tv[6], 10) : null;
  const yearMatch = stem.match(YEAR_RX);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  const resMatch = stem.match(/\b(2160p|1080p|720p|480p|4k|uhd)\b/i);
  const resolution = resMatch ? resMatch[1].toLowerCase() : null;
  let title = stem;
  if (tv) title = title.slice(0, tv.index);
  if (yearMatch && yearMatch.index != null && yearMatch.index < title.length) {
    title = title.slice(0, yearMatch.index);
  }
  title = title
    .replace(/[._]+/g, ' ')
    .replace(NOISE_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\[\(\{].*?[\]\)\}]/g, '')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[\s\-–—_]+$/g, '')
    .replace(/^[\s\-–—_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) title = stem;
  return {
    title,
    year,
    type: tv ? 'show' : 'movie',
    season,
    episode,
    resolution,
  };
}

export function episodeLabel(e: LocalEntry): string | null {
  if (e.type === 'show' && e.season != null && e.episode != null) {
    return `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
  }
  return null;
}

export function groupLocal(items: LocalEntry[]): LocalGroup[] {
  const out: LocalGroup[] = [];
  const showIdx = new Map<string, number>();
  for (const it of items) {
    if (it.type !== 'show') {
      out.push({ kind: 'movie', entry: it });
      continue;
    }
    const key = (it.imdbId || (it.tmdbId ? `tmdb_${it.tmdbId}` : null) || it.title || it.filename).toLowerCase();
    const at = showIdx.get(key);
    if (at != null) {
      (out[at] as { episodes: LocalEntry[] }).episodes.push(it);
    } else {
      showIdx.set(key, out.length);
      out.push({ kind: 'show', key, head: it, episodes: [it] });
    }
  }
  for (const g of out) {
    if (g.kind !== 'show') continue;
    g.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    g.head = g.episodes.find((e) => e.poster) ?? g.episodes[0];
  }
  return out;
}

export function sortGroups(
  groups: LocalGroup[],
  sortKey: LocalSortKey,
  sortDir: SortDir,
): LocalGroup[] {
  const mul = sortDir === 'asc' ? 1 : -1;
  const list = [...groups];
  list.sort((a, b) => {
    const headA = a.kind === 'movie' ? a.entry : a.head;
    const headB = b.kind === 'movie' ? b.entry : b.head;
    if (sortKey === 'name') {
      return mul * (headA.title || '').localeCompare(headB.title || '');
    }
    if (sortKey === 'rating') {
      const rA = headA.rating ?? 0;
      const rB = headB.rating ?? 0;
      return mul * (rA - rB);
    }
    if (sortKey === 'year') {
      const yA = headA.year ?? 0;
      const yB = headB.year ?? 0;
      return mul * (yA - yB);
    }
    // 'added'
    const tA = headA.addedAt ?? 0;
    const tB = headB.addedAt ?? 0;
    return mul * (tA - tB);
  });
  return list;
}

/**
 * Converts a LocalEntry into standard VodPlayInfo for playback via MPV
 */
export function localEntryToVodPlayInfo(
  entry: LocalEntry,
  seriesGroup?: { key: string; head: LocalEntry },
): VodPlayInfo {
  const epLabel = episodeLabel(entry);
  const isSeries = entry.type === 'show';
  const seriesTitle = seriesGroup?.head?.title || entry.title;
  const seriesKey = seriesGroup?.key || (entry.imdbId || (entry.tmdbId ? `tmdb_${entry.tmdbId}` : null) || seriesTitle).toLowerCase().replace(/[^a-z0-9]+/g, '_');

  const mediaId = isSeries
    ? `local_${seriesKey}_ep_${entry.id}`
    : `local_${entry.id}`;

  return {
    url: entry.path,
    title: isSeries ? seriesTitle : entry.title,
    year: entry.year ? String(entry.year) : undefined,
    plot: entry.overview ?? undefined,
    type: isSeries ? 'series' : 'movie',
    episodeInfo: epLabel ? `${epLabel}${entry.title && entry.title !== seriesTitle ? ` · ${entry.title}` : ''}` : undefined,
    source_id: 'local',
    mediaId,
    seriesId: isSeries ? `local_${seriesKey}` : undefined,
    episodeId: isSeries ? entry.id : undefined,
    seasonNum: entry.season ?? undefined,
    episodeNum: entry.episode ?? undefined,
    posterUrl: entry.poster || entry.localArt?.poster || seriesGroup?.head?.poster || undefined,
    backdropUrl: entry.backdrop || entry.localArt?.backdrop || seriesGroup?.head?.backdrop || undefined,
    logoUrl: entry.logo || entry.localArt?.logo || undefined,
    tmdbId: entry.tmdbId ?? undefined,
    imdbId: entry.imdbId ?? undefined,
  };
}
