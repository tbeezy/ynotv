/**
 * Teams API
 *
 * Functions for fetching team information and schedules
 */

import type { 
  ESPTeam, 
  ESPNEvent, 
  SportsTeam, 
  SportsEvent,
  TeamDetails,
  TeamRecord,
  TeamAthlete,
  StandingTeam,
  StandingGroup,
} from './types';
import { SPORT_CONFIG } from './config';
import { 
  fetchJson, 
  buildTeamsUrl, 
  buildTeamUrl, 
  buildTeamScheduleUrl,
  buildStandingsUrl,
} from './client';
import { mapESPNEvent, mapESPNTeam } from './mappers';

const MAJOR_SPORTS = ['nfl', 'nba', 'mlb', 'nhl'];

export async function searchTeams(query: string): Promise<SportsTeam[]> {
  const results: SportsTeam[] = [];
  const queryLower = query.toLowerCase();

  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{
      sports?: Array<{
        leagues?: Array<{
          teams?: Array<{ team?: ESPTeam }>;
        }>;
      }>;
    }>(buildTeamsUrl(config.sport, config.league));

    if (data?.sports) {
      for (const sport of data.sports) {
        for (const league of sport.leagues || []) {
          for (const teamWrapper of league.teams || []) {
            const team = teamWrapper.team;
            if (team && matchesTeamQuery(team, queryLower)) {
              results.push(mapESPNTeam(team, sportKey));
            }
          }
        }
      }
    }
  }

  console.log('[ESPN API] Team search results:', results.length, 'for', query);
  return results;
}

function matchesTeamQuery(team: ESPTeam, query: string): boolean {
  return (
    team.displayName?.toLowerCase().includes(query) ||
    team.location?.toLowerCase().includes(query) ||
    team.name?.toLowerCase().includes(query) ||
    team.shortDisplayName?.toLowerCase().includes(query) ||
    team.abbreviation?.toLowerCase() === query
  );
}

export async function getTeamById(id: string): Promise<SportsTeam | null> {
  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ team: ESPTeam }>(
      buildTeamUrl(config.sport, config.league, id)
    );

    if (data?.team) {
      return mapESPNTeam(data.team, sportKey);
    }
  }

  return null;
}

export async function getTeamNextEvents(teamId: string): Promise<SportsEvent[]> {
  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ team: ESPTeam }>(
      buildTeamUrl(config.sport, config.league, teamId)
    );

    if (data?.team?.nextEvent) {
      return data.team.nextEvent.map(e => mapESPNEvent(e, sportKey));
    }
  }

  return [];
}

export async function getTeamPastEvents(teamId: string, limit: number = 10): Promise<SportsEvent[]> {
  for (const sportKey of MAJOR_SPORTS) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ events?: ESPNEvent[] }>(
      buildTeamScheduleUrl(config.sport, config.league, teamId)
    );

    if (data?.events) {
      const now = new Date();
      return data.events
        .filter(e => new Date(e.date) < now)
        .slice(-limit)
        .map(e => mapESPNEvent(e, sportKey));
    }
  }

  return [];
}

export async function getTeamSchedule(teamId: string, leagueId: string): Promise<{ upcoming: SportsEvent[]; past: SportsEvent[] }> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return { upcoming: [], past: [] };

  const data = await fetchJson<{ events?: ESPNEvent[] }>(
    buildTeamScheduleUrl(config.sport, config.league, teamId)
  );

  if (!data?.events) return { upcoming: [], past: [] };

  const now = new Date();
  const allEvents = data.events.map(e => mapESPNEvent(e, leagueId));
  
  return {
    upcoming: allEvents.filter(e => e.startTime >= now),
    past: allEvents.filter(e => e.startTime < now).reverse(),
  };
}

export async function getTeamDetails(teamId: string, leagueId: string): Promise<TeamDetails | null> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return null;

  const data = await fetchJson<{
    team: {
      id: string;
      location: string;
      name: string;
      displayName: string;
      shortDisplayName: string;
      abbreviation: string;
      color: string;
      alternateColor: string;
      logos?: Array<{ href: string }>;
      record?: {
        items?: Array<{
          type: string;
          summary: string;
          description?: string;
          stats?: Array<{ name: string; value: number }>;
        }>;
      };
      standingSummary?: string;
      nextEvent?: ESPNEvent[];
      athletes?: Array<{
        id: string;
        firstName: string;
        lastName: string;
        displayName: string;
        jersey?: string;
        position?: { displayName: string; abbreviation?: string };
        headshot?: { href: string };
        displayHeight?: string;
        displayWeight?: string;
        age?: number;
        experience?: { displayValue: string };
        college?: { name: string };
      }>;
    };
  }>(`${buildTeamUrl(config.sport, config.league, teamId)}?enable=roster`);

  if (!data?.team) return null;

  const team = data.team;

  return {
    id: team.id,
    name: team.displayName,
    shortName: team.shortDisplayName,
    location: team.location,
    abbreviation: team.abbreviation,
    color: team.color,
    alternateColor: team.alternateColor,
    logo: team.logos?.[0]?.href,
    record: parseTeamRecord(team.record),
    standingSummary: team.standingSummary,
    nextEvent: team.nextEvent?.[0] ? mapESPNEvent(team.nextEvent[0], leagueId) : undefined,
    athletes: (team.athletes || []).map(a => ({
      id: a.id,
      name: a.displayName,
      firstName: a.firstName,
      lastName: a.lastName,
      jersey: a.jersey,
      position: a.position?.displayName || '',
      positionAbbrev: a.position?.abbreviation,
      headshot: a.headshot?.href,
      height: a.displayHeight,
      weight: a.displayWeight,
      age: a.age,
      experience: a.experience?.displayValue,
      college: a.college?.name,
    })),
  };
}

