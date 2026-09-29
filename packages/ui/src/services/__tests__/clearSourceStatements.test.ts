/**
 * What deleting a playlist removes from the database.
 *
 * A playlist id reaches further than its own tables: channels, categories, its
 * guide channel list, cached probe results, and the channel lists users built on
 * top of it (custom groups, VOD playlists, failover groups, sports team links)
 * all name it or one of its stream ids. The tables that name a stream id are
 * addressed *through* `channels`, so the statement order is load-bearing — it is
 * checked here against a real SQLite rather than a mocked adapter, and the
 * assertions are about rows, not call counts.
 *
 * The exclusions are checked too: `watchlist`, `vod_history` and
 * `episode_history` are the user's viewing data, not a reference to the playlist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildClearSourceStatements } from '../../db';

// `node:sqlite` needs Node 22.5+ and, on 22.x, the --experimental-sqlite flag.
// Skipped rather than failed where it isn't available.
let DatabaseSync: (new (path: string) => any) | null = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const suite = DatabaseSync ? describe : describe.skip;

const SCHEMA = `
  CREATE TABLE channels (stream_id TEXT PRIMARY KEY, source_id TEXT);
  CREATE TABLE channel_categories (stream_id TEXT, source_id TEXT);
  CREATE TABLE categories (category_id TEXT PRIMARY KEY, source_id TEXT);
  CREATE TABLE sourcesMeta (source_id TEXT PRIMARY KEY);
  CREATE TABLE programs (id TEXT PRIMARY KEY, stream_id TEXT, source_id TEXT);
  CREATE TABLE dvr_schedules (id INTEGER PRIMARY KEY, source_id TEXT);
  CREATE TABLE dvr_recordings (id INTEGER PRIMARY KEY, schedule_id INTEGER);
  CREATE TABLE epg_channels (id TEXT PRIMARY KEY, source_id TEXT);
  CREATE TABLE channelMetadata (stream_id TEXT PRIMARY KEY, source_id TEXT);
  CREATE TABLE custom_group_channels (id INTEGER PRIMARY KEY, group_id TEXT, stream_id TEXT);
  CREATE TABLE playlist_individual_channels (id INTEGER PRIMARY KEY, playlist_id TEXT, stream_id TEXT);
  CREATE TABLE failover_group_members (id INTEGER PRIMARY KEY, group_id TEXT, stream_id TEXT);
  CREATE TABLE epg_channel_overrides (stream_id TEXT PRIMARY KEY, epg_channel_id TEXT);
  CREATE TABLE epg_program_overrides (id TEXT PRIMARY KEY, stream_id TEXT);
  -- Scoped by source id for a real source, by playlist id for a custom playlist:
  CREATE TABLE category_folders (folder_id TEXT PRIMARY KEY, playlist_id TEXT, name TEXT);
  CREATE TABLE team_channel_links (id TEXT PRIMARY KEY, source_id TEXT, stream_id TEXT);
  CREATE TABLE playlist_category_links (id INTEGER PRIMARY KEY, playlist_id TEXT, source_id TEXT, category_id TEXT);
  -- Deliberately untouched by the delete (user data):
  CREATE TABLE watchlist (id INTEGER PRIMARY KEY, source_id TEXT, channel_id TEXT);
  CREATE TABLE vod_history (id INTEGER PRIMARY KEY, source_id TEXT);
  CREATE TABLE episode_history (id INTEGER PRIMARY KEY, source_id TEXT);
`;

/** Tables that name a playlist id directly. */
const SOURCE_TABLES = [
  'channels',
  'channel_categories',
  'categories',
  'sourcesMeta',
  'programs',
  'dvr_schedules',
  'epg_channels',
  'channelMetadata',
  'team_channel_links',
  'playlist_category_links',
];

/** Tables that name one of a playlist's channels by stream id. */
const STREAM_TABLES = [
  'custom_group_channels',
  'playlist_individual_channels',
  'failover_group_members',
  'epg_channel_overrides',
  'epg_program_overrides',
];

function open(): any {
  const db = new DatabaseSync!(':memory:');
  db.exec(SCHEMA);
  return db;
}

