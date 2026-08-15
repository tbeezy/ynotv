/**
 * Team → Channel matcher.
 *
 * Maps sports teams to provider channels so a game can be watched with one tap.
 * Supports configurable matching strategy (Full City + Team, Smart Match, Nicknames)
 * and source / category scoping per league.
 */

import { db } from '../../db';
import type { StoredChannel } from '../../db';
import type { SportsTeam } from '@ynotv/core';
import { buildSearchQueryClauses, getSearchVariants, normalizeText } from '../../utils/searchNormalization';
import type { LeagueAutoLinkConfig } from '../../stores/leagueAutoLinkConfigStore';

export function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === 'string' || typeof parsed === 'number') return [String(parsed)];
  } catch {
    if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [String(raw)];
}

export { normalizeText };

/**
 * Known city/location prefixes used in major sports team names.
 * Multi-word prefixes must be listed before single-word ones so they match greedily.
 */
export const TEAM_CITY_PREFIXES: string[] = [
  'San Francisco', 'Golden State', 'New England', 'Tampa Bay', 'Green Bay',
  'Kansas City', 'Oklahoma City', 'New York', 'New Orleans', 'Los Angeles',
  'San Antonio', 'San Diego', 'San Jose', 'North Carolina', 'South Carolina',
  'West Virginia', 'Saint Louis', 'St. Louis', 'St Louis',
  'Real Madrid', 'Atletico Madrid', 'Paris Saint-Germain', 'Bayern Munich',
  'Borussia Dortmund', 'Inter Milan', 'AC Milan', 'Aston Villa', 'West Ham',
  'Crystal Palace', 'Wolverhampton Wanderers',
  'Arizona', 'Atlanta', 'Baltimore', 'Boston', 'Buffalo', 'Carolina',
  'Charlotte', 'Chicago', 'Cincinnati', 'Cleveland', 'Dallas', 'Denver',
  'Detroit', 'Houston', 'Indianapolis', 'Indiana', 'Jacksonville', 'Miami',
  'Milwaukee', 'Minnesota', 'Memphis', 'Nashville', 'Oakland', 'Orlando',
  'Philadelphia', 'Phoenix', 'Pittsburgh', 'Portland', 'Sacramento',
  'Seattle', 'Tennessee', 'Texas', 'Toronto', 'Utah', 'Vancouver',
  'Washington', 'Montreal', 'Calgary', 'Edmonton', 'Ottawa', 'Winnipeg',
  'Vegas', 'Columbus', 'Anaheim', 'Colorado', 'Florida',
  'Flamengo', 'Palmeiras', 'Corinthians', 'Santos', 'Sao Paulo',
  'Gremio', 'Internacional',
  'Inter', 'Internazionale', 'Manchester', 'Tottenham', 'Blackburn', 'Blackpool',
  'Newcastle', 'Swindon', 'Coventry', 'Luton', 'Cambridge',
  'Rangers', 'Celtic', 'Aberdeen', 'Hibernian', 'Hearts',
];

TEAM_CITY_PREFIXES.sort((a, b) => b.length - a.length);

export function stripCityPrefix(name: string): string {
  const trimmed = name.trim();
  for (const city of TEAM_CITY_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(city.toLowerCase() + ' ')) {
      const nickname = trimmed.slice(city.length).trim();
      if (nickname.length > 0) return nickname;
    }
  }
  return trimmed;
}

export function splitTeamName(name: string): { city: string; nickname: string } {
  const trimmed = name.trim();
  for (const city of TEAM_CITY_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(city.toLowerCase() + ' ')) {
      const nickname = trimmed.slice(city.length).trim();
      if (nickname.length > 0) return { city, nickname };
    }
  }
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > 0) {
    return {
      city: trimmed.slice(0, lastSpace),
      nickname: trimmed.slice(lastSpace + 1),
    };
  }
  return { city: '', nickname: trimmed };
}

const NCAA_LEAGUE_IDS = new Set([
  'mens-college-basketball',
  'womens-college-basketball',
  'college-football',
  'college-baseball',
  'college-softball',
]);

