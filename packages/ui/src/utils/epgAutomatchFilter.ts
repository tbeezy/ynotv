/**
 * Query builder for EPG Editor → Automatch Missing.
 *
 * The run used to sweep every channel in scope, including the thousands a user
 * has deliberately turned off (disabled channels, and channels that only sit in
 * disabled categories). With a 50k-channel source and 1k enabled, that is
 * minutes of matching for rows nobody can see.
 *
 * Kept as a pure builder rather than inline SQL so the two scopes can be
 * asserted without a database: with the filter off the query is the one the run
 * has always used, so switching the option on can only ever narrow the set.
 */

/**
 * The rules the app itself uses to hide rows — copied rather than re-invented,
 * because a channel this calls visible must be one the channel list also shows.
 * `enabled` predates the boolean column and can still be 0/'0'/'false'.
 */
export const ENABLED_CHANNEL_SQL = `(c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))`;

/**
 * Favorites are stored as 1/true depending on the write path (see db/index.ts).
 * COALESCE keeps this definite rather than NULL, which matters for the negated
 * `hidden` scope: `NOT (NULL OR false)` is NULL, so an unset favorite in a
 * disabled category would count as neither visible nor hidden.
 */
const FAVORITE_SQL = `COALESCE(c.is_favorite, 0) IN (1, 'true')`;

/**
 * At least one of the channel's categories is an existing, enabled one.
 *
 * Read from the denormalized `channel_categories` map rather than
 * `json_each(c.category_ids)`: it is the table the channel list itself joins to
 * list a category, and the indexed seek makes this ~8x faster on a 100k-channel
 * library (measured 209ms vs 1787ms), for identical results.
 */
const ENABLED_CATEGORY_SQL = `EXISTS (
        SELECT 1 FROM channel_categories AS cc
        JOIN categories AS cat ON cat.category_id = cc.category_id AND cat.source_id = cc.source_id
        WHERE cc.stream_id = c.stream_id
          AND (cat.enabled IS NULL OR cat.enabled NOT IN (0, '0', 'false'))
      )`;

export type ChannelVisibility = 'all' | 'visible' | 'hidden';

/**
 * `all` is the historical scope. `hidden` exists only to count what the visible
 * scope left out, so the run can say so instead of silently doing less work.
 *
 * A favorite counts as visible even when its category is disabled: it is listed
 * in Favorites and Recent regardless, so its guide is still worth matching.
 */
export function visibilityClause(visibility: ChannelVisibility): string {
  if (visibility === 'all') return '';
  const visible = `${ENABLED_CHANNEL_SQL} AND (${FAVORITE_SQL} OR ${ENABLED_CATEGORY_SQL})`;
  return visibility === 'visible' ? visible : `NOT (${visible})`;
}

export interface MissingEpgScope {
  /** `all` ignores the source filter entirely, matching the UI's "All sources". */
  scope: 'source' | 'all';
  sourceId?: string;
  /** Empty means every category in scope. */
  categoryIds: string[];
  visibility?: ChannelVisibility;
}

/** A channel needs matching when neither the override nor the row has an id. */
const MISSING_SQL = `(COALESCE(o.epg_channel_id, c.epg_channel_id) IS NULL OR TRIM(COALESCE(o.epg_channel_id, c.epg_channel_id)) = '')`;

function buildScope(scope: MissingEpgScope): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (scope.scope === 'source' && scope.sourceId) {
    params.push(scope.sourceId);
    clauses.push(`c.source_id = $${params.length}`);
  }

  if (scope.scope === 'source' && scope.categoryIds.length > 0) {
    const likeClauses = scope.categoryIds.map(id => {
      params.push(`%"${id}"%`);
      return `c.category_ids LIKE $${params.length}`;
    });
    clauses.push(`(${likeClauses.join(' OR ')})`);
  }

  if (clauses.length > 0) clauses[0] = `AND ${clauses[0]}`;
  return { sql: clauses.join('\n     AND '), params };
}

function buildWhere(scope: MissingEpgScope): { sql: string; params: unknown[] } {
  const { sql, params } = buildScope(scope);
  const visibility = visibilityClause(scope.visibility ?? 'all');
  const parts = [MISSING_SQL];
  if (visibility) parts.push(visibility);
  const joined = parts.join('\n     AND ');
  return sql ? { sql: `${joined}\n     ${sql}`, params } : { sql: joined, params };
}

/**
 * The channels a run should resolve: no guide, in scope, and — unless the
 * caller asks for everything — only the ones the user can actually see.
 *
 * The `override_*` columns are the channel's override row as it is *before* the
 * run writes anything. They exist so a match can be undone exactly: the row is
 * restored from this snapshot instead of being deleted, which would also throw
 * away a logo background, padding or timeshift the user set earlier. Prefixed so
 * they can't collide with the channel columns `c.*` brings along.
 */
export function buildMissingEpgQuery(scope: MissingEpgScope): { sql: string; params: unknown[] } {
  const { sql: where, params } = buildWhere(scope);
  return {
    sql: `
      SELECT c.*, COALESCE(o.match_by_alias, 0) AS match_by_alias,
             o.stream_icon AS override_stream_icon,
             o.timeshift_hours AS override_timeshift_hours,
             o.logo_background AS override_logo_background,
             o.logo_padding AS override_logo_padding,
             o.epg_source_id AS override_epg_source_id,
             COALESCE(o.logo_locked, 0) AS override_logo_locked
      FROM channels c
      LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
      WHERE ${where}
      ORDER BY c.name COLLATE NOCASE
    `,
    params,
  };
}

/** Just the count of the same set — used to report what the visible scope skipped. */
export function buildMissingEpgCountQuery(scope: MissingEpgScope): { sql: string; params: unknown[] } {
  const { sql: where, params } = buildWhere(scope);
  return {
    sql: `
      SELECT COUNT(*) AS cnt
      FROM channels c
      LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
      WHERE ${where}
    `,
    params,
  };
}
