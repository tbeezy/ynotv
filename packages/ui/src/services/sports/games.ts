/**
 * Games API
 *
 * Functions for fetching game details, summaries, and play-by-play
 */

import type { 
  ESPNEvent,
  GameSummary, 
  GameSummaryTeam, 
  TeamStatistics,
  PlayerStatCategory,
  ScoringPlay,
  PlayByPlay,
} from './types';
import { SPORT_CONFIG } from './config';
import { fetchJson, buildGameSummaryUrl, buildPlayByPlayUrl } from './client';

export async function getGameSummary(eventId: string, leagueId: string): Promise<GameSummary | null> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return null;

  const data = await fetchJson<{
    header: {
      id: string;
      name: string;
      competitions: Array<{
        date: string;
        status: {
          type: { state: string; detail: string; shortDetail: string };
          displayClock: string;
          period: number;
        };
        venue?: { fullName: string; address?: { city: string } };
        competitors: Array<{
          homeAway: string;
          team: { id: string; displayName: string; abbreviation: string; logos?: Array<{ href: string }> };
          score: string;
          record?: Array<{ summary: string }>;
          records?: Array<{ summary: string }>;
        }>;
        officials?: Array<{ displayName: string }>;
        broadcasts?: Array<{ names: string[] }>;
      }>;
    };
    boxscore?: {
      teams?: Array<{
        team: { id: string; displayName: string; abbreviation: string; logos?: Array<{ href: string }> };
        statistics?: Array<{
          label: string;
          displayValue: string;
        }>;
      }>;
      players?: Array<{
        team: { id: string };
        statistics?: Array<{
          name: string;
          text: string;
          labels: string[];
          descriptions?: string[];
          athletes: Array<{
            athlete: {
              id: string;
              displayName: string;
              headshot?: { href: string };
              jersey?: string;
            };
            stats: string[];
          }>;
        }>;
      }>;
    };
    rosters?: Array<{
      team: { id: string; displayName: string };
      roster?: Array<{
        athlete: {
          id: string;
          displayName: string;
          headshot?: { href: string };
          jersey?: string;
        };
        position?: { displayName: string; abbreviation?: string };
        stats?: Array<{ name: string; value: string | number; displayValue?: string }>;
        starter?: boolean;
      }>;
    }>;
    gameInfo?: {
      venue?: { fullName: string; address?: { city: string } };
      attendance?: number;
      officials?: Array<{ displayName: string }>;
    };
    plays?: Array<{
      id: string;
      period: { number: number; displayValue: string };
      clock: { displayValue: string };
      text: string;
      homeScore: number;
      awayScore: number;
      scoringPlay: boolean;
      type?: { text: string };
      team?: { id: string };
    }>;
    keyEvents?: Array<{
      id: string;
      type?: { id?: string; text?: string; type?: string };
      period?: { number: number; displayValue: string };
      clock?: { value: number; displayValue: string };
      text?: string;
      shortText?: string;
      scoringPlay?: boolean;
      team?: { id: string; displayName?: string };
      participants?: Array<{
        athlete?: { id: string; displayName: string; headshot?: { href: string } };
      }>;
    }>;
    winprobability?: Array<{
      homeWinPercentage: number;
      playId: string;
    }>;
  }>(buildGameSummaryUrl(config.sport, config.league, eventId));

  if (!data?.header) return null;

  const competition = data.header.competitions?.[0];
  const homeCompetitor = competition?.competitors?.find(c => c.homeAway === 'home');
  const awayCompetitor = competition?.competitors?.find(c => c.homeAway === 'away');

  const state = competition?.status?.type?.state || 'pre';
  let status: 'scheduled' | 'live' | 'finished' = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  return {
    id: data.header.id,
    title: data.header.name,
    date: new Date(data.header.competitions?.[0]?.date || Date.now()),
    status,
    statusDetail: competition?.status?.type?.detail || '',
    venue: data.gameInfo?.venue ? {
      name: data.gameInfo.venue.fullName,
      city: data.gameInfo.venue.address?.city,
    } : competition?.venue ? {
      name: competition.venue.fullName,
      city: competition.venue.address?.city,
    } : undefined,
    attendance: data.gameInfo?.attendance,
    officials: data.gameInfo?.officials?.map(o => o.displayName),
    broadcasts: competition?.broadcasts?.flatMap(b => b.names || []),
    homeTeam: buildGameSummaryTeam(homeCompetitor, data),
    awayTeam: buildGameSummaryTeam(awayCompetitor, data),
    scoringPlays: extractScoringPlays(data, homeCompetitor?.team?.id || ''),
    winProbability: data.winprobability,
  };
}