function stripMascotForCollege(name: string): string {
  let cleaned = name.replace(/\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  const words = cleaned.split(/\s+/);
  if (words.length <= 1) return cleaned;
  return words.slice(0, -1).join(' ');
}

export const INDIVIDUAL_SPORT_LEAGUES = new Set(['ufc', 'f1', 'nascar', 'indycar', 'pga', 'lpga', 'atp', 'wta']);

export function buildTeamSearchQuery(homeTeam: string, awayTeam: string, leagueId?: string, eventTitle?: string): string {
  if (leagueId && INDIVIDUAL_SPORT_LEAGUES.has(leagueId) && eventTitle) {
    return eventTitle;
  }
  if (leagueId && NCAA_LEAGUE_IDS.has(leagueId)) {
    return `${stripMascotForCollege(homeTeam)} ${stripMascotForCollege(awayTeam)}`;
  }
  return `${stripCityPrefix(homeTeam)} ${stripCityPrefix(awayTeam)}`;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface TeamChannelCandidate {
  channel: StoredChannel;
  score: number; // 0..1
  reason: 'name' | 'alias' | 'nickname';
  matchedTerm: string;
}

export interface TeamLinkSuggestion {
  leagueId: string;
  team: SportsTeam;
  candidates: TeamChannelCandidate[];
  best: TeamChannelCandidate | null;
  autoAssign: boolean;
}

export interface LeagueMatchResult {
  leagueId: string;
  suggestions: TeamLinkSuggestion[];
  autoLinked: TeamLinkSuggestion[];
  reviewable: TeamLinkSuggestion[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match so "Knicks" never matches "Knicksborough". */
function containsWholeWord(haystack: string, word: string): boolean {
  if (!haystack || !word) return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, 'i');
  return re.test(haystack);
}

function tokensMatch(haystack: string, tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => containsWholeWord(haystack, t));
}

function nicknameTokens(team: SportsTeam): string[] {
  const nick = normalizeText(stripCityPrefix(team.name)) || normalizeText(team.name);
  const tokens = nick.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length === 1 && tokens[0].length < 4) return [];
  return tokens;
}

function cityTokens(team: SportsTeam): string[] {
  const { city } = splitTeamName(team.name);
  if (!city) return [];
  return normalizeText(city).split(/\s+/).filter((t) => t.length >= 2);
}

const GENERIC_CHANNEL_WORDS = new Set([
  'hd', 'fhd', 'uhd', '4k', '8k', 'sd', 'tv', 'ch', 'channel', 'net', 'network',
  'us', 'usa', 'uk', 'live', 'premium', 'feed', 'stream', 'sports', 'sport',
]);

function countExtraTokens(target: string, tokens: string[]): number {
  const tokenSet = new Set(tokens);
  let extra = 0;
  for (const raw of target.split(/\s+/)) {
    const word = raw.replace(/[^a-z0-9]/g, '');
    if (!word) continue;
    if (tokenSet.has(word)) continue;
    if (GENERIC_CHANNEL_WORDS.has(word)) continue;
    extra++;
  }
  return extra;
}

function hasConflictingCity(target: string, ownCityTokens: string[]): boolean {
  const ownCityJoined = ownCityTokens.join(' ').toLowerCase();
  for (const city of TEAM_CITY_PREFIXES) {
    const cityNorm = normalizeText(city);
    if (cityNorm === ownCityJoined || ownCityJoined.includes(cityNorm)) continue;
    const cityWords = cityNorm.split(/\s+/);
    if (cityWords.length > 0 && tokensMatch(target, cityWords)) {
      return true;
    }
  }
  return false;
}

export function scoreChannelForTeam(
  channel: StoredChannel,
  team: SportsTeam,
  config?: LeagueAutoLinkConfig
): TeamChannelCandidate | null {
  const mode = config?.matchMode || 'both';
  const full = normalizeText(team.name);
  const short = normalizeText(team.shortName || '');
  const name = normalizeText(channel.name);
  const alias = normalizeText(channel.alias);
  const nTokens = nicknameTokens(team);
  const cTokens = cityTokens(team);
  const allTokens = [...cTokens, ...nTokens];

  // Exact name matches are near-certain.
  if (full && name === full) return { channel, score: 1, reason: 'name', matchedTerm: team.name };
  if (full && alias && alias === full) return { channel, score: 0.98, reason: 'alias', matchedTerm: team.name };
  if (short && (name === short || (alias && alias === short))) {
    return { channel, score: 0.95, reason: 'name', matchedTerm: team.shortName || '' };
  }

  let target: string | null = null;
  let isFullMatch = false;

  // 1. Check for full City + Nickname match
  if (allTokens.length > 0 && tokensMatch(name, allTokens)) {
    target = name;
    isFullMatch = true;
  } else if (allTokens.length > 0 && alias && tokensMatch(alias, allTokens)) {
    target = alias;
    isFullMatch = true;
  }

  // 2. Strict Full-Name Mode ('full'): MUST contain both city and nickname tokens (if city exists)
  if (mode === 'full') {
    if (cTokens.length > 0 && !isFullMatch) {
      return null;
    }
    if (!target) {
      if (nTokens.length > 0 && tokensMatch(name, nTokens)) target = name;
      else if (nTokens.length > 0 && alias && tokensMatch(alias, nTokens)) target = alias;
    }
    if (!target) return null;

    if (hasConflictingCity(target, cTokens)) return null;

    const extra = countExtraTokens(target, allTokens);
    let score = isFullMatch ? 0.95 : 0.88;
    if (extra <= 1) score = Math.min(0.98, score + 0.03);
    else if (extra === 2) score = Math.max(0.75, score - 0.1);
    else score = Math.max(0.55, score - 0.25);

    return { channel, score, reason: isFullMatch ? 'name' : 'nickname', matchedTerm: team.name };
  }

  // 3. Smart Match ('both'): Prioritizes full name, allows distinct nicknames if no city conflict
  if (isFullMatch && target) {
    if (hasConflictingCity(target, cTokens)) return null;
    const extra = countExtraTokens(target, allTokens);
    let score = 0.94;
    if (extra <= 1) score = 0.98;
    else if (extra === 2) score = 0.88;
    else score = 0.75;
    return { channel, score, reason: 'name', matchedTerm: team.name };
  }

  // Fallback to Nickname match
  if (nTokens.length > 0 && tokensMatch(name, nTokens)) target = name;
  else if (nTokens.length > 0 && alias && tokensMatch(alias, nTokens)) target = alias;
  if (!target) return null;

  if (mode === 'both' && cTokens.length > 0 && hasConflictingCity(target, cTokens)) {
    return null;
  }

  const distinct = nTokens.length === 1 && nTokens[0].length >= 4;
  let score = distinct ? 0.85 : 0.72;

  const lowered = target.toLowerCase();
  if (/\bvs\b|\bversus\b|@|\bat\b/.test(lowered)) {
    score = 0.3;
  } else {
    const extra = countExtraTokens(target, nTokens);
    if (extra <= 1) score = Math.min(0.92, score + 0.04);
    else if (extra === 2) score = Math.max(0.58, score - 0.16);
    else score = Math.max(0.4, score - 0.32);
  }

  return { channel, score, reason: 'nickname', matchedTerm: nTokens.join(' ') };
}

export function shouldAutoAssign(candidates: TeamChannelCandidate[]): boolean {
  const best = candidates[0];
  if (!best) return false;
  if (best.score >= 0.95) return true;
  const second = candidates[1];
  return best.score >= 0.82 && (!second || best.score - second.score >= 0.2);
}

async function getEnabledSourceIds(): Promise<string[]> {
  try {
    const result = window.storage ? await window.storage.getSources() : { data: [] };
    return result.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || [];
  } catch {
    return [];
  }
}

export async function searchChannelsForLink(query: string, limit = 50): Promise<StoredChannel[]> {
  const term = query.trim();
  if (!term) return [];
  const enabledSourceIds = await getEnabledSourceIds();
  if (enabledSourceIds.length === 0) return [];

  const sourcePlaceholders = enabledSourceIds.map(() => '?').join(',');
  const nameClause = buildSearchQueryClauses('c.name', term);
  const aliasClause = buildSearchQueryClauses('c.alias', term);
  const streamIdClause = /^\d+$/.test(term) ? ' OR c.stream_id = ?' : '';
  const streamIdParams = /^\d+$/.test(term) ? [term] : [];

  const sql = `SELECT c.* FROM channels c WHERE (c.enabled IS NULL OR c.enabled != 0) AND c.source_id IN (${sourcePlaceholders}) AND (( ${nameClause.sql} ) OR ( ${aliasClause.sql} )${streamIdClause}) LIMIT ${limit}`;
  return db.query<StoredChannel>(sql, [...enabledSourceIds, ...nameClause.params, ...aliasClause.params, ...streamIdParams]);
}

export async function getTeamChannelSuggestions(
  team: SportsTeam,
  config?: LeagueAutoLinkConfig
): Promise<TeamChannelCandidate[]> {
  const enabledSourceIds = await getEnabledSourceIds();
  if (enabledSourceIds.length === 0) return [];
  return findCandidatesForTeam(team, enabledSourceIds, config);
}

/** The normalized term used to pre-filter channels for a team. */
function teamSearchTerm(team: SportsTeam, config?: LeagueAutoLinkConfig): string {
  const mode = config?.matchMode || 'both';
  if (mode === 'full') return normalizeText(team.name);
  return normalizeText(stripCityPrefix(team.name)) || normalizeText(team.name);
}

async function findCandidatesForTeam(
  team: SportsTeam,
  enabledSourceIds: string[],
  config?: LeagueAutoLinkConfig
): Promise<TeamChannelCandidate[]> {
  let targetSourceIds = enabledSourceIds;
  if (config?.sourceIds && config.sourceIds.length > 0) {
    targetSourceIds = enabledSourceIds.filter((id) => config.sourceIds!.includes(id));
    if (targetSourceIds.length === 0) return [];
  }

  const words = teamSearchTerm(team, config).split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];

  const sourcePlaceholders = targetSourceIds.map(() => '?').join(',');
  const nameClause = buildSearchQueryClauses('c.name', words.join(' '));
  const aliasClause = buildSearchQueryClauses('c.alias', words.join(' '));

  let rows: StoredChannel[] = [];

  if (config?.categoryIds && config.categoryIds.length > 0) {
    const catPlaceholders = config.categoryIds.map(() => '?').join(',');
    const sql = `SELECT DISTINCT c.* FROM channels c CROSS JOIN json_each(c.category_ids) AS cat
                 WHERE (c.enabled IS NULL OR c.enabled != 0)
                   AND c.source_id IN (${sourcePlaceholders})
                   AND cat.value IN (${catPlaceholders})
                   AND (( ${nameClause.sql} ) OR ( ${aliasClause.sql} ))
                 LIMIT 50`;
    rows = await db.query<StoredChannel>(sql, [
      ...targetSourceIds,
      ...config.categoryIds,
      ...nameClause.params,
      ...aliasClause.params,
    ]);
  } else {
    const sql = `SELECT c.* FROM channels c
                 WHERE (c.enabled IS NULL OR c.enabled != 0)
                   AND c.source_id IN (${sourcePlaceholders})
                   AND (( ${nameClause.sql} ) OR ( ${aliasClause.sql} ))
                 LIMIT 50`;
    rows = await db.query<StoredChannel>(sql, [
      ...targetSourceIds,
      ...nameClause.params,
      ...aliasClause.params,
    ]);
  }

  if (rows.length === 0) return [];

  const candidates: TeamChannelCandidate[] = [];
  for (const ch of rows) {
    if (config?.categoryIds && config.categoryIds.length > 0) {
      const chCatIds = parseCategoryIds(ch.category_ids);
      if (!chCatIds.some((id: string) => config.categoryIds!.includes(id))) {
        continue;
      }
    }

    const c = scoreChannelForTeam(ch, team, config);
    if (c) candidates.push(c);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 8);
}

