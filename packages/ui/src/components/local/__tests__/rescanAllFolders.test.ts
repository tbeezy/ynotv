import { describe, it, expect, vi } from 'vitest';
import type { FolderType, LibraryFolder, ScannedFile } from '../../../services/local-library/types';
import { buildTmdbEntryForFolder } from '../../../services/local-library/scan';

/**
 * Filter logic matching LocalTab's foldersToRescan memo:
 * In Movies view, targets movie and mixed folders.
 * In Series view, targets show and mixed folders.
 * Otherwise targets all configured folders.
 * Falls back to all configured folders if the filtered set is empty.
 */
function computeFoldersToRescan(
  configuredFolders: LibraryFolder[],
  effFilter: string,
): LibraryFolder[] {
  const filter = effFilter === 'movies' ? 'movie' : effFilter === 'series' ? 'show' : undefined;
  if (!filter) return configuredFolders;
  const matching = configuredFolders.filter((f) => f.type === filter || f.type === 'mixed');
  return matching.length > 0 ? matching : configuredFolders;
}

describe('Rescan all folders feature', () => {
  describe('computeFoldersToRescan', () => {
    const mockFolders: LibraryFolder[] = [
      { path: 'C:/Movies', type: 'movie' },
      { path: 'D:/4K_Movies', type: 'movie' },
      { path: 'E:/TV_Shows', type: 'show' },
      { path: 'F:/Family_Videos', type: 'mixed' },
    ];

    it('returns movie and mixed folders when viewing Movies', () => {
      const result = computeFoldersToRescan(mockFolders, 'movies');
      expect(result.map((f) => f.path)).toEqual([
        'C:/Movies',
        'D:/4K_Movies',
        'F:/Family_Videos',
      ]);
    });

    it('returns show and mixed folders when viewing Series', () => {
      const result = computeFoldersToRescan(mockFolders, 'series');
      expect(result.map((f) => f.path)).toEqual([
        'E:/TV_Shows',
        'F:/Family_Videos',
      ]);
    });

    it('returns all folders when viewing All or unfiltered', () => {
      const resultAll = computeFoldersToRescan(mockFolders, 'all');
      expect(resultAll.length).toBe(4);

      const resultDefault = computeFoldersToRescan(mockFolders, 'favorites');
      expect(resultDefault.length).toBe(4);
    });

    it('falls back to all folders if no section-specific folders match', () => {
      const onlyShows: LibraryFolder[] = [{ path: 'E:/TV_Shows', type: 'show' }];
      const result = computeFoldersToRescan(onlyShows, 'movies');
      expect(result).toEqual(onlyShows);
    });

    it('returns empty array when no folders are configured', () => {
      const result = computeFoldersToRescan([], 'movies');
      expect(result).toEqual([]);
    });
  });

  describe('ScannedFile with per-file folderPath & folderType', () => {
    it('allows ScannedFile to hold folderPath and folderType properties', () => {
      const file: ScannedFile = {
        path: 'C:/Movies/Inception (2010)/Inception.mkv',
        filename: 'Inception.mkv',
        size: 1024 * 1024 * 500,
        folderPath: 'C:/Movies',
        folderType: 'movie',
      };

      expect(file.folderPath).toBe('C:/Movies');
      expect(file.folderType).toBe('movie');
    });

    it('buildTmdbEntryForFolder correctly derives show metadata using folderPath root', async () => {
      const file: ScannedFile = {
        path: 'E:/TV_Shows/Breaking Bad/Season 01/Breaking Bad S01E01.mkv',
        filename: 'Breaking Bad S01E01.mkv',
        size: 5000000,
        folderPath: 'E:/TV_Shows',
        folderType: 'show',
      };

      const entry = await buildTmdbEntryForFolder(
        file,
        file.folderType,
        file.folderPath ?? null,
        null, // No TMDB token in unit test; verifies title/season/episode derivation
      );

      expect(entry.type).toBe('show');
      expect(entry.season).toBe(1);
      expect(entry.episode).toBe(1);
      expect(entry.title).toBe('Breaking Bad');
    });

    it('buildTmdbEntryForFolder correctly handles movie files with movie folderType', async () => {
      const file: ScannedFile = {
        path: 'C:/Movies/Interstellar (2014)/Interstellar.mkv',
        filename: 'Interstellar.mkv',
        size: 8000000,
        folderPath: 'C:/Movies',
        folderType: 'movie',
      };

      const entry = await buildTmdbEntryForFolder(
        file,
        file.folderType,
        file.folderPath ?? null,
        null,
      );

      expect(entry.type).toBe('movie');
      expect(entry.title).toBe('Interstellar');
      expect(entry.year).toBe(2014);
    });
  });
});
