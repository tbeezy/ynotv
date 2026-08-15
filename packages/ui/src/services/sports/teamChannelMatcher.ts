/**
 * Team → Channel matcher.
 *
 * Maps sports teams to provider channels so a game can be watched with one tap.
 * Reuses (and now owns) the team-name heuristics that GameCard used to search
 * the EPG, plus a confidence-scoring pass that ranks candidate channels so the
 * auto-link flow can either auto-assign or hand results to the review UI.
 */

import { db } from '../../db';
import type { StoredChannel } from '../../db';
import type { SportsTeam } from '@ynotv/core';
import { buildSearchQueryClauses, normalizeText } from '../../utils/searchNormalization';

/**
 * Known city/location prefixes used in major sports team names.
 * Multi-word prefixes must be listed before single-word ones so they match greedily.
 */
export const TEAM_CITY_PREFIXES: string[] = [
  'St. Louis', 'St Louis', 'New York', 'Los Angeles', 'San Francisco', 'San Diego',
  'San Jose', 'Kansas City', 'Oklahoma City', 'Salt Lake', 'New Orleans',
  'Las Vegas', 'Green Bay', 'Tampa Bay', 'Bay Area', 'Golden State',
  'New England', 'Carolina', 'Rhode Island',
  'Fort Worth', 'Fort Lauderdale', 'El Paso', 'San Antonio', 'Little Rock',
  'Baton Rouge', 'West Ham', 'Crystal Palace', 'Brighton', 'Sheffield',
  'Nottingham', 'Wolverhampton', 'Aston', 'Porto Alegre',
  'Porto', 'Real Madrid', 'Real Sociedad', 'Real Betis', 'Real Valladolid',
  'Atletico', 'Athletic',
  'Atlanta', 'Baltimore', 'Boston', 'Buffalo', 'Charlotte', 'Chicago',
  'Cincinnati', 'Cleveland', 'Colorado', 'Columbus', 'Dallas', 'Denver',
  'Detroit', 'Edmonton', 'Florida', 'Houston', 'Indiana', 'Jacksonville',
  'Louisville', 'Memphis', 'Miami', 'Milwaukee', 'Minnesota', 'Montreal',
  'Nashville', 'Newark', 'Oakland', 'Orlando', 'Ottawa', 'Philadelphia',
  'Phoenix', 'Pittsburgh', 'Portland', 'Sacramento', 'Seattle', 'Toronto',
  'Utah', 'Vancouver', 'Washington', 'Winnipeg', 'Arizona', 'Cincinnati',
  'Jacksonville', 'Tennessee', 'Mississippi', 'Alabama', 'Georgia', 'Oregon',
  'Arsenal', 'Chelsea', 'Everton', 'Leicester', 'Liverpool', 'Fulham',
  'Brentford', 'Bournemouth', 'Burnley', 'Watford', 'Sunderland', 'Middlesbrough',
  'Bayern', 'Dortmund', 'Leverkusen', 'Leipzig', 'Frankfurt', 'Stuttgart',
  'Bremen', 'Hamburg', 'Freiburg', 'Augsburg', 'Wolfsburg', 'Mainz', 'Bochum',
  'Barcelona', 'Sevilla', 'Valencia', 'Villarreal', 'Bilbao', 'Getafe',
  'Girona', 'Alaves', 'Mallorca', 'Celta', 'Rayo', 'Osasuna', 'Cadiz',
  'Juventus', 'Napoli', 'Milan', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina',
  'Torino', 'Udine', 'Monza', 'Bologna', 'Genoa', 'Lecce', 'Frosinone',
  'Paris', 'Lyon', 'Marseille', 'Lens', 'Lille', 'Monaco', 'Montpellier',
  'Toulouse', 'Nantes', 'Strasbourg', 'Reims', 'Rennes', 'Brest', 'Clermont',
  'Ajax', 'Feyenoord', 'Eindhoven', 'Bruges', 'Anderlecht', 'Lisbon', 'Benfica',
  'Sporting', 'Porto', 'Amsterdam', 'Galatasaray', 'Fenerbahce', 'Besiktas',
  'Flamengo', 'Palmeiras', 'Santos', 'Corinthians', 'Botafogo', 'Fluminense',
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
  // 1. Try known city prefixes first
  for (const city of TEAM_CITY_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(city.toLowerCase() + ' ')) {
      const nickname = trimmed.slice(city.length).trim();
      if (nickname.length > 0) return { city, nickname };
    }
  }
  // 2. Fall back: split on last space
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > 0) {
    return {
      city: trimmed.slice(0, lastSpace),
      nickname: trimmed.slice(lastSpace + 1),
    };
  }
  // 3. Single word — treat as nickname with no city
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