/** Build one OR-of-all-teams LIKE clause so a whole league can be matched in a single query. */
function buildUnionMatchClause(
  teams: SportsTeam[],
  config?: LeagueAutoLinkConfig
): { sql: string; params: string[] } {
  const uniqueWords = new Set<string>();
  for (const team of teams) {
    for (const w of teamSearchTerm(team, config).split(/\s+/)) {
      if (w.length >= 2) uniqueWords.add(w);
    }
  }

  const clauses: string[] = [];
  const params: string[] = [];
  for (const word of uniqueWords) {
    const variants = getSearchVariants(word);
    clauses.push(`(${variants.map(() => 'c.name LIKE ?').join(' OR ')})`);
    for (const v of variants) params.push(`%${v}%`);
    clauses.push(`(${variants.map(() => 'c.alias LIKE ?').join(' OR ')})`);
    for (const v of variants) params.push(`%${v}%`);
  }

  if (clauses.length === 0) return { sql: '0', params: [] };
  return { sql: clauses.join(' OR '), params };
}

/** Fetch candidate channels for an entire league in a single query, then score per team in JS. */
async function findCandidatesForTeams(
  teams: SportsTeam[],
  enabledSourceIds: string[],
  config?: LeagueAutoLinkConfig
): Promise<Map<string, TeamChannelCandidate[]>> {
  const result = new Map<string, TeamChannelCandidate[]>();

  let targetSourceIds = enabledSourceIds;
  if (config?.sourceIds && config.sourceIds.length > 0) {
    targetSourceIds = enabledSourceIds.filter((id) => config.sourceIds!.includes(id));
  }
  if (targetSourceIds.length === 0) {
    for (const t of teams) result.set(t.id, []);
    return result;
  }

  const union = buildUnionMatchClause(teams, config);
  if (union.sql === '0') {
    for (const t of teams) result.set(t.id, []);
    return result;
  }

  const sourcePlaceholders = targetSourceIds.map(() => '?').join(',');
  let rows: StoredChannel[];
  if (config?.categoryIds && config.categoryIds.length > 0) {
    const catPlaceholders = config.categoryIds.map(() => '?').join(',');
    rows = await db.query<StoredChannel>(
      `SELECT DISTINCT c.* FROM channels c CROSS JOIN json_each(c.category_ids) AS cat
       WHERE (c.enabled IS NULL OR c.enabled != 0)
         AND c.source_id IN (${sourcePlaceholders})
         AND cat.value IN (${catPlaceholders})
         AND (${union.sql})
       LIMIT 1000`,
      [...targetSourceIds, ...config.categoryIds, ...union.params]
    );
  } else {
    rows = await db.query<StoredChannel>(
      `SELECT c.* FROM channels c
       WHERE (c.enabled IS NULL OR c.enabled != 0)
         AND c.source_id IN (${sourcePlaceholders})
         AND (${union.sql})
       LIMIT 1000`,
      [...targetSourceIds, ...union.params]
    );
  }

  for (const team of teams) {
    const candidates: TeamChannelCandidate[] = [];
    for (const ch of rows) {
      if (config?.categoryIds && config.categoryIds.length > 0) {
        const chCatIds = parseCategoryIds(ch.category_ids);
        if (!chCatIds.some((id: string) => config.categoryIds!.includes(id))) continue;
      }
      const c = scoreChannelForTeam(ch, team, config);
      if (c) candidates.push(c);
    }
    candidates.sort((a, b) => b.score - a.score);
    result.set(team.id, candidates.slice(0, 8));
  }

  return result;
}

export async function matchTeamsToChannels(
  leagueId: string,
  teams: SportsTeam[],
  config?: LeagueAutoLinkConfig
): Promise<LeagueMatchResult> {
  const enabledSourceIds = await getEnabledSourceIds();
  const suggestions: TeamLinkSuggestion[] = [];

  if (enabledSourceIds.length === 0) {
    for (const team of teams) {
      suggestions.push({ leagueId, team, candidates: [], best: null, autoAssign: false });
    }
    return { leagueId, suggestions, autoLinked: [], reviewable: suggestions };
  }

  // One batched query for the whole league instead of N per-team queries.
  const candidatesByTeam = await findCandidatesForTeams(teams, enabledSourceIds, config);

  for (const team of teams) {
    const candidates = candidatesByTeam.get(team.id) || [];
    suggestions.push({
      leagueId,
      team,
      candidates,
      best: candidates[0] || null,
      autoAssign: shouldAutoAssign(candidates),
    });
  }

  return {
    leagueId,
    suggestions,
    autoLinked: suggestions.filter((s) => s.autoAssign),
    reviewable: suggestions.filter((s) => !s.autoAssign && s.best),
  };
}
