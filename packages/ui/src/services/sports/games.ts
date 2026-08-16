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
  MatchEvent,
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
          linescores?: Array<{ value: number; displayValue: string; period: number }>;
        }>;
        officials?: Array<{ displayName: string }>;
        broadcasts?: Array<{ names: string[] }>;
        details?: Array<{
          id?: string;
          sequenceNumber?: number;
          type?: { id?: string; text?: string };
          clock?: { value?: number; displayValue?: string };
          period?: number;
          team?: { id?: string };
          athletesInvolved?: Array<{
            displayName?: string;
            shortName?: string;
            position?: string;
          }>;
          homeScore?: number;
          awayScore?: number;
          addedClock?: { value?: number; displayValue?: string };
        }>;
      }>;
    };
    boxscore?: {
      teams?: Array<{
        team: { id: string; displayName: string; abbreviation: string; logos?: Array<{ href: string }> };
        // NFL/NBA: flat array of { label, displayValue }
        // MLB: nested categories { name, displayName, stats: [{ name, displayName, displayValue }] }
        statistics?: Array<{
          label?: string;
          displayValue?: string;
          name?: string;
          displayName?: string;
          stats?: Array<{
            name: string;
            displayName: string;
            shortDisplayName?: string;
            displayValue: string;
            value?: number;
          }>;
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
      homeAway?: string;
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
        captain?: boolean;
        active?: boolean;
        subbedIn?: boolean;
        subbedOut?: boolean;
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
    matchEvents: extractMatchEvents(data),
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
  if (!team?.statistics) return [];

  // Handle MLB-style nested statistics (categories with nested stats array)
  // Each category has: name, displayName, stats[]
  // Each stat in stats[] has: name, displayName, displayValue, value
  const stats: TeamStatistics[] = [];
  for (const category of team.statistics) {
    if (category.stats && Array.isArray(category.stats)) {
      for (const stat of category.stats) {
        stats.push({
          label: stat.displayName || stat.shortDisplayName || stat.name,
          displayValue: stat.displayValue ?? String(stat.value ?? '-'),
        });
      }
    } else if (category.label && category.displayValue !== undefined) {
      // Handle flat format (NFL/NBA style): { label, displayValue }
      stats.push({
        label: category.label,
        displayValue: category.displayValue,
      });
    }
  }
  return stats;
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

  // Rugby: Build lineup categories from roster (no stats, just player info)
  const teamRoster = rosters?.find((r: any) => r.team.id === teamId);
  if (teamRoster?.roster?.length > 0 && !teamRoster.roster[0].stats) {
    const categories: PlayerStatCategory[] = [];

    const allPlayers = teamRoster.roster
      .filter((p: any) => p.athlete)
      .map((p: any) => {
        const pos = p.position?.abbreviation || p.position?.displayName || '';
        const prefix = p.captain ? '(C) ' : '';
        return {
          athleteId: p.athlete.id,
          name: pos ? `${prefix}[${pos}] ${p.athlete.displayName}` : `${prefix}${p.athlete.displayName}`,
          headshot: p.athlete.headshot?.href,
          jersey: p.athlete.jersey,
          stats: [] as string[],
          starter: p.starter,
          subbedIn: p.subbedIn,
          subbedOut: p.subbedOut,
        };
      });

    const starters = allPlayers.filter((p: any) => p.starter);
    if (starters.length > 0) {
      categories.push({
        name: 'starting-xv',
        text: 'Starting XV',
        labels: [],
        descriptions: [],
        athletes: starters,
      });
    }

    const subs = allPlayers.filter((p: any) => !p.starter);
    if (subs.length > 0) {
      categories.push({
        name: 'substitutes',
        text: 'Substitutes',
        labels: [],
        descriptions: [],
        athletes: subs,
      });
    }

    return categories;
  }

  // Soccer: Build dynamic player stat table from roster
  if (teamRoster?.roster?.length > 0) {
    // Collect all unique stat names and their metadata
    const statMeta = new Map<string, { shortName: string; fullName: string }>();
    for (const player of teamRoster.roster) {
      for (const stat of (player.stats || [])) {
        if (!statMeta.has(stat.name)) {
          statMeta.set(stat.name, {
            shortName: stat.shortDisplayName || stat.abbreviation || stat.displayName || stat.name,
            fullName: stat.displayName || stat.name,
          });
        }
      }
    }

    // Priority order for soccer stats (most important first)
    const priority = [
      'totalGoals', 'goalAssists', 'totalShots', 'shotsOnTarget',
      'saves', 'goalsConceded', 'shotsFaced',
      'yellowCards', 'redCards', 'foulsCommitted', 'foulsSuffered',
      'offsides', 'ownGoals', 'subIns', 'appearances'
    ];
    const statNames = Array.from(statMeta.keys()).sort((a, b) => {
      const pa = priority.indexOf(a);
      const pb = priority.indexOf(b);
      if (pa >= 0 && pb >= 0) return pa - pb;
      if (pa >= 0) return -1;
      if (pb >= 0) return 1;
      return a.localeCompare(b);
    });

    const labels = statNames.map(n => statMeta.get(n)!.shortName);
    const descriptions = statNames.map(n => statMeta.get(n)!.fullName);

    const allAthletes = teamRoster.roster
      .filter((p: any) => p.athlete)
      .map((p: any) => {
        const statMap = new Map<string, string>();
        for (const stat of (p.stats || [])) {
          statMap.set(stat.name, String(stat.displayValue ?? stat.value ?? '-'));
        }
        const posAbbr = p.position?.abbreviation || p.position?.name?.slice(0, 2) || '';
        return {
          athleteId: p.athlete.id,
          name: posAbbr ? `[${posAbbr}] ${p.athlete.displayName}` : p.athlete.displayName,
          headshot: p.athlete.headshot?.href,
          jersey: p.athlete.jersey,
          stats: statNames.map(n => statMap.get(n) || '-'),
        };
      });

    const categories: PlayerStatCategory[] = [];

    // Starting XI
    const starters = allAthletes.filter((a: any) =>
      teamRoster.roster.find((p: any) => p.athlete?.id === a.athleteId)?.starter === true
    );
    if (starters.length > 0) {
      categories.push({
        name: 'starters',
        text: `Starting Lineup${teamRoster.formation ? ` — ${teamRoster.formation}` : ''}`,
        labels,
        descriptions,
        athletes: starters,
      });
    }

    // Substitutes
    const subs = allAthletes.filter((a: any) =>
      teamRoster.roster.find((p: any) => p.athlete?.id === a.athleteId)?.starter !== true
    );
    if (subs.length > 0) {
      categories.push({
        name: 'subs',
        text: 'Substitutes',
        labels,
        descriptions,
        athletes: subs,
      });
    }

    return categories;
  }

  return [];
}

function extractScoringPlays(data: any, homeTeamId: string): ScoringPlay[] {
  const scoringPlays: ScoringPlay[] = [];

  const formatPeriod = (period: any): string => {
    if (!period) return '';
    if (typeof period === 'object') {
      return period.displayValue || (period.number ? `Q${period.number}` : '');
    }
    if (typeof period === 'number') return `Q${period}`;
    return String(period);
  };

  const formatClock = (clock: any): string => {
    if (!clock) return '';
    if (typeof clock === 'object') return clock.displayValue || '';
    return String(clock);
  };

  // 1. Direct top-level scoringPlays array (NFL, NCAAF, etc.)
  if (Array.isArray(data.scoringPlays) && data.scoringPlays.length > 0) {
    for (const p of data.scoringPlays) {
      scoringPlays.push({
        id: p.id || '',
        period: formatPeriod(p.period),
        clock: formatClock(p.clock),
        text: p.text || '',
        homeScore: typeof p.homeScore === 'number' ? p.homeScore : parseInt(p.homeScore || '0', 10),
        awayScore: typeof p.awayScore === 'number' ? p.awayScore : parseInt(p.awayScore || '0', 10),
        scoringType: p.scoringType?.displayName || p.type?.text || p.scoringType?.abbreviation || p.type?.abbreviation || '',
        teamId: p.team?.id,
      });
    }
    return scoringPlays;
  }

  // 2. Plays array (NBA, MLB, NHL, etc.)
  if (Array.isArray(data.plays) && data.plays.length > 0) {
    for (const p of data.plays) {
      if (p.scoringPlay) {
        scoringPlays.push({
          id: p.id || '',
          period: formatPeriod(p.period),
          clock: formatClock(p.clock),
          text: p.text || '',
          homeScore: typeof p.homeScore === 'number' ? p.homeScore : parseInt(p.homeScore || '0', 10),
          awayScore: typeof p.awayScore === 'number' ? p.awayScore : parseInt(p.awayScore || '0', 10),
          scoringType: p.scoringType?.displayName || p.type?.text || (p.scoreValue ? `+${p.scoreValue} pts` : ''),
          teamId: p.team?.id,
        });
      }
    }
    if (scoringPlays.length > 0) return scoringPlays;
  }

  // 3. Drives plays (Football fallback)
  if (data.drives && Array.isArray(data.drives.previous)) {
    for (const drive of data.drives.previous) {
      if (Array.isArray(drive.plays)) {
        for (const p of drive.plays) {
          if (p.scoringPlay) {
            scoringPlays.push({
              id: p.id || '',
              period: formatPeriod(p.period),
              clock: formatClock(p.clock),
              text: p.text || '',
              homeScore: typeof p.homeScore === 'number' ? p.homeScore : parseInt(p.homeScore || '0', 10),
              awayScore: typeof p.awayScore === 'number' ? p.awayScore : parseInt(p.awayScore || '0', 10),
              scoringType: p.scoringType?.displayName || p.type?.text || drive.result || '',
              teamId: p.team?.id || drive.team?.id,
            });
          }
        }
      }
    }
    if (scoringPlays.length > 0) return scoringPlays;
  }

  // 4. Soccer keyEvents
  if (Array.isArray(data.keyEvents)) {
    for (const e of data.keyEvents) {
      const typeText = (e.type?.text || e.type?.type || '').toLowerCase();
      if (e.scoringPlay || typeText.includes('goal')) {
        let homeScore = typeof e.homeScore === 'number' ? e.homeScore : 0;
        let awayScore = typeof e.awayScore === 'number' ? e.awayScore : 0;
        if (!homeScore && !awayScore && e.text) {
          const scoreMatch = e.text.match(/(\d+)\s*,\s*(\d+)/);
          if (scoreMatch) {
            awayScore = parseInt(scoreMatch[1], 10);
            homeScore = parseInt(scoreMatch[2], 10);
          }
        }

        scoringPlays.push({
          id: e.id || '',
          period: formatPeriod(e.period) || 'Half',
          clock: formatClock(e.clock),
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

function extractMatchEvents(data: any): MatchEvent[] | undefined {
  const details = data.header?.competitions?.[0]?.details;
  if (!details || !Array.isArray(details)) return undefined;

  const scoringTypes = new Set(['try', 'conversion', 'penalty goal', 'drop goal']);

  return details
    .filter((d: any) => {
      const t = (d.type?.text || '').toLowerCase();
      return !t.includes('substituted') && !t.includes('substitute on');
    })
    .map((d: any, idx: number) => {
    const eventType = d.type?.text || 'event';
    const isScoring = scoringTypes.has(eventType.toLowerCase());

    // Parse period — can be a number or an object { number, displayValue }
    let periodText = '';
    if (typeof d.period === 'number') {
      periodText = d.period === 1 ? '1st Half' : d.period === 2 ? '2nd Half' : `Half ${d.period}`;
    } else if (d.period && typeof d.period === 'object') {
      periodText = d.period.displayValue || String(d.period.number || '');
    }

    // Build description text
    let text = eventType;
    if (d.athletesInvolved && d.athletesInvolved.length > 0) {
      const names = d.athletesInvolved.map((a: any) => a.shortName || a.displayName).join(', ');
      text = `${eventType} — ${names}`;
    }

    return {
      id: d.id || String(d.sequenceNumber || idx),
      type: eventType,
      period: periodText,
      clock: d.clock?.displayValue || '',
      text,
      homeScore: d.homeScore ?? 0,
      awayScore: d.awayScore ?? 0,
      teamId: d.team?.id,
      isScoring,
    };
  });
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
