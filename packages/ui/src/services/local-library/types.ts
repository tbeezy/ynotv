export type LocalArt = {
  poster?: string;
  logo?: string;
  backdrop?: string;
};

export type LocalEntry = {
  id: string;
  path: string;
  filename: string;
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  resolution?: string | null;
  rating?: number | null;
  runtime?: number | null;
  poster?: string | null;
  backdrop?: string | null;
  logo?: string | null;
  overview?: string | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  addedAt: number;
  needsReview?: boolean;
  /**
   * True when the user skipped metadata matching for this item from the
   * review flow. Skipped items stay in the library with their parsed title
   * but are excluded from the review queue/banner and are never re-matched
   * by scans (a manual "Fix match" clears this flag).
   */
  reviewSkipped?: boolean;
  source?: 'tmdb' | 'nfo';
  localArt?: LocalArt;
  /**
   * True when the user manually edited this entry (Fix match, or season/
   * episode/title via the edit modal). Locked entries keep their manual
   * season/episode/title and match identity when a re-scan or auto-sync
   * rebuilds them, so overrides survive re-scans.
   */
  metadataLocked?: boolean;
  /**
   * True when the underlying file or its parent folder is not accessible on
   * disk (e.g. deleted, renamed, or drive unplugged).
   */
  unavailable?: boolean;
};

export type ParsedFilename = {
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  season: number | null;
  episode: number | null;
  resolution: string | null;
};

export type ScannedFile = {
  path: string;
  filename: string;
  size: number;
  folderPath?: string;
  folderType?: FolderType;
};

export type ParsedNfo = {
  title?: string;
  year?: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  plot?: string | null;
  showTitle?: string;
  rating?: number | null;
  runtime?: number | null;
  art?: LocalArt;
};

export type IdentifyResolution = {
  tmdbId: number;
  imdbId: string | null;
  poster: string | null;
  backdrop: string | null;
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  overview?: string | null;
  rating?: number | null;
  runtime?: number | null;
};

export type LocalGroup =
  | { kind: 'movie'; entry: LocalEntry }
  | { kind: 'show'; key: string; head: LocalEntry; episodes: LocalEntry[] };

export type LocalSortKey = 'added' | 'name' | 'rating' | 'year';
export type SortDir = 'asc' | 'desc';

/**
 * What a configured scan folder is expected to contain.
 *
 * - 'movie': every file is a movie (parsed from its filename, one TMDB lookup
 *   per file).
 * - 'show': the folder holds series, structured as `<Series Name>/` with either
 *   `Season N/` subfolders or all episodes flat inside the series folder. Each
 *   series does ONE TMDB lookup (shared by every episode via the per-title
 *   cache) — matches standard media library conventions.
 * - 'mixed': legacy folders added before folders were typed. Falls back to the
 *   old per-file parsing/matching so existing libraries keep working.
 */
export type FolderType = 'movie' | 'show' | 'mixed';

export type LibraryFolder = {
  path: string;
  type: FolderType;
};

/** Info derived from a file's path inside a series scan root. */
export type SeriesPathInfo = {
  /** Series title parsed from the series folder name. */
  title: string;
  /** Year parsed from the series folder name (e.g. "Breaking Bad (2008)"). */
  year: number | null;
  /** Season from a `Season N` / `S0N` / `Specials` subfolder, else from filename. */
  season: number | null;
  /** Episode number parsed from the filename. */
  episode: number | null;
  /** Resolution parsed from the filename. */
  resolution: string | null;
};
