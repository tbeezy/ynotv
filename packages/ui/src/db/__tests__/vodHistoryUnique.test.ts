/**
 * vod_history uniqueness: one row per (media_id, media_type).
 *
 * Before this, recordVodWatch() and updateVodWatchProgress() each did a
 * non-atomic SELECT-then-INSERT, and a single playback session has several
 * writers — the VOD click handler records the watch, then the playback-start
 * hook records it again — so two of them could both see "no row" and both
 * INSERT. The same film then appeared twice under Recently Watched even though
 * it was one listing (the reporter's screenshot).
 *
 * These checks run the shipped SQL against a real SQLite rather than a mocked
 * adapter, and assert on rows, not call counts.
 *
 * `node:sqlite` needs Node 22.5+ and, on 22.x, the --experimental-sqlite flag.
 * Skipped rather than failed where it isn't available.
 */
import { describe, expect, it } from 'vitest';
import {
  buildVodHistoryDedupeStatements,
  buildVodWatchProgressSql,
  buildVodWatchRecordSql,
} from '../index';

let DatabaseSync: (new (path: string) => any) | null = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const suite = DatabaseSync ? describe : describe.skip;

/** vod_history as created by schema init, plus the indexes it shipped with. */
const SCHEMA = `
  CREATE TABLE vod_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    watched_at INTEGER NOT NULL,
    progress_seconds INTEGER,
    total_duration INTEGER,
    poster_url TEXT,
    season_num INTEGER,
    episode_num INTEGER,
    episode_title TEXT
  );
  CREATE INDEX idx_vod_history_watched_at ON vod_history(watched_at DESC);
  CREATE INDEX idx_vod_history_media ON vod_history(media_id, media_type);
  CREATE INDEX idx_vod_history_source ON vod_history(source_id);
`;

type Row = Record<string, any>;

/** The repair schema init runs at startup (and v31 runs on an existing DB). */
function applyDedupe(db: any): void {
  for (const stmt of buildVodHistoryDedupeStatements()) {
    db.exec(stmt.sql);
  }
}

/** A database as it looks *before* the repair — the state that could hold duplicates. */
function openUnrepairedDb(): any {
  const db = new DatabaseSync!(':memory:');
  db.exec(SCHEMA);
  return db;
}

/**
 * A database the writers can run against: the invariant is asserted at startup
 * before any playback code touches the table, which is what makes the upserts
 * legal (SQLite rejects ON CONFLICT unless a matching unique index exists).
 */
function openDb(): any {
  const db = openUnrepairedDb();
  applyDedupe(db);
  return db;
}

/** recordVodWatch(), as the VOD click handler and the playback hook call it. */
function record(
  db: any,
  mediaId: string,
  mediaType: 'movie' | 'series' = 'movie',
  opts: { poster?: string | null; season?: number; episode?: number; episodeTitle?: string; watchedAt?: number } = {}
): void {
  db.prepare(buildVodWatchRecordSql({
    season: opts.season !== undefined,
    episode: opts.episode !== undefined,
    episodeTitle: opts.episodeTitle !== undefined,
  })).run(
    mediaId,
    mediaType,
    'src',
    'Coyote vs. Acme',
    opts.watchedAt ?? 1000,
    opts.poster ?? null,
    opts.season ?? null,
    opts.episode ?? null,
    opts.episodeTitle ?? null
  );
}

/** updateVodWatchProgress(), as the stop/progress path calls it. */
function saveProgress(
  db: any,
  mediaId: string,
  mediaType: 'movie' | 'series',
  progressSeconds: number,
  totalDuration: number | null,
  watchedAt = 3000
): void {
  db.prepare(buildVodWatchProgressSql()).run(
    mediaId, mediaType, 'src', 'Coyote vs. Acme', watchedAt, progressSeconds, totalDuration, null
  );
}

const rows = (db: any): Row[] =>
  db.prepare('SELECT * FROM vod_history ORDER BY id').all();

const count = (db: any): number =>
  db.prepare('SELECT COUNT(*) AS c FROM vod_history').get().c;

const seedDuplicatePair = (db: any): void => {
  db.prepare(
    `INSERT INTO vod_history (media_id, media_type, source_id, title, watched_at, progress_seconds, total_duration, poster_url)
     VALUES ('99','movie','src','Coyote vs. Acme',1000,120,3600,NULL),
            ('99','movie','src','Coyote vs. Acme',2000,NULL,NULL,'https://cdn/poster.jpg')`
  ).run();
};

