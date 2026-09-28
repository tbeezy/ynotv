import { describe, it, expect } from 'vitest';
import { reviewGroupEntries, reviewGroupIds, reviewGroupKey } from '../review-groups';
import type { LocalEntry, LocalGroup } from '../types';

function entry(
  id: string,
  path: string,
  type: 'movie' | 'show',
  season: number | null,
  episode: number | null,
): LocalEntry {
  return {
    id,
    path,
    filename: path.slice(path.lastIndexOf('/') + 1),
    title: 'Neon Harbor',
    year: 2019,
    type,
    season,
    episode,
    addedAt: 1,
    needsReview: true,
  };
}

const movieEntry = entry('movie-1', 'D:/Films/Heat (1995)/Heat.1995.1080p.mkv', 'movie', null, null);
const movieGroup: LocalGroup = { kind: 'movie', entry: movieEntry };

const episodeOne = entry('ep-1', 'D:/Shows/Neon Harbor/S01/E01.mkv', 'show', 1, 1);
const episodeTwo = entry('ep-2', 'D:/Shows/Neon Harbor/S01/E02.mkv', 'show', 1, 2);
const seriesKey = 'show:D:/Shows/Neon Harbor';
const showGroup: LocalGroup = {
  kind: 'show',
  key: seriesKey,
  head: episodeOne,
  episodes: [episodeOne, episodeTwo],
};

describe('reviewGroupKey', () => {
  it('identifies a movie review unit by its entry id', () => {
    expect(reviewGroupKey(movieGroup)).toBe('movie-1');
  });

  it('identifies a series review unit by its folder key, not an episode id', () => {
    expect(reviewGroupKey(showGroup)).toBe(seriesKey);
  });

  it('survives a rebuilt group object, so resolution can be reported by key', () => {
    // The store hands out fresh group objects after every write; the review list
    // and the identify queue must still agree on which row was handled.
    const rebuilt: LocalGroup = {
      kind: 'show',
      key: showGroup.key,
      head: { ...episodeOne },
      episodes: [{ ...episodeOne }, { ...episodeTwo }],
    };
    expect(rebuilt).not.toBe(showGroup);
    expect(reviewGroupKey(rebuilt)).toBe(reviewGroupKey(showGroup));
  });
});

describe('reviewGroupIds', () => {
  it('is the single movie id for a movie unit', () => {
    expect(reviewGroupIds(movieGroup)).toEqual(['movie-1']);
  });

  it('is every episode id for a series unit', () => {
    expect(reviewGroupIds(showGroup)).toEqual(['ep-1', 'ep-2']);
  });
});

describe('reviewGroupEntries', () => {
  it('wraps the movie entry for the identify modal', () => {
    expect(reviewGroupEntries(movieGroup)).toEqual([movieEntry]);
  });

  it('is the episode list for a series unit', () => {
    expect(reviewGroupEntries(showGroup)).toEqual([episodeOne, episodeTwo]);
  });
});
