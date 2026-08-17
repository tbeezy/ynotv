import { describe, it, expect } from 'vitest';
import { parseFilename, groupLocal, sortGroups } from '../local-library';
import { parseNfo } from '../sidecars';
import type { LocalEntry } from '../types';

describe('Local Library - Filename Parser', () => {
  it('parses movie filenames with year and resolution', () => {
    const res = parseFilename('Inception.2010.1080p.BluRay.x264.mkv');
    expect(res.title).toBe('Inception');
    expect(res.year).toBe(2010);
    expect(res.type).toBe('movie');
    expect(res.resolution).toBe('1080p');
    expect(res.season).toBeNull();
    expect(res.episode).toBeNull();
  });

  it('parses TV show filenames with S01E02 format', () => {
    const res = parseFilename('Breaking.Bad.S01E05.Gray.Matter.720p.HDTV.mkv');
    expect(res.title).toBe('Breaking Bad');
    expect(res.type).toBe('show');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(5);
    expect(res.resolution).toBe('720p');
  });

  it('parses TV show filenames with 1x02 format', () => {
    const res = parseFilename('The.Office.US.2x04.The.Fire.1080p.WEB-DL.mp4');
    expect(res.title).toBe('The Office US');
    expect(res.type).toBe('show');
    expect(res.season).toBe(2);
    expect(res.episode).toBe(4);
  });

  it('parses TV show filenames with Season 1 Episode 2 format', () => {
    const res = parseFilename('Stranger Things Season 1 Episode 3 2160p UHD.mkv');
    expect(res.title).toBe('Stranger Things');
    expect(res.type).toBe('show');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(3);
    expect(res.resolution).toBe('2160p');
  });

  it('cleans brackets and release tags', () => {
    const res = parseFilename('[YTS.MX] Interstellar (2014) [1080p] [WEBRip] [5.1] [YIFY].mp4');
    expect(res.title).toBe('Interstellar');
    expect(res.year).toBe(2014);
    expect(res.type).toBe('movie');
    expect(res.resolution).toBe('1080p');
  });
});

describe('Local Library - Grouping & Sorting', () => {
  const mockEntries: LocalEntry[] = [
    {
      id: '1',
      path: '/movies/Avatar.2009.mkv',
      filename: 'Avatar.2009.mkv',
      title: 'Avatar',
      year: 2009,
      type: 'movie',
      rating: 7.9,
      addedAt: 1000,
    },
    {
      id: '2',
      path: '/tv/Loki.S01E01.mkv',
      filename: 'Loki.S01E01.mkv',
      title: 'Loki',
      year: 2021,
      type: 'show',
      season: 1,
      episode: 1,
      rating: 8.2,
      addedAt: 2000,
    },
    {
      id: '3',
      path: '/tv/Loki.S01E02.mkv',
      filename: 'Loki.S01E02.mkv',
      title: 'Loki',
      year: 2021,
      type: 'show',
      season: 1,
      episode: 2,
      rating: 8.2,
      addedAt: 3000,
    },
  ];

  it('groups movies individually and series by title/id', () => {
    const groups = groupLocal(mockEntries);
    expect(groups).toHaveLength(2);

    const movieGroup = groups.find((g) => g.kind === 'movie');
    expect(movieGroup).toBeDefined();
    if (movieGroup?.kind === 'movie') {
      expect(movieGroup.entry.title).toBe('Avatar');
    }

    const showGroup = groups.find((g) => g.kind === 'show');
    expect(showGroup).toBeDefined();
    if (showGroup?.kind === 'show') {
      expect(showGroup.head.title).toBe('Loki');
      expect(showGroup.episodes).toHaveLength(2);
      expect(showGroup.episodes[0].episode).toBe(1);
      expect(showGroup.episodes[1].episode).toBe(2);
    }
  });

  it('sorts groups by rating descending and ascending', () => {
    const groups = groupLocal(mockEntries);
    const sortedDesc = sortGroups(groups, 'rating', 'desc');
    expect(sortedDesc[0].kind === 'show' ? sortedDesc[0].head.title : sortedDesc[0].entry.title).toBe('Loki');

    const sortedAsc = sortGroups(groups, 'rating', 'asc');
    expect(sortedAsc[0].kind === 'movie' ? sortedAsc[0].entry.title : sortedAsc[0].head.title).toBe('Avatar');
  });
});