// Individual sports where team names don't make sense for search — use event title instead
const INDIVIDUAL_SPORT_LEAGUES = new Set(['ufc', 'f1', 'nascar', 'indycar', 'pga', 'lpga', 'atp', 'wta']);

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
  candidates: TeamChannelCandidate[]; // ranked, best first
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

// Format/feed noise words that don't make a channel less "dedicated" to a team.
const GENERIC_CHANNEL_WORDS = new Set([
  'hd', 'fhd', 'uhd', '4k', '8k', 'sd', 'tv', 'ch', 'channel', 'net', 'network',
  'us', 'usa', 'uk', 'live', 'premium', 'feed', 'stream',
]);

/**
 * How many words in the channel name are NOT the team's own tokens and NOT
 * generic feed noise. A dedicated team channel keeps this near zero.
 */
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

/**
 * Score a channel against a team using ONLY the channel's name/alias. EPG
 * program titles are deliberately ignored — a matchup listing ("Lakers at
 * Celtics") proves the channel broadcasts the game, not that it's a channel
 * dedicated to the team.
 */
export function scoreChannelForTeam(channel: StoredChannel, team: SportsTeam): TeamChannelCandidate | null {
  const full = normalizeText(team.name);
  const short = normalizeText(team.shortName);
  const name = normalizeText(channel.name);
  const alias = normalizeText(channel.alias);
  const tokens = nicknameTokens(team);

  // Exact name matches are near-certain.
  if (full && name === full) return { channel, score: 1, reason: 'name', matchedTerm: team.name };
  if (full && alias && alias === full) return { channel, score: 0.97, reason: 'alias', matchedTerm: team.name };
  if (short && (name === short || (alias && alias === short))) {
    return { channel, score: 0.95, reason: 'name', matchedTerm: team.shortName || '' };
  }

  // Whole-word nickname tokens must appear in the channel name or alias.
  let target: string | null = null;
  if (tokens.length > 0 && tokensMatch(name, tokens)) target = name;
  else if (tokens.length > 0 && alias && tokensMatch(alias, tokens)) target = alias;
  if (!target) return null;

  const distinct = tokens.length === 1 && tokens[0].length >= 4;
  let score = distinct ? 0.88 : 0.78;

  const lowered = target.toLowerCase();
  // Matchup channels list both teams or use "vs"/"@" — never a dedicated feed.
  if (/\bvs\b|\bversus\b|@|\bat\b/.test(lowered)) {
    score = 0.3;
  } else {
    const extra = countExtraTokens(target, tokens);
    if (extra <= 1) score = Math.min(0.94, score + 0.05);
    else if (extra === 2) score = Math.max(0.6, score - 0.15);
    else score = Math.max(0.45, score - 0.32);
  }

  return { channel, score, reason: 'nickname', matchedTerm: tokens.join(' ') };
}

/**
 * Decide whether a candidate is strong enough to link without review.
 * - Near-exact matches are always safe.
 * - Confident nickname matches need a comfortable margin over the runner-up.
 */
export function shouldAutoAssign(candidates: TeamChannelCandidate[]): boolean {
  const best = candidates[0];
  if (!best) return false;
  if (best.score >= 0.95) return true;
  const second = candidates[1];
  return best.score >= 0.8 && (!second || best.score - second.score >= 0.25);
}