/** Bind the `$1`-style parameters the app's statements use. */
function run(db: any, sql: string, args: unknown[]) {
  const params: Record<string, unknown> = {};
  args.forEach((value, index) => {
    params[`$${index + 1}`] = value;
  });
  return db.prepare(sql).run(params);
}

function seed(db: any) {
  const insert = (sql: string, rows: unknown[][]) => {
    const stmt = db.prepare(sql);
    for (const row of rows) stmt.run(...row);
  };

  insert('INSERT INTO channels VALUES (?, ?)', [['a-1', 'source-a'], ['a-2', 'source-a'], ['b-1', 'source-b']]);
  insert('INSERT INTO channel_categories VALUES (?, ?)', [['a-1', 'source-a'], ['b-1', 'source-b']]);
  insert('INSERT INTO categories VALUES (?, ?)', [['a-cat', 'source-a'], ['b-cat', 'source-b']]);
  insert('INSERT INTO sourcesMeta VALUES (?)', [['source-a'], ['source-b']]);
  insert('INSERT INTO programs VALUES (?, ?, ?)', [['p1', 'a-1', 'source-a'], ['p2', 'b-1', 'source-b']]);
  insert('INSERT INTO dvr_schedules VALUES (?, ?)', [[1, 'source-a'], [2, 'source-b']]);
  insert('INSERT INTO dvr_recordings VALUES (?, ?)', [[10, 1], [11, 2]]);
  insert('INSERT INTO epg_channels VALUES (?, ?)', [['epg-a', 'source-a'], ['epg-b', 'source-b']]);
  insert('INSERT INTO channelMetadata VALUES (?, ?)', [['a-1', 'source-a'], ['b-1', 'source-b']]);
  insert('INSERT INTO custom_group_channels VALUES (?, ?, ?)', [
    [1, 'grp', 'a-1'],
    [2, 'grp', 'b-1'],
  ]);
  insert('INSERT INTO playlist_individual_channels VALUES (?, ?, ?)', [
    [1, 'pl', 'a-1'],
    [2, 'pl', 'b-1'],
  ]);
  insert('INSERT INTO failover_group_members VALUES (?, ?, ?)', [
    [1, 'fo', 'a-1'],
    [2, 'fo', 'b-1'],
  ]);
  insert('INSERT INTO epg_channel_overrides VALUES (?, ?)', [['a-1', 'tv.a'], ['b-1', 'tv.b']]);
  insert('INSERT INTO epg_program_overrides VALUES (?, ?)', [
    ['a-1@1', 'a-1'],
    ['b-1@1', 'b-1'],
  ]);
  insert('INSERT INTO category_folders VALUES (?, ?, ?)', [
    ['f-a', 'source-a', 'News'],
    ['f-b', 'source-b', 'News'],
    // A folder of a user-made playlist must survive a *source* delete.
    ['f-own', 'user-playlist-1', 'Favourites'],
  ]);
  insert('INSERT INTO team_channel_links VALUES (?, ?, ?)', [
    ['t-a', 'source-a', 'a-1'],
    ['t-b', 'source-b', 'b-1'],
    // Legacy row that never recorded its source: the channel is the only link.
    ['t-legacy', null, 'a-2'],
  ]);
  insert('INSERT INTO playlist_category_links VALUES (?, ?, ?, ?)', [
    [1, 'pl', 'source-a', 'a-cat'],
    [2, 'pl', 'source-b', 'b-cat'],
  ]);
  insert('INSERT INTO watchlist VALUES (?, ?, ?)', [[1, 'source-a', 'a-1'], [2, 'source-b', 'b-1']]);
  insert('INSERT INTO vod_history VALUES (?, ?)', [[1, 'source-a'], [2, 'source-b']]);
  insert('INSERT INTO episode_history VALUES (?, ?)', [[1, 'source-a'], [2, 'source-b']]);
}

function count(db: any, sql: string, args: unknown[] = []): number {
  const stmt = db.prepare(sql);
  const row = args.length > 0
    ? stmt.get(Object.fromEntries(args.map((value, index) => [`$${index + 1}`, value])))
    : stmt.get();
  return Number(row?.c ?? 0);
}