describe('Local Library - NFO Parser', () => {
  it('parses movie XML NFO correctly', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Fight Club</title>
  <year>1999</year>
  <plot>An insomniac office worker and a devil-may-care soap maker form an underground fight club.</plot>
  <rating>8.8</rating>
  <runtime>139</runtime>
  <uniqueid type="tmdb" default="true">550</uniqueid>
  <uniqueid type="imdb">tt0137523</uniqueid>
</movie>`;

    const parsed = parseNfo(xml);
    expect(parsed.title).toBe('Fight Club');
    expect(parsed.year).toBe(1999);
    expect(parsed.rating).toBe(8.8);
    expect(parsed.runtime).toBe(139);
    expect(parsed.tmdbId).toBe(550);
    expect(parsed.imdbId).toBe('tt0137523');
    expect(parsed.plot).toContain('underground fight club');
  });

  it('parses tvshow XML NFO correctly', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>Severance</title>
  <premiered>2022-02-18</premiered>
  <plot>Mark leads a team of office workers whose memories have been surgically divided.</plot>
  <tmdbid>95396</tmdbid>
  <imdbid>tt11280740</imdbid>
</tvshow>`;

    const parsed = parseNfo(xml);
    expect(parsed.title).toBe('Severance');
    expect(parsed.year).toBe(2022);
    expect(parsed.tmdbId).toBe(95396);
    expect(parsed.imdbId).toBe('tt11280740');
  });
});

describe('Local Library - Folder Management', () => {
  it('adds and removes scanned folders properly', async () => {
    const { addScannedFolder, readScannedFolders, removeScannedFolder, addLocalEntries, readLocalLibrary } = await import('../local-library');

    addScannedFolder('C:/Media/Movies');
    expect(readScannedFolders()).toContain('C:/Media/Movies');

    addLocalEntries([
      {
        id: 'C:/Media/Movies/Alien.1979.mkv',
        path: 'C:/Media/Movies/Alien.1979.mkv',
        filename: 'Alien.1979.mkv',
        title: 'Alien',
        year: 1979,
        type: 'movie',
        addedAt: Date.now(),
      },
    ]);
    expect(readLocalLibrary().some((e) => e.title === 'Alien')).toBe(true);

    removeScannedFolder('C:/Media/Movies');
    expect(readScannedFolders()).not.toContain('C:/Media/Movies');
    expect(readLocalLibrary().some((e) => e.title === 'Alien')).toBe(false);
  });
});

describe('Local Library - Metadata Cache', () => {
  it('reads cached cast and season episodes from storage without network', async () => {
    const { getCachedCast, getCachedSeasonEpisodes } = await import('../metadata-cache');

    localStorage.setItem('ynotv.local.cache.cast.movie_550', JSON.stringify([
      { id: 1, name: 'Brad Pitt', character: 'Tyler Durden', profilePath: null },
    ]));

    const cast = await getCachedCast(550, 'movie', null);
    expect(cast).toHaveLength(1);
    expect(cast[0].name).toBe('Brad Pitt');

    localStorage.setItem('ynotv.local.cache.season.95396_s1', JSON.stringify([
      { episode_number: 1, name: 'Good News About Hell', overview: 'Mark Scout leads...', still_path: null },
    ]));

    const episodes = await getCachedSeasonEpisodes(95396, 1, null);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].name).toBe('Good News About Hell');
  });
});

describe('Local Library - Auto Sync', () => {
  it('skips sync when no folders are configured', async () => {
    const { syncLocalFolders } = await import('../auto-sync');
    localStorage.removeItem('ynotv.library.local.folders.v1');
    const res = await syncLocalFolders(null, true);
    expect(res).toEqual({ added: 0, removed: 0 });
  });
});