function buildGameSummaryTeam(
  competitor: { 
    team?: { id: string; displayName: string; abbreviation: string; logos?: Array<{ href: string }> }; 
    score?: string;
    record?: Array<{ summary: string }>;
    records?: Array<{ summary: string }>;
  } | undefined,
  data: { boxscore?: any; rosters?: any }
): GameSummaryTeam {
  const teamId = competitor?.team?.id || '';
  
  return {
    id: teamId,
    name: competitor?.team?.displayName || 'Unknown',
    shortName: competitor?.team?.abbreviation || '',
    logo: competitor?.team?.logos?.[0]?.href,
    score: parseInt(competitor?.score || '0', 10),
    record: competitor?.record?.[0]?.summary || competitor?.records?.[0]?.summary,
    statistics: extractTeamStats(teamId, data.boxscore),
    playerStats: extractPlayerStats(teamId, data.boxscore, data.rosters),
  };
}

function extractTeamStats(teamId: string, boxscore?: any): TeamStatistics[] {
  const team = boxscore?.teams?.find((t: any) => t.team.id === teamId);
  return team?.statistics?.map((s: any) => ({
    label: s.label,
    displayValue: s.displayValue,
  })) || [];
}

function extractPlayerStats(teamId: string, boxscore?: any, rosters?: any): PlayerStatCategory[] {
  // Try boxscore.players first (NFL/NBA/MLB/NHL)
  const teamPlayers = boxscore?.players?.find((p: any) => p.team.id === teamId);
  if (teamPlayers?.statistics) {
    return teamPlayers.statistics.map((stat: any) => ({
      name: stat.name,
      text: stat.text,
      labels: stat.labels,
      descriptions: stat.descriptions,
      athletes: stat.athletes.map((a: any) => ({
        athleteId: a.athlete.id,
        name: a.athlete.displayName,
        headshot: a.athlete.headshot?.href,
        jersey: a.athlete.jersey,
        stats: a.stats,
      })),
    }));
  }

  // Try rosters for soccer
  const teamRoster = rosters?.find((r: any) => r.team.id === teamId);
  if (teamRoster?.roster?.length > 0) {
    const athletes = teamRoster.roster
      .filter((p: any) => p.athlete)
      .map((p: any) => ({
        athleteId: p.athlete.id,
        name: p.athlete.displayName,
        headshot: p.athlete.headshot?.href,
        jersey: p.athlete.jersey,
        stats: p.stats?.map((s: any) => String(s.displayValue || s.value)) || [],
      }));

    if (athletes.length > 0) {
      return [{
        name: 'roster',
        text: 'Starting Lineup',
        labels: ['Pos', 'Jersey', 'Name'],
        athletes: athletes.slice(0, 11),
      }];
    }
  }

  return [];
}

function extractScoringPlays(data: any, homeTeamId: string): ScoringPlay[] {
  const scoringPlays: ScoringPlay[] = [];

  // NFL/NBA/MLB/NHL use plays array
  if (data.plays) {
    for (const p of data.plays) {
      if (p.scoringPlay) {
        scoringPlays.push({
          id: p.id,
          period: typeof p.period === 'object' ? p.period.displayValue : `Q${p.period}`,
          clock: typeof p.clock === 'object' ? p.clock.displayValue : '',
          text: p.text,
          homeScore: p.homeScore,
          awayScore: p.awayScore,
          scoringType: p.type?.text,
          teamId: p.team?.id,
        });
      }
    }
  }

  // Soccer uses keyEvents array for goals
  if (data.keyEvents) {
    for (const e of data.keyEvents) {
      if (e.scoringPlay || (e.type?.type && e.type.type.includes('goal'))) {
        let homeScore = 0;
        let awayScore = 0;
        if (e.text) {
          const scoreMatch = e.text.match(/(\d+)\s*,\s*(\d+)/);
          if (scoreMatch) {
            awayScore = parseInt(scoreMatch[1], 10);
            homeScore = parseInt(scoreMatch[2], 10);
          }
        }

        scoringPlays.push({
          id: e.id,
          period: e.period?.displayValue || 'Half',
          clock: e.clock?.displayValue || '',
          text: e.text || e.shortText || 'Goal',
          homeScore,
          awayScore,
          scoringType: e.type?.text || 'Goal',
          teamId: e.team?.id,
        });
      }
    }
  }

  return scoringPlays;
}

export async function getPlayByPlay(eventId: string, leagueId: string): Promise<PlayByPlay | null> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return null;

  const data = await fetchJson<{
    header: {
      competitions: Array<{
        competitors: Array<{
          homeAway: string;
          team: { id: string };
        }>;
      }>;
    };
    competitions?: Array<{
      competitors: Array<{
        homeAway: string;
        team: { id: string };
      }>;
    }>;
  }>(buildPlayByPlayUrl(config.sport, config.league, eventId));

  if (!data) return null;

  const competition = data.header?.competitions?.[0] || data.competitions?.[0];
  const homeTeam = competition?.competitors?.find((c: any) => c.homeAway === 'home')?.team?.id || '';
  const awayTeam = competition?.competitors?.find((c: any) => c.homeAway === 'away')?.team?.id || '';

  return {
    teams: { home: homeTeam, away: awayTeam },
    periods: [],
  };
}