async function getEnabledSourceIds(): Promise<string[]> {
  try {
    const result = window.storage ? await window.storage.getSources() : { data: [] };
    return result.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || [];
  } catch {
    return [];
  }
}

/** Search channels (name or alias or stream_id) for the manual "link a channel" picker. */
export async function searchChannelsForLink(query: string, limit = 50): Promise<StoredChannel[]> {
  const term = query.trim();
  if (!term) return [];
  const enabledSourceIds = await getEnabledSourceIds();
  if (enabledSourceIds.length === 0) return [];

  const dbInstance = await (db as any).dbPromise;
  const sourcePlaceholders = enabledSourceIds.map(() => '?').join(',');
  const nameClause = buildSearchQueryClauses('c.name', term);
  const aliasClause = buildSearchQueryClauses('c.alias', term);
  const streamIdClause = /^\d+$/.test(term) ? ' OR c.stream_id = ?' : '';
  const streamIdParams = /^\d+$/.test(term) ? [term] : [];

  const sql = `SELECT c.* FROM channels c WHERE (c.enabled IS NULL OR c.enabled != 0) AND c.source_id IN (${sourcePlaceholders}) AND (( ${nameClause.sql} ) OR ( ${aliasClause.sql} )${streamIdClause}) LIMIT ${limit}`;
  const rows = await dbInstance.select(sql, [...enabledSourceIds, ...nameClause.params, ...aliasClause.params, ...streamIdParams]);
  return rows as StoredChannel[];
}

/** Get top candidate channel matches for a specific team. */
export async function getTeamChannelSuggestions(team: SportsTeam): Promise<TeamChannelCandidate[]> {
  const enabledSourceIds = await getEnabledSourceIds();
  if (enabledSourceIds.length === 0) return [];
  return findCandidatesForTeam(team, enabledSourceIds);
}

async function findCandidatesForTeam(team: SportsTeam, enabledSourceIds: string[]): Promise<TeamChannelCandidate[]> {
  const dbInstance = await (db as any).dbPromise;
  const term = normalizeText(stripCityPrefix(team.name)) || normalizeText(team.name);
  const words = term.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];

  const sourcePlaceholders = enabledSourceIds.map(() => '?').join(',');
  const nameClause = buildSearchQueryClauses('c.name', words.join(' '));
  const aliasClause = buildSearchQueryClauses('c.alias', words.join(' '));
  const sql = `SELECT c.* FROM channels c WHERE (c.enabled IS NULL OR c.enabled != 0) AND c.source_id IN (${sourcePlaceholders}) AND (( ${nameClause.sql} ) OR ( ${aliasClause.sql} )) LIMIT 40`;
  const rows = (await dbInstance.select(sql, [...enabledSourceIds, ...nameClause.params, ...aliasClause.params])) as StoredChannel[];
  if (rows.length === 0) return [];

  // Score channel names/aliases only — see scoreChannelForTeam for why EPG
  // program titles are intentionally not used for linking.
  const candidates: TeamChannelCandidate[] = [];
  for (const ch of rows) {
    const c = scoreChannelForTeam(ch, team);
    if (c) candidates.push(c);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 8);
}

/**
 * Match every team in a league to its best channel candidates. Does not write
 * anything — the store/UI decides what to auto-link and what to surface for review.
 */
export async function matchTeamsToChannels(leagueId: string, teams: SportsTeam[]): Promise<LeagueMatchResult> {
  const enabledSourceIds = await getEnabledSourceIds();
  const suggestions: TeamLinkSuggestion[] = [];
  if (enabledSourceIds.length === 0) {
    for (const team of teams) {
      suggestions.push({ leagueId, team, candidates: [], best: null, autoAssign: false });
    }
    return { leagueId, suggestions, autoLinked: [], reviewable: suggestions };
  }

  for (const team of teams) {
    const candidates = await findCandidatesForTeam(team, enabledSourceIds);
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