suite('clearSourceStatements', () => {
  it('leaves nothing behind that names the deleted playlist', () => {
    const db = open();
    seed(db);

    for (const { sql, args } of buildClearSourceStatements('source-a')) {
      run(db, sql, args);
    }

    for (const table of SOURCE_TABLES) {
      expect(count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE source_id = 'source-a'`), table).toBe(0);
    }
    for (const table of STREAM_TABLES) {
      expect(
        count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE stream_id IN ('a-1', 'a-2')`),
        table
      ).toBe(0);
    }
    // The legacy sports link is matched by its channel, not its (null) source.
    expect(count(db, `SELECT COUNT(*) AS c FROM team_channel_links WHERE stream_id = 'a-2'`)).toBe(0);
    // Its category folders are keyed by `playlist_id`, not `source_id`.
    expect(count(db, `SELECT COUNT(*) AS c FROM category_folders WHERE playlist_id = 'source-a'`)).toBe(0);
  });

  it('leaves the surviving playlists untouched', () => {
    const db = open();
    seed(db);

    for (const { sql, args } of buildClearSourceStatements('source-a')) {
      run(db, sql, args);
    }

    for (const table of SOURCE_TABLES) {
      expect(count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE source_id = 'source-b'`), table).toBe(1);
    }
    for (const table of STREAM_TABLES) {
      expect(count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE stream_id = 'b-1'`), table).toBe(1);
    }
    expect(count(db, `SELECT COUNT(*) AS c FROM team_channel_links WHERE stream_id = 'b-1'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS c FROM category_folders WHERE playlist_id = 'source-b'`)).toBe(1);
    // `playlist_id` also names user-made playlists, which are not the delete's to clear.
    expect(count(db, `SELECT COUNT(*) AS c FROM category_folders WHERE playlist_id = 'user-playlist-1'`)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS c FROM dvr_recordings')).toBe(1);
  });

  it('keeps the user viewing data that only names the playlist', () => {
    // A reference to a deleted playlist in watch history or the watchlist is not
    // a stale configuration entry, so it is not the delete's to drop.
    const db = open();
    seed(db);

    for (const { sql, args } of buildClearSourceStatements('source-a')) {
      run(db, sql, args);
    }

    expect(count(db, `SELECT COUNT(*) AS c FROM watchlist WHERE source_id = 'source-a'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS c FROM vod_history WHERE source_id = 'source-a'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS c FROM episode_history WHERE source_id = 'source-a'`)).toBe(1);
  });

  it('addresses the channel-owned rows before the channel rows go', () => {
    const statements = buildClearSourceStatements('source-a');
    const at = (table: string) => statements.findIndex(s => s.sql.includes(`DELETE FROM ${table}`));

    for (const table of STREAM_TABLES) {
      expect(at(table), table).toBeGreaterThanOrEqual(0);
      expect(at(table), table).toBeLessThan(at('channels'));
    }
    // DVR recordings go before the schedules they reference.
    expect(at('dvr_recordings')).toBeLessThan(at('dvr_schedules'));
    // Every statement carries the source id as its only parameter.
    for (const statement of statements) {
      expect(statement.args).toEqual(['source-a']);
    }
  });

  it('runs every statement from clearSourceData and announces each table', () => {
    const src = readFileSync(new URL('../../db/index.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function clearSourceData'));
    const runBody = body.slice(0, body.indexOf('\n}'));

    expect(runBody).toContain('buildClearSourceStatements(sourceId)');
    // `channel_categories` is deliberately absent: it has no reactive consumer
    // of its own and the original cleanup never announced it either.
    const announced = [
      'dvr_recordings', 'dvr_schedules', 'channels', 'categories', 'sourcesMeta', 'programs',
      'epg_channels', 'channelMetadata', 'team_channel_links', 'playlist_category_links',
      'category_folders',
      ...STREAM_TABLES,
    ];
    for (const table of announced) {
      expect(runBody, table).toContain(`dbEvents.notify('${table}'`);
    }
  });
});
