import { describe, it, expect } from 'vitest';
import {
  buildMissingEpgQuery,
  buildMissingEpgCountQuery,
  visibilityClause,
  ENABLED_CHANNEL_SQL,
} from '../epgAutomatchFilter';

/** Collapse whitespace so the guards compare SQL, not indentation. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The query the run used before the "only enabled channels" option, plus the
 * `override_*` columns added so an applied match can be undone exactly.
 */
function legacyQuery(sourceId: string | undefined, categoryIds: string[]) {
  const params: unknown[] = [];
  let sql = `
      SELECT c.*, COALESCE(o.match_by_alias, 0) AS match_by_alias,
             o.stream_icon AS override_stream_icon,
             o.timeshift_hours AS override_timeshift_hours,
             o.logo_background AS override_logo_background,
             o.logo_padding AS override_logo_padding,
             o.epg_source_id AS override_epg_source_id,
             COALESCE(o.logo_locked, 0) AS override_logo_locked
      FROM channels c
      LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
      WHERE (COALESCE(o.epg_channel_id, c.epg_channel_id) IS NULL OR TRIM(COALESCE(o.epg_channel_id, c.epg_channel_id)) = '')
    `;
  if (sourceId) {
    sql += ` AND c.source_id = $${params.length + 1}`;
    params.push(sourceId);
  }
  if (categoryIds.length > 0) {
    const likeClauses = categoryIds.map((_, i) => `c.category_ids LIKE $${params.length + i + 1}`).join(' OR ');
    sql += ` AND (${likeClauses})`;
    categoryIds.forEach(id => params.push(`%"${id}"%`));
  }
  sql += ` ORDER BY c.name COLLATE NOCASE`;
  return { sql, params };
}

describe('visibilityClause', () => {
  it('adds nothing for the historical all-channels scope', () => {
    expect(visibilityClause('all')).toBe('');
  });

  it('requires an enabled channel in an enabled category, with favorites exempt', () => {
    const visible = visibilityClause('visible');
    expect(visible).toContain(ENABLED_CHANNEL_SQL);
    expect(visible).toContain('channel_categories');
    expect(visible).toContain('is_favorite');
    expect(visible).not.toContain('NOT (');
  });

  it('negates the same rule for the hidden scope', () => {
    expect(visibilityClause('hidden')).toBe(`NOT (${visibilityClause('visible')})`);
  });

  it('keeps the rule definite so the negated scope counts NULL favorites', () => {
    // `NOT (NULL OR false)` is NULL, which would drop an unset favorite in a
    // disabled category from both scopes.
    expect(visibilityClause('visible')).toContain("COALESCE(c.is_favorite, 0) IN (1, 'true')");
  });
});

describe('buildMissingEpgQuery', () => {
  it('is the legacy query when the visibility filter is off', () => {
    const legacy = legacyQuery('src-1', ['10', '11']);
    const built = buildMissingEpgQuery({ scope: 'source', sourceId: 'src-1', categoryIds: ['10', '11'] });
    expect(flat(built.sql)).toBe(flat(legacy.sql));
    expect(built.params).toEqual(legacy.params);
  });

  it('is the legacy query for an all-source scope with no categories', () => {
    const legacy = legacyQuery(undefined, []);
    const built = buildMissingEpgQuery({ scope: 'all', categoryIds: [], visibility: 'all' });
    expect(flat(built.sql)).toBe(flat(legacy.sql));
    expect(built.params).toEqual([]);
  });

  it('keeps parameter order stable when the filter is on', () => {
    const built = buildMissingEpgQuery({
      scope: 'source',
      sourceId: 'src-1',
      categoryIds: ['10', '11'],
      visibility: 'visible',
    });
    // Same source-then-categories order as before: the filter needs no params.
    expect(built.params).toEqual(['src-1', '%"10"%', '%"11"%']);
    expect(flat(built.sql)).toContain(flat(visibilityClause('visible')));
    expect(flat(built.sql)).toContain('ORDER BY c.name COLLATE NOCASE');
  });

  it('selects the pre-run override, aliased so c.* cannot collide with it', () => {
    const built = flat(buildMissingEpgQuery({ scope: 'all', categoryIds: [] }).sql);
    // Every override field an undo has to restore, and none of them under a
    // name the channels table already uses.
    expect(built).toContain('o.stream_icon AS override_stream_icon');
    expect(built).toContain('o.timeshift_hours AS override_timeshift_hours');
    expect(built).toContain('o.logo_background AS override_logo_background');
    expect(built).toContain('o.logo_padding AS override_logo_padding');
    expect(built).toContain('o.epg_source_id AS override_epg_source_id');
    expect(built).toContain('COALESCE(o.logo_locked, 0) AS override_logo_locked');
    expect(built).not.toContain('c.stream_icon AS');
  });

  it('never matches a channel that already has a guide', () => {
    const built = buildMissingEpgQuery({ scope: 'all', categoryIds: [], visibility: 'visible' });
    expect(flat(built.sql)).toContain(
      "COALESCE(o.epg_channel_id, c.epg_channel_id) IS NULL OR TRIM(COALESCE(o.epg_channel_id, c.epg_channel_id)) = ''",
    );
  });
});

describe('buildMissingEpgCountQuery', () => {
  it('counts the same set the run would fetch, without ordering it', () => {
    const scope = { scope: 'source' as const, sourceId: 'src-1', categoryIds: [], visibility: 'hidden' as const };
    const count = buildMissingEpgCountQuery(scope);
    const fetch = buildMissingEpgQuery(scope);
    expect(flat(count.sql)).toContain('SELECT COUNT(*) AS cnt');
    expect(flat(count.sql)).not.toContain('ORDER BY');
    expect(count.params).toEqual(fetch.params);
    expect(flat(count.sql)).toContain(flat(visibilityClause('hidden')));
  });

  it('is the legacy WHERE clause when counting everything', () => {
    const count = buildMissingEpgCountQuery({ scope: 'all', categoryIds: [] });
    expect(flat(count.sql)).not.toContain('channel_categories');
  });
});