suite('vod_history uniqueness', () => {
  it('repairs the table at startup so the writers have their conflict target', () => {
    const db = openUnrepairedDb();
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_vod_history_unique_media'`).all()
    ).toHaveLength(0);

    applyDedupe(db);

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_vod_history_unique_media'`).all()
    ).toHaveLength(1);
    // The non-unique index it replaces is retired, not left behind.
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_vod_history_media'`).all()
    ).toHaveLength(0);
  });

  it('accepts duplicate rows before the repair, which is the old behaviour', () => {
    const db = openUnrepairedDb();
    seedDuplicatePair(db);
    expect(count(db)).toBe(2);
  });

  it('records a movie watched by two writers as a single row', () => {
    const db = openDb();
    // Both writers resolve "no existing row" before either inserts — the exact
    // interleaving that produced the reported duplicate.
    record(db, '99', 'movie');
    record(db, '99', 'movie');

    expect(count(db)).toBe(1);
    expect(rows(db)[0].media_id).toBe('99');
  });

  it('saves progress when the user exits without creating a second row', () => {
    const db = openDb();
    record(db, '99', 'movie');
    record(db, '99', 'movie');
    saveProgress(db, '99', 'movie', 1800, 3600);

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0].progress_seconds).toBe(1800);
    expect(all[0].total_duration).toBe(3600);
    expect(all[0].watched_at).toBe(3000);
  });

  it('creates the row when progress arrives first', () => {
    const db = openDb();
    saveProgress(db, '99', 'movie', 600, 3600);

    expect(count(db)).toBe(1);
    expect(rows(db)[0].title).toBe('Coyote vs. Acme');
  });

  it('keeps a known duration when a later tick reports none or zero', () => {
    const db = openDb();
    saveProgress(db, '99', 'movie', 1800, 3600);
    saveProgress(db, '99', 'movie', 1850, 0);
    expect(rows(db)[0].total_duration).toBe(3600);

    saveProgress(db, '99', 'movie', 1900, null);
    expect(rows(db)[0].total_duration).toBe(3600);

    saveProgress(db, '99', 'movie', 1950, 7200);
    expect(rows(db)[0].total_duration).toBe(7200);
    expect(rows(db)[0].progress_seconds).toBe(1950);
  });

  it('keeps episode fields when a later record omits them, and updates them when given', () => {
    const db = openDb();
    record(db, 'series-1', 'series', { season: 2, episode: 5, episodeTitle: 'Finale' });
    record(db, 'series-1', 'series');

    expect(count(db)).toBe(1);
    expect(rows(db)[0].season_num).toBe(2);
    expect(rows(db)[0].episode_num).toBe(5);
    expect(rows(db)[0].episode_title).toBe('Finale');

    record(db, 'series-1', 'series', { season: 2, episode: 6, episodeTitle: 'Epilogue' });
    expect(rows(db)[0].episode_num).toBe(6);
    expect(rows(db)[0].episode_title).toBe('Epilogue');
  });

  it('keeps a stored poster when a later record arrives without one', () => {
    const db = openDb();
    // The reported flow: the VOD click handler records the watch with the stream
    // icon, then the playback-start hook records the same movie with no poster.
    record(db, '99', 'movie', { poster: 'https://cdn/stream-icon.jpg' });
    record(db, '99', 'movie', { poster: null });

    expect(count(db)).toBe(1);
    expect(rows(db)[0].poster_url).toBe('https://cdn/stream-icon.jpg');
  });

  it('adopts a new poster when a later record provides one', () => {
    const db = openDb();
    record(db, '99', 'movie', { poster: 'https://cdn/old.jpg' });
    record(db, '99', 'movie', { poster: 'https://cdn/new.jpg' });

    expect(rows(db)[0].poster_url).toBe('https://cdn/new.jpg');
  });

  it('keeps a movie and a series that share a media id apart', () => {
    const db = openDb();
    record(db, 'shared-id', 'movie');
    record(db, 'shared-id', 'series');

    expect(count(db)).toBe(2);
  });

  it('collapses existing duplicates, keeping the furthest-along row and its poster', () => {
    const db = openUnrepairedDb();
    seedDuplicatePair(db);

    applyDedupe(db);

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0].progress_seconds).toBe(120);
    expect(all[0].total_duration).toBe(3600);
    expect(all[0].poster_url).toBe('https://cdn/poster.jpg');
  });

  it('keeps the newest duplicate when the pair has identical progress', () => {
    const db = openUnrepairedDb();
    db.prepare(
      `INSERT INTO vod_history (media_id, media_type, source_id, title, watched_at, progress_seconds, total_duration, poster_url)
       VALUES ('99','movie','src','Coyote vs. Acme',1000,120,3600,NULL),
              ('99','movie','src','Coyote vs. Acme',5000,120,3600,'https://cdn/newer.jpg')`
    ).run();

    applyDedupe(db);

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0].watched_at).toBe(5000);
    expect(all[0].poster_url).toBe('https://cdn/newer.jpg');
  });

  it('cleans up a history that was already damaged by the old writers', () => {
    const db = openUnrepairedDb();
    // What an existing user's table looks like after months of the bug: the
    // reported pair (progress on one row, poster on the other), a triple from
    // re-opening a film, a healthy single row, and a duplicated series.
    db.prepare(
      `INSERT INTO vod_history (media_id, media_type, source_id, title, watched_at, progress_seconds, total_duration, poster_url, season_num, episode_num)
       VALUES ('coyote','movie','src','Coyote vs. Acme',1000,900,5400,NULL,NULL,NULL),
              ('coyote','movie','src','Coyote vs. Acme',900,NULL,NULL,'https://cdn/coyote.jpg',NULL,NULL),
              ('superbad','movie','src','Superbad',1000,300,6000,'https://cdn/superbad.jpg',NULL,NULL),
              ('superbad','movie','src','Superbad',800,NULL,NULL,NULL,NULL,NULL),
              ('superbad','movie','src','Superbad',700,NULL,NULL,NULL,NULL,NULL),
              ('heat','movie','src','Heat',500,120,10200,'https://cdn/heat.jpg',NULL,NULL),
              ('series-x','series','src','Some Show',1000,600,2400,NULL,2,5),
              ('series-x','series','src','Some Show',900,NULL,NULL,'https://cdn/show.jpg',2,4)`
    ).run();
    expect(count(db)).toBe(8);

    applyDedupe(db);

    // One row per media: 3 movies + 1 series.
    expect(count(db)).toBe(4);
    expect(
      db.prepare('SELECT media_id, media_type, COUNT(*) c FROM vod_history GROUP BY 1,2 HAVING c > 1').all()
    ).toHaveLength(0);

    const byId = new Map(rows(db).map(r => [r.media_id, r]));
    // Kept the furthest-along row, and kept the poster the dropped one held.
    expect(byId.get('coyote').progress_seconds).toBe(900);
    expect(byId.get('coyote').poster_url).toBe('https://cdn/coyote.jpg');
    expect(byId.get('superbad').progress_seconds).toBe(300);
    expect(byId.get('superbad').poster_url).toBe('https://cdn/superbad.jpg');
    // Untouched single row.
    expect(byId.get('heat').progress_seconds).toBe(120);
    // Series keeps its episode tracking and gains the dropped row's poster.
    expect(byId.get('series-x').season_num).toBe(2);
    expect(byId.get('series-x').episode_num).toBe(5);
    expect(byId.get('series-x').poster_url).toBe('https://cdn/show.jpg');
  });

  it('is idempotent, so the repair can run at startup and in the migration', () => {
    const db = openUnrepairedDb();
    db.prepare(
      `INSERT INTO vod_history (media_id, media_type, source_id, title, watched_at, progress_seconds, total_duration, poster_url)
       VALUES ('99','movie','src','A',1000,120,3600,NULL),
              ('99','movie','src','A',2000,NULL,NULL,'p'),
              ('88','movie','src','B',3000,NULL,NULL,NULL)`
    ).run();

    applyDedupe(db);
    const afterFirst = rows(db);
    applyDedupe(db);
    applyDedupe(db);

    expect(rows(db)).toEqual(afterFirst);
    expect(count(db)).toBe(2);
  });

  it('rejects a raw duplicate insert once the index is in place', () => {
    const db = openDb();
    record(db, '99', 'movie');

    expect(() =>
      db.prepare(
        `INSERT INTO vod_history (media_id, media_type, source_id, title, watched_at, progress_seconds, total_duration, poster_url)
         VALUES ('99','movie','src','Coyote vs. Acme',9999,NULL,NULL,NULL)`
      ).run()
    ).toThrow();
    expect(count(db)).toBe(1);
  });
});
