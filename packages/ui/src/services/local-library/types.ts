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
  source?: 'tmdb' | 'nfo';
  localArt?: LocalArt;
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
