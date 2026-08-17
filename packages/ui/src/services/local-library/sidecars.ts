import type { LocalArt, ParsedNfo } from './types';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function pathMod() {
  return await import('@tauri-apps/api/path');
}

// Fallback split if path API is not available
function fallbackSplitPath(videoPath: string): { dir: string; stem: string } {
  const norm = videoPath.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  const dir = lastSlash >= 0 ? videoPath.slice(0, lastSlash) : '.';
  const base = lastSlash >= 0 ? videoPath.slice(lastSlash + 1) : videoPath;
  const stem = base.replace(/\.[^.]+$/, '');
  return { dir, stem };
}

function fallbackJoin(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${file}` : `${dir}${sep}${file}`;
}

async function splitVideoPath(videoPath: string): Promise<{ dir: string; stem: string }> {
  try {
    const p = await pathMod();
    const dir = await p.dirname(videoPath);
    const base = await p.basename(videoPath);
    const stem = base.replace(/\.[^.]+$/, '');
    return { dir, stem };
  } catch {
    return fallbackSplitPath(videoPath);
  }
}

const dirCache = new Map<string, Map<string, string>>();

export function clearSidecarCache(): void {
  dirCache.clear();
}

async function dirIndex(dir: string): Promise<Map<string, string>> {
  const cached = dirCache.get(dir);
  if (cached) return cached;
  const out = new Map<string, string>();
  if (!isTauri) return out;
  try {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(dir);
    for (const e of entries) {
      if (e.isFile) out.set(e.name.toLowerCase(), e.name);
    }
  } catch {
    /* unreadable dir */
  }
  dirCache.set(dir, out);
  return out;
}

export async function countNfoFor(videoPaths: string[]): Promise<number> {
  if (!isTauri) return 0;
  let count = 0;
  for (const p of videoPaths) {
    if (await findNfo(p)) count += 1;
  }
  return count;
}

async function resolveIn(
  dir: string,
  index: Map<string, string>,
  candidates: string[],
): Promise<string | null> {
  for (const cand of candidates) {
    const actual = index.get(cand.toLowerCase());
    if (actual) {
      try {
        const p = await pathMod();
        return await p.join(dir, actual);
      } catch {
        return fallbackJoin(dir, actual);
      }
    }
  }
  return null;
}

async function dirAndParent(dir: string): Promise<string[]> {
  try {
    const p = await pathMod();
    const parent = await p.dirname(dir);
    return parent && parent !== dir ? [dir, parent] : [dir];
  } catch {
    const fallback = fallbackSplitPath(dir).dir;
    return fallback && fallback !== dir ? [dir, fallback] : [dir];
  }
}

async function resolveInDirs(dirs: string[], candidates: string[]): Promise<string | null> {
  for (const dir of dirs) {
    const hit = await resolveIn(dir, await dirIndex(dir), candidates);
    if (hit) return hit;
  }
  return null;
}

export async function findNfo(videoPath: string): Promise<string | null> {
  if (!isTauri) return null;
  const { dir, stem } = await splitVideoPath(videoPath);
  const index = await dirIndex(dir);
  return resolveIn(dir, index, [`${stem}.nfo`, 'movie.nfo', 'tvshow.nfo']);
}

export async function findLocalArt(videoPath: string): Promise<LocalArt> {
  if (!isTauri) return {};
  const { dir, stem } = await splitVideoPath(videoPath);
  const index = await dirIndex(dir);
  const [poster, backdrop, logo] = await Promise.all([
    resolveIn(dir, index, [
      `${stem}-poster.jpg`, `${stem}-poster.png`, 'poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg',
    ]),
    resolveIn(dir, index, [
      `${stem}-fanart.jpg`, `${stem}-fanart.png`, 'fanart.jpg', 'fanart.png', 'backdrop.jpg', 'backdrop.png',
    ]),
    resolveIn(dir, index, [
      `${stem}-clearlogo.png`, `${stem}-logo.png`, 'clearlogo.png', 'logo.png',
    ]),
  ]);
  const art: LocalArt = {};
  if (poster) art.poster = poster;
  if (backdrop) art.backdrop = backdrop;
  if (logo) art.logo = logo;
  return art;
}

export async function findShowNfo(videoPath: string): Promise<string | null> {
  if (!isTauri) return null;
  const { dir } = await splitVideoPath(videoPath);
  return resolveInDirs(await dirAndParent(dir), ['tvshow.nfo']);
}

export async function findShowArt(
  videoPath: string,
  season: number | null,
): Promise<LocalArt> {
  if (!isTauri) return {};
  const { dir } = await splitVideoPath(videoPath);
  const dirs = await dirAndParent(dir);
  const seasonTag =
    season != null ? `season${String(season).padStart(2, '0')}-poster` : null;
  const posterNames = [
    'poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg',
    ...(seasonTag ? [`${seasonTag}.jpg`, `${seasonTag}.png`] : []),
  ];
  const [poster, backdrop, logo] = await Promise.all([
    resolveInDirs(dirs, posterNames),
    resolveInDirs(dirs, ['fanart.jpg', 'fanart.png', 'backdrop.jpg', 'backdrop.png']),
    resolveInDirs(dirs, ['clearlogo.png', 'logo.png']),
  ]);
  const art: LocalArt = {};
  if (poster) art.poster = poster;
  if (backdrop) art.backdrop = backdrop;
  if (logo) art.logo = logo;
  return art;
}

export async function readNfo(nfoPath: string): Promise<ParsedNfo | null> {
  if (!isTauri) return null;
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const xml = await readTextFile(nfoPath);
    return parseNfo(xml);
  } catch {
    return null;
  }
}

export function parseNfo(xml: string): ParsedNfo {
  const out: ParsedNfo = {};
  let doc: Document | null = null;
  if (typeof DOMParser !== 'undefined') {
    try {
      doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (doc.querySelector('parsererror')) doc = null;
    } catch {
      doc = null;
    }
  }

  if (doc) {
    const text = (sel: string): string | undefined =>
      doc!.querySelector(sel)?.textContent?.trim() || undefined;

    out.title = text('title') ?? text('originaltitle');
    out.showTitle = text('showtitle');

    const yearRaw =
      text('year') ??
      (text('premiered') || text('aired') || text('releasedate'))?.slice(0, 4);
    const yearNum = yearRaw ? parseInt(yearRaw, 10) : NaN;
    out.year = Number.isFinite(yearNum) ? yearNum : null;

    out.plot = text('plot') ?? text('outline') ?? null;

    const ratingRaw =
      text('rating') ?? doc.querySelector('ratings rating value')?.textContent?.trim();
    const ratingNum = ratingRaw ? parseFloat(ratingRaw) : NaN;
    out.rating = Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum : null;

    const runtimeRaw = text('runtime');
    const runtimeNum = runtimeRaw ? parseInt(runtimeRaw.replace(/\D/g, ''), 10) : NaN;
    out.runtime = Number.isFinite(runtimeNum) && runtimeNum > 0 ? runtimeNum : null;

    let tmdb: string | undefined;
    let imdb: string | undefined;
    for (const el of Array.from(doc.querySelectorAll('uniqueid'))) {
      const type = el.getAttribute('type')?.toLowerCase();
      const val = el.textContent?.trim();
      if (!val) continue;
      if (type === 'tmdb') tmdb = val;
      else if (type === 'imdb') imdb = val;
    }
    tmdb = tmdb ?? text('tmdbid');
    imdb = imdb ?? text('imdbid');
    const legacyId = text('id');
    if (!imdb && legacyId && legacyId.startsWith('tt')) imdb = legacyId;
    if (!tmdb && legacyId && /^\d+$/.test(legacyId)) tmdb = legacyId;

    const tmdbNum = tmdb ? parseInt(tmdb, 10) : NaN;
    out.tmdbId = Number.isFinite(tmdbNum) ? tmdbNum : null;
    out.imdbId = imdb && imdb.startsWith('tt') ? imdb : null;

    out.art = parseNfoArt(doc);
    return out;
  }

  // Regex-based fallback for node/test environments
  const tag = (name: string): string | undefined => {
    const rx = new RegExp(`<${name}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
    const m = xml.match(rx);
    return m ? m[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').trim() : undefined;
  };

  out.title = tag('title') ?? tag('originaltitle');
  out.showTitle = tag('showtitle');

  const yearRaw =
    tag('year') ??
    (tag('premiered') || tag('aired') || tag('releasedate'))?.slice(0, 4);
  const yearNum = yearRaw ? parseInt(yearRaw, 10) : NaN;
  out.year = Number.isFinite(yearNum) ? yearNum : null;

  out.plot = tag('plot') ?? tag('outline') ?? null;

  const ratingRaw = tag('rating') ?? tag('value');
  const ratingNum = ratingRaw ? parseFloat(ratingRaw) : NaN;
  out.rating = Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum : null;

  const runtimeRaw = tag('runtime');
  const runtimeNum = runtimeRaw ? parseInt(runtimeRaw.replace(/\D/g, ''), 10) : NaN;
  out.runtime = Number.isFinite(runtimeNum) && runtimeNum > 0 ? runtimeNum : null;

  let tmdb: string | undefined = tag('tmdbid');
  let imdb: string | undefined = tag('imdbid');

  const uniqueIdRx = /<uniqueid\s+type=["']([^"']+)["'][^>]*>([\s\S]*?)<\/uniqueid>/gi;
  let uMatch;
  while ((uMatch = uniqueIdRx.exec(xml))) {
    const type = uMatch[1].toLowerCase();
    const val = uMatch[2].trim();
    if (type === 'tmdb') tmdb = val;
    else if (type === 'imdb') imdb = val;
  }

  const legacyId = tag('id');
  if (!imdb && legacyId && legacyId.startsWith('tt')) imdb = legacyId;
  if (!tmdb && legacyId && /^\d+$/.test(legacyId)) tmdb = legacyId;

  const tmdbNum = tmdb ? parseInt(tmdb, 10) : NaN;
  out.tmdbId = Number.isFinite(tmdbNum) ? tmdbNum : null;
  out.imdbId = imdb && imdb.startsWith('tt') ? imdb : null;

  return out;
}

function parseNfoArt(doc: Document): LocalArt | undefined {
  const thumbs = Array.from(doc.querySelectorAll('thumb'));
  const val = (el: Element | undefined) => el?.textContent?.trim() || undefined;
  const byAspect = (aspect: string) =>
    thumbs.filter((el) => el.getAttribute('aspect') === aspect);

  const poster = val(byAspect('poster').find((el) => !el.getAttribute('season')));
  const logo = val(byAspect('clearlogo')[0] ?? byAspect('logo')[0] ?? byAspect('clearart')[0]);
  const backdrop =
    val(doc.querySelector('fanart thumb') ?? undefined) ?? val(byAspect('landscape')[0]);

  const art: LocalArt = {};
  if (poster) art.poster = poster;
  if (logo) art.logo = logo;
  if (backdrop) art.backdrop = backdrop;
  return art.poster || art.logo || art.backdrop ? art : undefined;
}