function parseTeamRecord(recordData?: { items?: Array<{ type: string; summary: string; stats?: Array<{ name: string; value: number }> }> }): TeamRecord | undefined {
  if (!recordData?.items) return undefined;

  const totalRecord = recordData.items.find(r => r.type === 'total');
  if (!totalRecord) return undefined;

  const stats = totalRecord.stats || [];
  const getStat = (name: string) => stats.find(s => s.name === name)?.value || 0;

  return {
    overall: totalRecord.summary,
    home: recordData.items.find(r => r.type === 'home')?.summary || '',
    away: recordData.items.find(r => r.type === 'road')?.summary || '',
    wins: getStat('wins'),
    losses: getStat('losses'),
    ties: getStat('ties') || undefined,
    winPercent: getStat('winPercent'),
    pointsFor: getStat('pointsFor'),
    pointsAgainst: getStat('pointsAgainst'),
    pointDifferential: getStat('pointDifferential') || getStat('differential'),
    avgPointsFor: getStat('avgPointsFor'),
    avgPointsAgainst: getStat('avgPointsAgainst'),
  };
}

export async function getLeagueTeams(leagueId: string): Promise<SportsTeam[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    sports?: Array<{
      leagues?: Array<{
        teams?: Array<{ team?: ESPTeam }>;
      }>;
    }>;
  }>(buildTeamsUrl(config.sport, config.league));

  const teams: SportsTeam[] = [];

  if (data?.sports) {
    for (const sport of data.sports) {
      for (const league of sport.leagues || []) {
        for (const teamWrapper of league.teams || []) {
          const team = teamWrapper.team;
          if (team) {
            teams.push(mapESPNTeam(team, leagueId));
          }
        }
      }
    }
  }

  console.log('[ESPN API] League teams:', teams.length, 'for', leagueId);
  return teams;
}

export async function getLeagueStandings(leagueId: string): Promise<StandingTeam[]> {
  const groups = await getLeagueStandingsGrouped(leagueId);
  return groups.flatMap(g => g.teams);
}

export async function getLeagueStandingsGrouped(leagueId: string): Promise<StandingGroup[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    children?: Array<{
      name: string;
      abbreviation: string;
      isConference: boolean;
      standings?: {
        entries?: Array<{
          team: {
            id: string;
            displayName: string;
            abbreviation: string;
            logos?: Array<{ href: string }>;
          };
          stats?: Array<{
            name: string;
            value: number;
            displayValue: string;
          }>;
        }>;
      };
    }>;
  }>(buildStandingsUrl(config.sport, config.league));

  const groups: StandingGroup[] = [];

  if (data?.children) {
    for (const conference of data.children) {
      const entries = conference.standings?.entries || [];
      const teams: StandingTeam[] = [];
      
      for (const entry of entries) {
        const team = entry.team;
        const stats = entry.stats || [];
        
        const getStat = (name: string) => stats.find(s => s.name === name)?.value ?? 0;
        
        const wins = getStat('wins');
        const losses = getStat('losses');
        const winPercent = getStat('winPercent');
        const gamesBehind = getStat('gamesBehind');
        const streak = getStat('streak');
        
        const total = wins + losses;
        const winPercentDisplay = winPercent > 0 
          ? (winPercent * 100).toFixed(1) 
          : total > 0 
            ? ((wins / total) * 100).toFixed(1) 
            : '0.0';

        teams.push({
          id: team.id,
          name: team.displayName,
          shortName: team.abbreviation,
          logo: team.logos?.[0]?.href,
          wins,
          losses,
          ties: 0,
          winPercent: winPercentDisplay,
          winPercentValue: winPercent || (total > 0 ? wins / total : 0),
          gamesBehind: gamesBehind ? String(gamesBehind) : undefined,
          streak: streak ? (streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`) : undefined,
          division: conference.isConference ? conference.name : undefined,
          rank: 0,
        });
      }

      // Sort by win percentage within each group
      teams.sort((a, b) => b.winPercentValue - a.winPercentValue);
      teams.forEach((team, idx) => { team.rank = idx + 1; });

      if (teams.length > 0) {
        groups.push({
          name: conference.name,
          isConference: conference.isConference,
          teams,
        });
      }
    }
  }

  console.log('[ESPN API] Standings groups:', groups.length, 'for', leagueId);
  return groups;
}
