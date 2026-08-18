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

describe('Local Library - VOD Stored Converters', () => {
  it('converts LocalEntry to StoredMovie correctly', async () => {
    const { localEntryToStoredMovie } = await import('../local-library');
    const movieEntry: LocalEntry = {
      id: 'C:/Movies/Gladiator.2000.mkv',
      path: 'C:/Movies/Gladiator.2000.mkv',
      filename: 'Gladiator.2000.mkv',
      title: 'Gladiator',
      year: 2000,
      type: 'movie',
      rating: 8.5,
      runtime: 155,
      poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      overview: 'A former Roman General sets out to exact vengeance.',
      addedAt: 1600000000000,
      tmdbId: 98,
      imdbId: 'tt0172495',
    };

    const stored = localEntryToStoredMovie(movieEntry);
    expect(stored.stream_id).toBe('local_C:/Movies/Gladiator.2000.mkv');
    expect(stored.source_id).toBe('local');
    expect(stored.title).toBe('Gladiator');
    expect(stored.name).toBe('Gladiator');
    expect(stored.year).toBe('2000');
    expect(stored.rating).toBe('8.5');
    expect(stored.duration).toBe(155 * 60);
    expect(stored.direct_url).toBe('C:/Movies/Gladiator.2000.mkv');
    expect(stored.tmdb_id).toBe(98);
    expect(stored.imdb_id).toBe('tt0172495');
    expect(stored.stream_icon).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
    expect(stored.plot).toBe('A former Roman General sets out to exact vengeance.');
  });

  it('converts LocalGroup to StoredSeries correctly', async () => {
    const { localGroupToStoredSeries, localEntryToStoredEpisode } = await import('../local-library');
    const headEntry: LocalEntry = {
      id: 'C:/Shows/Dark/S01E01.mkv',
      path: 'C:/Shows/Dark/S01E01.mkv',
      filename: 'Dark.S01E01.mkv',
      title: 'Dark',
      year: 2017,
      type: 'show',
      season: 1,
      episode: 1,
      rating: 8.7,
      poster: 'https://image.tmdb.org/t/p/w500/dark.jpg',
      overview: 'A family saga with a supernatural twist.',
      addedAt: 1600000000000,
      tmdbId: 70523,
    };

    const ep2Entry: LocalEntry = {
      id: 'C:/Shows/Dark/S01E02.mkv',
      path: 'C:/Shows/Dark/S01E02.mkv',
      filename: 'Dark.S01E02.mkv',
      title: 'Lies',
      year: 2017,
      type: 'show',
      season: 1,
      episode: 2,
      addedAt: 1600000001000,
    };

    const group = {
      key: 'dark',
      head: headEntry,
      episodes: [headEntry, ep2Entry],
    };

    const storedSeries = localGroupToStoredSeries(group);
    expect(storedSeries.series_id).toBe('local_dark');
    expect(storedSeries.source_id).toBe('local');
    expect(storedSeries.title).toBe('Dark');
    expect(storedSeries.year).toBe('2017');
    expect(storedSeries.rating).toBe('8.7');
    expect(storedSeries.cover).toBe('https://image.tmdb.org/t/p/w500/dark.jpg');
    expect(storedSeries.plot).toBe('A family saga with a supernatural twist.');

    const ep1Stored = localEntryToStoredEpisode(headEntry, storedSeries.series_id, storedSeries.title);
    expect(ep1Stored.id).toBe(headEntry.id);
    expect(ep1Stored.series_id).toBe('local_dark');
    expect(ep1Stored.season_num).toBe(1);
    expect(ep1Stored.episode_num).toBe(1);
    expect(ep1Stored.title).toBe('Episode 1');
    expect(ep1Stored.direct_url).toBe('C:/Shows/Dark/S01E01.mkv');

    const ep2Stored = localEntryToStoredEpisode(ep2Entry, storedSeries.series_id, storedSeries.title);
    expect(ep2Stored.title).toBe('Lies');
    expect(ep2Stored.episode_num).toBe(2);
  });

  it('filters local movies and series by search query', async () => {
    const { matchesSearch } = await import('../../../utils/searchNormalization');
    const { groupLocal } = await import('../local-library');

    const library: LocalEntry[] = [
      {
        id: '1',
        path: 'C:/Movies/Inception.2010.mkv',
        filename: 'Inception.2010.mkv',
        title: 'Inception',
        year: 2010,
        type: 'movie',
        addedAt: 1000,
      },
      {
        id: '2',
        path: 'C:/Movies/Interstellar.2014.mkv',
        filename: 'Interstellar.2014.mkv',
        title: 'Interstellar',
        year: 2014,
        type: 'movie',
        addedAt: 2000,
      },
      {
        id: '3',
        path: 'C:/Shows/Severance/S01E01.mkv',
        filename: 'Severance.S01E01.mkv',
        title: 'Severance',
        year: 2022,
        type: 'show',
        season: 1,
        episode: 1,
        addedAt: 3000,
      },
    ];

    // Search movies for 'cept'
    const movieMatches = library.filter(
      (e) => e.type !== 'show' && (matchesSearch(e.title, 'cept') || matchesSearch(e.filename, 'cept'))
    );
    expect(movieMatches).toHaveLength(1);
    expect(movieMatches[0].title).toBe('Inception');

    // Search series for 'sever'
    const groups = groupLocal(library);
    const seriesMatches = groups.filter(
      (g) =>
        g.kind === 'show' &&
        (matchesSearch(g.head.title, 'sever') ||
          matchesSearch(g.head.filename, 'sever') ||
          g.episodes.some((ep) => matchesSearch(ep.title, 'sever') || matchesSearch(ep.filename, 'sever')))
    );
    expect(seriesMatches).toHaveLength(1);
    if (seriesMatches[0].kind === 'show') {
      expect(seriesMatches[0].head.title).toBe('Severance');
    }
  });

  it('extracts episode and season numbers from various filename conventions', async () => {
    const { extractEpisodeNumber } = await import('../local-library');

    expect(extractEpisodeNumber('S1E24 LCLA ENG SUB.mp4')).toEqual({ season: 1, episode: 24 });
    expect(extractEpisodeNumber('Show.Name.S02E08.720p.mkv')).toEqual({ season: 2, episode: 8 });
    expect(extractEpisodeNumber('Drama_EP12_1080p.mp4')).toEqual({ season: 1, episode: 12 });
    expect(extractEpisodeNumber('Drama.Ep.05.mkv')).toEqual({ season: 1, episode: 5 });
    expect(extractEpisodeNumber('Show Name - 03 - Episode Title.mkv')).toEqual({ season: 1, episode: 3 });
  });

  it('batches multiple files into a single unified Series group', async () => {
    const { groupLocal, extractEpisodeNumber } = await import('../local-library');

    const unassignedFiles: LocalEntry[] = [
      {
        id: '1',
        path: '/dramas/S1E01 LCLA.mp4',
        filename: 'S1E01 LCLA.mp4',
        title: 'S1E01 LCLA',
        year: null,
        type: 'movie',
        needsReview: true,
        addedAt: 1000,
      },
      {
        id: '2',
        path: '/dramas/S1E02 LCLA.mp4',
        filename: 'S1E02 LCLA.mp4',
        title: 'S1E02 LCLA',
        year: null,
        type: 'movie',
        needsReview: true,
        addedAt: 2000,
      },
      {
        id: '3',
        path: '/dramas/S1E03 LCLA.mp4',
        filename: 'S1E03 LCLA.mp4',
        title: 'S1E03 LCLA',
        year: null,
        type: 'movie',
        needsReview: true,
        addedAt: 3000,
      },
    ];

    // Simulate batch identification
    const identified = unassignedFiles.map((f) => {
      const ep = extractEpisodeNumber(f.filename);
      return {
        ...f,
        tmdbId: 99999,
        title: 'Moonlight Mystique',
        type: 'show' as const,
        season: ep?.season ?? 1,
        episode: ep?.episode ?? 1,
        needsReview: false,
        poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      };
    });

    const groups = groupLocal(identified);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('show');
    if (groups[0].kind === 'show') {
      expect(groups[0].head.title).toBe('Moonlight Mystique');
      expect(groups[0].episodes).toHaveLength(3);
      expect(groups[0].episodes[0].episode).toBe(1);
      expect(groups[0].episodes[1].episode).toBe(2);
      expect(groups[0].episodes[2].episode).toBe(3);
    }
  });
});






