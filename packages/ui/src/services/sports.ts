/**
 * Sports API Service
 *
 * Fetches sports data from ESPN's public API (free, no API key required)
 * Provides live scores, upcoming games, team info, and TV channel listings.
 */

import { fetch } from '@tauri-apps/plugin-http';
import type { SportsEvent, SportsTeam, SportsLeague, SportsBroadcastChannel } from '@ynotv/core';

const ESPN_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

interface ESPNEvent {
  id: string;
  uid: string;
  name: string;
  shortName: string;
  date: string;
  status: {
    type: {
      name: string;
      state: string;
      shortDetail: string;
      detail: string;
    };
    displayClock: string;
    period: number;
  };
  competitions: Array<{
    id: string;
    competitors: Array<{
      id: string;
      uid: string;
      homeAway?: string;
      order?: number;
      winner?: boolean;
      score?: string | { value: number; displayValue: string };
      records?: Array<{ summary: string; }>;
      // Team sports (NFL, NBA, etc.)
      team?: {
        id: string;
        uid: string;
        location: string;
        name: string;
        abbreviation: string;
        displayName: string;
        shortDisplayName: string;
        logos?: Array<{ href: string; }>;
      };
      // Individual sports (UFC/MMA)
      type?: string;
      athlete?: {
        id: string;
        uid: string;
        fullName: string;
        displayName: string;
        shortName: string;
        flag?: { href: string; alt: string };
        headshot?: { href: string };
        record?: Array<{ summary: string }>;
      };
    }>;
    broadcasts?: Array<{
      market: string;
      names: string[];
    }>;
    venue?: {
      fullName: string;
    };
  }>;
  season?: {
    year: number;
    type: number;
  };
  week?: number;
}

interface ESPTeam {
  id: string;
  uid: string;
  location: string;
  name: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  logos?: Array<{ href: string; }>;
  record?: { items: Array<{ summary: string; }>; };
  nextEvent?: ESPNEvent[];
}

interface ESPNLeague {
  id: string;
  uid: string;
  name: string;
  abbreviation: string;
  slug: string;
}

const SPORT_CONFIG: Record<string, { sport: string; league: string; name: string; category: string; }> = {
  // Football
  'nfl': { sport: 'football', league: 'nfl', name: 'NFL', category: 'football' },
  'college-football': { sport: 'football', league: 'college-football', name: 'NCAAF', category: 'football' },
  
  // Basketball
  'nba': { sport: 'basketball', league: 'nba', name: 'NBA', category: 'basketball' },
  'mens-college-basketball': { sport: 'basketball', league: 'mens-college-basketball', name: 'NCAAM', category: 'basketball' },
  'womens-college-basketball': { sport: 'basketball', league: 'womens-college-basketball', name: 'NCAAW', category: 'basketball' },
  'wnba': { sport: 'basketball', league: 'wnba', name: 'WNBA', category: 'basketball' },
  
  // Baseball
  'mlb': { sport: 'baseball', league: 'mlb', name: 'MLB', category: 'baseball' },
  
  // Hockey
  'nhl': { sport: 'hockey', league: 'nhl', name: 'NHL', category: 'hockey' },
  
  // Soccer
  'soccer-eng.1': { sport: 'soccer', league: 'eng.1', name: 'Premier League', category: 'soccer' },
  'soccer-eng.2': { sport: 'soccer', league: 'eng.2', name: 'Championship', category: 'soccer' },
  'soccer-esp.1': { sport: 'soccer', league: 'esp.1', name: 'La Liga', category: 'soccer' },
  'soccer-ger.1': { sport: 'soccer', league: 'ger.1', name: 'Bundesliga', category: 'soccer' },
  'soccer-ita.1': { sport: 'soccer', league: 'ita.1', name: 'Serie A', category: 'soccer' },
  'soccer-fra.1': { sport: 'soccer', league: 'fra.1', name: 'Ligue 1', category: 'soccer' },
  'soccer-usa.1': { sport: 'soccer', league: 'usa.1', name: 'MLS', category: 'soccer' },
  'soccer-uefa.champions': { sport: 'soccer', league: 'uefa.champions', name: 'Champions League', category: 'soccer' },
  'soccer-uefa.europa': { sport: 'soccer', league: 'uefa.europa', name: 'Europa League', category: 'soccer' },
  'soccer-mex.1': { sport: 'soccer', league: 'mex.1', name: 'Liga MX', category: 'soccer' },
  'soccer-ned.1': { sport: 'soccer', league: 'ned.1', name: 'Eredivisie', category: 'soccer' },
  'soccer-por.1': { sport: 'soccer', league: 'por.1', name: 'Primeira Liga', category: 'soccer' },
  
  // MMA
  'ufc': { sport: 'mma', league: 'ufc', name: 'UFC', category: 'mma' },
  
  // Golf
  'pga': { sport: 'golf', league: 'pga', name: 'PGA Tour', category: 'golf' },
  'lpga': { sport: 'golf', league: 'lpga', name: 'LPGA', category: 'golf' },
  
  // Tennis
  'atp': { sport: 'tennis', league: 'atp', name: 'ATP Tour', category: 'tennis' },
  'wta': { sport: 'tennis', league: 'wta', name: 'WTA Tour', category: 'tennis' },
  
  // Racing
  'f1': { sport: 'racing', league: 'f1', name: 'Formula 1', category: 'racing' },
  'nascar': { sport: 'racing', league: 'nascar-premier', name: 'NASCAR Cup', category: 'racing' },
  'indycar': { sport: 'racing', league: 'irl', name: 'IndyCar', category: 'racing' },
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    console.log('[ESPN API] Fetching:', url);
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      console.warn(`[ESPN API] Request failed: ${response.status} ${url}`);
      return null;
    }
    const text = await response.text();
    const data = JSON.parse(text) as T;
    console.log('[ESPN API] Response received:', url);
    return data;
  } catch (err) {
    console.error('[ESPN API] Fetch error:', err, url);
    return null;
  }
}

function mapESPNEvent(event: ESPNEvent, sportKey: string): SportsEvent {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];

  // Determine sport type
  const isGolf = sportKey === 'pga' || sportKey === 'lpga';
  const isTennis = sportKey.startsWith('atp') || sportKey.startsWith('wta') || sportKey.includes('tennis');
  const isRacing = sportKey === 'f1' || sportKey === 'nascar' || sportKey === 'indycar';
  const isIndividualSport = sportKey === 'ufc' || isGolf || isTennis || isRacing;

  // Team sports: find by homeAway
  let homeCompetitor = competitors.find(c => c.homeAway === 'home');
  let awayCompetitor = competitors.find(c => c.homeAway === 'away');

  // UFC/MMA: order determines fighter position
  if (sportKey === 'ufc' && competitors.length >= 2) {
    const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 0) - (b.order || 0));
    awayCompetitor = sortedCompetitors[0];
    homeCompetitor = sortedCompetitors[1];
  }

  // Golf: Show tournament leaderboard (top player as "leader")
  if (isGolf && competitors.length > 0) {
    // Sort by order (position) to get the leader
    const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 999) - (b.order || 999));
    const leader = sortedCompetitors[0];
    
    if (leader?.athlete) {
      awayCompetitor = {
        id: leader.athlete.id,
        athlete: leader.athlete,
      } as any;
      homeCompetitor = {
        id: 'field',
        athlete: { displayName: `${competitors.length} Players` },
      } as any;
    }
  }

  // F1/Racing: Show race session type
  if (isRacing && competition) {
    const sessionType = (competition as any).type?.abbreviation || 'Race';
    // For racing, show the session as a simple event
    awayCompetitor = {
      id: 'session',
      athlete: { displayName: sessionType },
    } as any;
    homeCompetitor = {
      id: 'session2',
      athlete: { displayName: event.name },
    } as any;
  }

  // Tennis: Handle match pairings if available
  if (isTennis && competitors.length >= 2) {
    const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 0) - (b.order || 0));
    awayCompetitor = sortedCompetitors[0];
    homeCompetitor = sortedCompetitors[1];
  }

  const state = event.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  const config = SPORT_CONFIG[sportKey] || { name: sportKey.toUpperCase() };

  const channels: SportsBroadcastChannel[] = [];
  if (competition?.broadcasts) {
    for (const broadcast of competition.broadcasts) {
      for (const name of broadcast.names || []) {
        channels.push({ name, country: broadcast.market });
      }
    }
  }
  // Also check event-level broadcasts for racing
  if ((event as any).broadcasts) {
    for (const broadcast of (event as any).broadcasts) {
      for (const name of broadcast.names || []) {
        if (!channels.find(c => c.name === name)) {
          channels.push({ name, country: broadcast.market });
        }
      }
    }
  }

  // Helper to get team/fighter info from competitor
  const getTeamInfo = (competitor: typeof competitors[0] | undefined, isIndividual: boolean) => {
    if (!competitor) {
      return { id: '', name: 'TBD', shortName: undefined, logo: undefined };
    }

    if (isIndividual && competitor.athlete) {
      return {
        id: competitor.athlete.id,
        name: competitor.athlete.displayName || competitor.athlete.fullName || 'Unknown',
        shortName: competitor.athlete.shortName,
        logo: competitor.athlete.headshot?.href || competitor.athlete.flag?.href,
      };
    } else if (competitor.team) {
      return {
        id: competitor.team.id,
        name: competitor.team.displayName || 'Unknown',
        shortName: competitor.team.abbreviation,
        logo: competitor.team.logos?.[0]?.href,
      };
    }

    return { id: competitor.id, name: 'Unknown', shortName: undefined, logo: undefined };
  };

  const homeTeam = getTeamInfo(homeCompetitor, isIndividualSport);
  const awayTeam = getTeamInfo(awayCompetitor, isIndividualSport);

  // For Golf, get the leader's score
  let golfLeaderScore: number | undefined;
  if (isGolf && competitors.length > 0) {
    const sortedCompetitors = [...competitors].sort((a, b) => (a.order || 999) - (b.order || 999));
    const leader = sortedCompetitors[0];
    if (leader?.score) {
      const scoreVal = typeof leader.score === 'object' ? leader.score.value : parseInt(leader.score, 10);
      if (!isNaN(scoreVal)) golfLeaderScore = scoreVal;
    }
  }

  return {
    id: event.id,
    title: event.name,
    homeTeam,
    awayTeam,
    league: {
      id: sportKey,
      name: config.name,
      sport: config.sport,
    },
    startTime: new Date(event.date),
    status,
    homeScore: isGolf ? golfLeaderScore : (() => {
      const score = homeCompetitor?.score;
      if (typeof score === 'object' && score?.value !== undefined) {
        return Math.round(score.value);
      }
      if (typeof score === 'string' && score !== '') {
        return parseInt(score, 10) || undefined;
      }
      return undefined;
    })(),
    awayScore: (() => {
      const score = awayCompetitor?.score;
      if (typeof score === 'object' && score?.value !== undefined) {
        return Math.round(score.value);
      }
      if (typeof score === 'string' && score !== '') {
        return parseInt(score, 10) || undefined;
      }
      return undefined;
    })(),
    period: event.status?.period?.toString(),
    timeElapsed: event.status?.displayClock,
    channels,
    venue: competition?.venue?.fullName || (event as any).venues?.[0]?.fullName,
  };
}

export async function getScoreboard(sportKey: string, date?: Date): Promise<SportsEvent[]> {
  const config = SPORT_CONFIG[sportKey];
  if (!config) {
    console.warn('[ESPN API] Unknown sport key:', sportKey);
    return [];
  }

  let url = `${ESPN_API_BASE}/${config.sport}/${config.league}/scoreboard`;
  
  // If date is provided, add the dates parameter
  if (date) {
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    url += `?dates=${dateStr}`;
  }

  const data = await fetchJson<{ events: ESPNEvent[] }>(url);

  if (!data?.events) return [];

  return data.events.map(e => mapESPNEvent(e, sportKey));
}

export async function getLiveScores(leagues?: string[]): Promise<SportsEvent[]> {
  const allEvents: SportsEvent[] = [];
  
  const majorSports = leagues || [
    'nfl',
    'college-football',
    'nba',
    'mens-college-basketball',
    'mlb',
    'nhl',
    'soccer-eng.1',
    'soccer-uefa.champions',
    'soccer-usa.1',
    'ufc',
  ];
  
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  
  for (const sportKey of majorSports) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;
    
    try {
      const url = `${ESPN_API_BASE}/${config.sport}/${config.league}/scoreboard`;
      const data = await fetchJson<{ events: ESPNEvent[] }>(url);
      
      if (data?.events) {
        const events = data.events.map(e => mapESPNEvent(e, sportKey));
        allEvents.push(...events);
      }
    } catch (err) {
      console.error('[ESPN API] Error fetching', sportKey, err);
    }
  }

  // Filter to only show:
  // 1. Live games (status === 'live')
  // 2. Games scheduled for today
  // 3. Finished games that ended within the last 6 hours
  const filteredEvents = allEvents.filter(event => {
    if (event.status === 'live') return true;
    
    const eventTime = event.startTime.getTime();
    
    // Show scheduled games for today only
    if (event.status === 'scheduled') {
      return eventTime >= todayStart.getTime() && eventTime <= todayEnd.getTime();
    }
    
    // Show finished games from the last 6 hours
    if (event.status === 'finished') {
      return eventTime >= sixHoursAgo.getTime();
    }
    
    return false;
  });

  // Sort: live games first, then by start time
  return filteredEvents.sort((a, b) => {
    // Live games first
    if (a.status === 'live' && b.status !== 'live') return -1;
    if (b.status === 'live' && a.status !== 'live') return 1;
    // Then by start time
    return a.startTime.getTime() - b.startTime.getTime();
  });
}

export async function getEventsForDate(date: Date): Promise<SportsEvent[]> {
  return getLiveScores();
}

export async function getUpcomingEvents(days: number = 7, leagues?: string[]): Promise<SportsEvent[]> {
  const allEvents: SportsEvent[] = [];
  
  const majorSports = leagues || [
    'nfl',
    'college-football',
    'nba',
    'mens-college-basketball',
    'mlb',
    'nhl',
    'soccer-eng.1',
    'soccer-esp.1',
    'soccer-ger.1',
    'soccer-ita.1',
    'soccer-uefa.champions',
    'soccer-usa.1',
    'ufc',
    'f1',
  ];
  
  const now = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  
  // Format dates for ESPN API: YYYYMMDD-YYYYMMDD
  const formatDate = (date: Date) => {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  };
  
  const startDateStr = formatDate(now);
  const endDateStr = formatDate(endDate);
  const dateRange = `${startDateStr}-${endDateStr}`;
  
  for (const sportKey of majorSports) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;
    
    try {
      const url = `${ESPN_API_BASE}/${config.sport}/${config.league}/scoreboard?dates=${dateRange}`;
      const data = await fetchJson<{ events: ESPNEvent[] }>(url);
      
      if (data?.events) {
        const events = data.events.map(e => mapESPNEvent(e, sportKey));
        allEvents.push(...events);
      }
    } catch (err) {
      console.error('[ESPN API] Error fetching upcoming', sportKey, err);
    }
  }

  // Filter to only show scheduled games in the future within the specified range
  const endTime = endDate.getTime();
  
  return allEvents
    .filter(e => {
      if (e.status !== 'scheduled') return false;
      const eventTime = e.startTime.getTime();
      return eventTime >= now.getTime() && eventTime <= endTime;
    })
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

export async function searchTeams(query: string): Promise<SportsTeam[]> {
  const results: SportsTeam[] = [];
  const queryLower = query.toLowerCase();

  const sportsToSearch = ['nfl', 'nba', 'mlb', 'nhl'];
  
  for (const sportKey of sportsToSearch) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{
      sports?: Array<{
        leagues?: Array<{
          teams?: Array<{ team?: ESPTeam }>;
        }>;
      }>;
    }>(
      `${ESPN_API_BASE}/${config.sport}/${config.league}/teams`
    );

    if (data?.sports) {
      for (const sport of data.sports) {
        for (const league of sport.leagues || []) {
          for (const teamWrapper of league.teams || []) {
            const team = teamWrapper.team;
            if (team && (
              team.displayName?.toLowerCase().includes(queryLower) ||
              team.location?.toLowerCase().includes(queryLower) ||
              team.name?.toLowerCase().includes(queryLower) ||
              team.shortDisplayName?.toLowerCase().includes(queryLower) ||
              team.abbreviation?.toLowerCase() === queryLower
            )) {
              results.push({
                id: team.id,
                name: team.displayName,
                shortName: team.abbreviation,
                logo: team.logos?.[0]?.href,
                leagueId: sportKey,
              });
            }
          }
        }
      }
    }
  }

  console.log('[ESPN API] Team search results:', results.length, 'for', query);
  return results;
}

export async function getTeamById(id: string): Promise<SportsTeam | null> {
  const sportsToSearch = ['nfl', 'nba', 'mlb', 'nhl'];
  
  for (const sportKey of sportsToSearch) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ team: ESPTeam }>(
      `${ESPN_API_BASE}/${config.sport}/${config.league}/teams/${id}`
    );

    if (data?.team) {
      return {
        id: data.team.id,
        name: data.team.displayName,
        shortName: data.team.abbreviation,
        logo: data.team.logos?.[0]?.href,
        leagueId: sportKey,
      };
    }
  }

  return null;
}

export async function getTeamNextEvents(teamId: string): Promise<SportsEvent[]> {
  const sportsToSearch = ['nfl', 'nba', 'mlb', 'nhl'];
  
  for (const sportKey of sportsToSearch) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ team: ESPTeam }>(
      `${ESPN_API_BASE}/${config.sport}/${config.league}/teams/${teamId}`
    );

    if (data?.team?.nextEvent) {
      return data.team.nextEvent.map(e => mapESPNEvent(e, sportKey));
    }
  }

  return [];
}

export async function getTeamPastEvents(teamId: string, limit: number = 10): Promise<SportsEvent[]> {
  const sportsToSearch = ['nfl', 'nba', 'mlb', 'nhl'];
  
  for (const sportKey of sportsToSearch) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;

    const data = await fetchJson<{ events?: ESPNEvent[] }>(
      `${ESPN_API_BASE}/${config.sport}/${config.league}/teams/${teamId}/schedule`
    );

    if (data?.events) {
      const now = new Date();
      const pastEvents = data.events
        .filter(e => new Date(e.date) < now)
        .slice(-limit)
        .map(e => mapESPNEvent(e, sportKey));
      return pastEvents;
    }
  }

  return [];
}

export async function getTeamSchedule(teamId: string, leagueId: string): Promise<{ upcoming: SportsEvent[]; past: SportsEvent[] }> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return { upcoming: [], past: [] };

  const data = await fetchJson<{ events?: ESPNEvent[] }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/teams/${teamId}/schedule`
  );

  if (!data?.events) return { upcoming: [], past: [] };

  const now = new Date();
  const allEvents = data.events.map(e => mapESPNEvent(e, leagueId));
  
  const upcoming = allEvents.filter(e => e.startTime >= now);
  const past = allEvents.filter(e => e.startTime < now).reverse();

  return { upcoming, past };
}

export interface TeamRecord {
  overall: string;
  home: string;
  away: string;
  wins: number;
  losses: number;
  ties?: number;
  winPercent?: number;
  pointsFor?: number;
  pointsAgainst?: number;
  pointDifferential?: number;
  avgPointsFor?: number;
  avgPointsAgainst?: number;
}

export interface TeamAthlete {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  jersey?: string;
  position: string;
  positionAbbrev?: string;
  headshot?: string;
  height?: string;
  weight?: string;
  age?: number;
  experience?: string;
  college?: string;
}

export interface TeamDetails {
  id: string;
  name: string;
  shortName: string;
  location: string;
  abbreviation: string;
  color: string;
  alternateColor: string;
  logo?: string;
  record?: TeamRecord;
  standingSummary?: string;
  nextEvent?: SportsEvent;
  athletes: TeamAthlete[];
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
  }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/teams/${teamId}?enable=roster`
  );

  if (!data?.team) return null;

  const team = data.team;

  const record: TeamRecord | undefined = team.record?.items ? {
    overall: team.record.items.find(r => r.type === 'total')?.summary || '',
    home: team.record.items.find(r => r.type === 'home')?.summary || '',
    away: team.record.items.find(r => r.type === 'road')?.summary || '',
    wins: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'wins')?.value || 0,
    losses: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'losses')?.value || 0,
    ties: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'ties')?.value,
    winPercent: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'winPercent')?.value,
    pointsFor: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'pointsFor')?.value,
    pointsAgainst: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'pointsAgainst')?.value,
    pointDifferential: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'pointDifferential' || s.name === 'differential')?.value,
    avgPointsFor: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'avgPointsFor')?.value,
    avgPointsAgainst: team.record.items.find(r => r.type === 'total')?.stats?.find(s => s.name === 'avgPointsAgainst')?.value,
  } : undefined;

  const nextEvent = team.nextEvent?.[0] ? mapESPNEvent(team.nextEvent[0], leagueId) : undefined;

  const athletes: TeamAthlete[] = (team.athletes || []).map(a => ({
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
  }));

  return {
    id: team.id,
    name: team.displayName,
    shortName: team.shortDisplayName,
    location: team.location,
    abbreviation: team.abbreviation,
    color: team.color,
    alternateColor: team.alternateColor,
    logo: team.logos?.[0]?.href,
    record,
    standingSummary: team.standingSummary,
    nextEvent,
    athletes,
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
  }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/teams`
  );

  const teams: SportsTeam[] = [];

  if (data?.sports) {
    for (const sport of data.sports) {
      for (const league of sport.leagues || []) {
        for (const teamWrapper of league.teams || []) {
          const team = teamWrapper.team;
          if (team) {
            teams.push({
              id: team.id,
              name: team.displayName,
              shortName: team.abbreviation,
              logo: team.logos?.[0]?.href,
              leagueId: leagueId,
            });
          }
        }
      }
    }
  }

  console.log('[ESPN API] League teams:', teams.length, 'for', leagueId);
  return teams;
}

export interface StandingTeam {
  id: string;
  name: string;
  shortName?: string;
  logo?: string;
  wins: number;
  losses: number;
  ties?: number;
  winPercent: string;
  winPercentValue: number;
  gamesBehind?: string;
  streak?: string;
  division?: string;
  rank: number;
}

export interface StandingGroup {
  name: string;
  isConference: boolean;
  teams: StandingTeam[];
}

export async function getLeagueStandings(leagueId: string): Promise<StandingTeam[]> {
  const groups = await getLeagueStandingsGrouped(leagueId);
  // Flatten for backward compatibility
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
  }>(
    `https://site.web.api.espn.com/apis/v2/sports/${config.sport}/${config.league}/standings`
  );

  const groups: StandingGroup[] = [];

  if (data?.children) {
    for (const conference of data.children) {
      const entries = conference.standings?.entries || [];
      const teams: StandingTeam[] = [];
      
      for (const entry of entries) {
        const team = entry.team;
        const stats = entry.stats || [];
        
        const getStat = (name: string) => {
          const stat = stats.find(s => s.name === name);
          return stat?.value ?? 0;
        };
        
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
          rank: 0, // Will be set after sorting
        });
      }

      // Sort by win percentage within each group
      teams.sort((a, b) => b.winPercentValue - a.winPercentValue);
      
      // Assign ranks after sorting
      teams.forEach((team, idx) => {
        team.rank = idx + 1;
      });

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

// UFC Rankings by weight class
export interface UFCWeightClassRanking {
  weightClass: string;
  champion?: {
    id: string;
    name: string;
    record?: string;
    headshot?: string;
  };
  rankedFighters: Array<{
    rank: number;
    id: string;
    name: string;
    record?: string;
    headshot?: string;
  }>;
}

export async function getUFCRankings(): Promise<UFCWeightClassRanking[]> {
  const data = await fetchJson<{
    rankings?: Array<{
      name: string;
      displayName?: string;
      athletes?: Array<{
        athlete?: {
          id: string;
          displayName: string;
          headshot?: { href: string };
          record?: Array<{ summary: string }>;
        };
        rank?: number;
        champion?: boolean;
      }>;
    }>;
  }>(
    `${ESPN_API_BASE}/mma/ufc/rankings`
  );

  const rankings: UFCWeightClassRanking[] = [];

  if (data?.rankings) {
    for (const division of data.rankings) {
      // Skip "Pound for Pound" rankings, only include weight classes
      if (division.name.toLowerCase().includes('pound for pound')) continue;

      const weightClass: UFCWeightClassRanking = {
        weightClass: division.name,
        rankedFighters: [],
      };

      const athletes = division.athletes || [];
      for (const entry of athletes) {
        if (!entry.athlete) continue;

        const fighter = {
          id: entry.athlete.id,
          name: entry.athlete.displayName,
          record: entry.athlete.record?.[0]?.summary,
          headshot: entry.athlete.headshot?.href,
        };

        if (entry.champion) {
          weightClass.champion = fighter;
        } else if (entry.rank) {
          weightClass.rankedFighters.push({
            rank: entry.rank,
            ...fighter,
          });
        }
      }

      // Sort by rank
      weightClass.rankedFighters.sort((a, b) => a.rank - b.rank);
      rankings.push(weightClass);
    }
  }

  console.log('[ESPN API] UFC Rankings:', rankings.length, 'weight classes');
  return rankings;
}

export async function getLeagues(): Promise<SportsLeague[]> {
  return Object.entries(SPORT_CONFIG).map(([key, config]) => ({
    id: key,
    name: config.name,
    sport: config.sport,
  }));
}

export async function getLeaguesBySport(sport: string): Promise<SportsLeague[]> {
  const sportLower = sport.toLowerCase();
  
  const mapping: Record<string, string[]> = {
    'football': ['nfl', 'college-football'],
    'basketball': ['nba', 'mens-college-basketball', 'wnba'],
    'baseball': ['mlb'],
    'hockey': ['nhl'],
    'soccer': ['soccer-eng.1', 'soccer-esp.1', 'soccer-ger.1', 'soccer-ita.1', 'soccer-usa.1'],
    'american football': ['nfl', 'college-football'],
  };

  const keys = mapping[sportLower] || [];
  
  return keys.map(key => {
    const config = SPORT_CONFIG[key];
    return {
      id: key,
      name: config.name,
      sport: config.sport,
    };
  });
}

export async function getLeagueEvents(leagueId: string): Promise<SportsEvent[]> {
  return getScoreboard(leagueId);
}

export async function searchEvents(query: string): Promise<SportsEvent[]> {
  return [];
}

export function formatEventTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatEventDate(date: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return 'Tomorrow';
  }
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatEventDateTime(date: Date): string {
  return `${formatEventDate(date)} ${formatEventTime(date)}`;
}

export function isEventLive(event: SportsEvent): boolean {
  return event.status === 'live';
}

export function isEventUpcoming(event: SportsEvent): boolean {
  return event.status === 'scheduled' && event.startTime.getTime() > Date.now();
}

export function isEventFinished(event: SportsEvent): boolean {
  return event.status === 'finished';
}

export function getAvailableSports(): string[] {
  return ['Football', 'Basketball', 'Baseball', 'Hockey', 'Soccer', 'MMA', 'Golf', 'Tennis', 'Racing'];
}

export function getAvailableLeagues(): { id: string; name: string; sport: string; }[] {
  return Object.entries(SPORT_CONFIG).map(([key, config]) => ({
    id: key,
    name: config.name,
    sport: config.sport,
  }));
}

export function getAvailableCategories(): { id: string; name: string; leagues: string[] }[] {
  const categories: Record<string, string[]> = {};
  
  for (const [leagueId, config] of Object.entries(SPORT_CONFIG)) {
    if (!categories[config.category]) {
      categories[config.category] = [];
    }
    categories[config.category].push(leagueId);
  }
  
  const categoryNames: Record<string, string> = {
    football: 'Football',
    basketball: 'Basketball',
    baseball: 'Baseball',
    hockey: 'Hockey',
    soccer: 'Soccer',
    mma: 'MMA & Combat',
    golf: 'Golf',
    tennis: 'Tennis',
    racing: 'Racing',
  };
  
  return Object.entries(categories).map(([id, leagues]) => ({
    id,
    name: categoryNames[id] || id,
    leagues,
  }));
}

// ============================================================================
// GAME DETAIL / SUMMARY
// ============================================================================

export interface TeamStatistics {
  label: string;
  displayValue: string;
}

export interface PlayerStat {
  athleteId: string;
  name: string;
  headshot?: string;
  jersey?: string;
  stats: string[];
}

export interface PlayerStatCategory {
  name: string;
  text: string;
  labels: string[];
  descriptions?: string[];
  athletes: PlayerStat[];
}

export interface GameSummaryTeam {
  id: string;
  name: string;
  shortName: string;
  logo?: string;
  score: number;
  record?: string;
  statistics: TeamStatistics[];
  playerStats: PlayerStatCategory[];
}

export interface ScoringPlay {
  id: string;
  period: string;
  clock: string;
  text: string;
  homeScore: number;
  awayScore: number;
  scoringType?: string;
  teamId?: string;
}

export interface GameSummary {
  id: string;
  title: string;
  date: Date;
  status: SportsEvent['status'];
  statusDetail: string;
  venue?: {
    name: string;
    city?: string;
  };
  attendance?: number;
  officials?: string[];
  broadcasts?: string[];
  homeTeam: GameSummaryTeam;
  awayTeam: GameSummaryTeam;
  scoringPlays: ScoringPlay[];
  winProbability?: Array<{
    homeWinPercentage: number;
    playId: string;
  }>;
}

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
    // Soccer uses rosters instead of boxscore.players
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
    // NFL/NBA use plays for scoring
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
    // Soccer uses keyEvents for goals/cards/etc
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
  }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/summary?event=${eventId}`
  );

  if (!data?.header) return null;

  const competition = data.header.competitions?.[0];
  const homeCompetitor = competition?.competitors?.find(c => c.homeAway === 'home');
  const awayCompetitor = competition?.competitors?.find(c => c.homeAway === 'away');

  const state = competition?.status?.type?.state || 'pre';
  let status: SportsEvent['status'] = 'scheduled';
  if (state === 'in') status = 'live';
  else if (state === 'post') status = 'finished';

  // Get team statistics from boxscore
  const getTeamStats = (teamId: string): TeamStatistics[] => {
    const team = data.boxscore?.teams?.find(t => t.team.id === teamId);
    return team?.statistics?.map(s => ({
      label: s.label,
      displayValue: s.displayValue,
    })) || [];
  };

  // Get player statistics (NFL/NBA style)
  const getPlayerStats = (teamId: string): PlayerStatCategory[] => {
    // Try boxscore.players first (NFL/NBA/MLB/NHL)
    const teamPlayers = data.boxscore?.players?.find(p => p.team.id === teamId);
    if (teamPlayers?.statistics) {
      return teamPlayers.statistics.map(stat => ({
        name: stat.name,
        text: stat.text,
        labels: stat.labels,
        descriptions: stat.descriptions,
        athletes: stat.athletes.map(a => ({
          athleteId: a.athlete.id,
          name: a.athlete.displayName,
          headshot: a.athlete.headshot?.href,
          jersey: a.athlete.jersey,
          stats: a.stats,
        })),
      }));
    }

    // Try rosters for soccer
    const teamRoster = data.rosters?.find(r => r.team.id === teamId);
    if (teamRoster?.roster && teamRoster.roster.length > 0) {
      // Group by position for soccer
      const positionGroups: Record<string, typeof teamRoster.roster> = {};
      for (const player of teamRoster.roster) {
        const pos = player.position?.displayName || 'Unknown';
        if (!positionGroups[pos]) positionGroups[pos] = [];
        positionGroups[pos].push(player);
      }

      // Create a single category for the roster
      const athletes = teamRoster.roster
        .filter(p => p.athlete)
        .map(p => ({
          athleteId: p.athlete.id,
          name: p.athlete.displayName,
          headshot: p.athlete.headshot?.href,
          jersey: (p as any).jersey,
          stats: p.stats?.map(s => String(s.displayValue || s.value)) || [],
        }));

      if (athletes.length > 0) {
        return [{
          name: 'roster',
          text: 'Starting Lineup',
          labels: ['Pos', 'Jersey', 'Name'],
          athletes: athletes.slice(0, 11), // Show starting 11
        }];
      }
    }

    return [];
  };

  // Get scoring plays
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
        const period = e.period?.displayValue || '';
        const clock = e.clock?.displayValue || '';
        
        // Extract score from text like "Goal! Wolverhampton Wanderers 0, Arsenal 1."
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
          period: period || `Half`,
          clock: clock,
          text: e.text || e.shortText || 'Goal',
          homeScore,
          awayScore,
          scoringType: e.type?.text || 'Goal',
          teamId: e.team?.id,
        });
      }
    }
  }

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
    homeTeam: {
      id: homeCompetitor?.team?.id || '',
      name: homeCompetitor?.team?.displayName || 'Home',
      shortName: homeCompetitor?.team?.abbreviation || '',
      logo: homeCompetitor?.team?.logos?.[0]?.href,
      score: parseInt(homeCompetitor?.score || '0', 10),
      record: homeCompetitor?.record?.[0]?.summary || homeCompetitor?.records?.[0]?.summary,
      statistics: getTeamStats(homeCompetitor?.team?.id || ''),
      playerStats: getPlayerStats(homeCompetitor?.team?.id || ''),
    },
    awayTeam: {
      id: awayCompetitor?.team?.id || '',
      name: awayCompetitor?.team?.displayName || 'Away',
      shortName: awayCompetitor?.team?.abbreviation || '',
      logo: awayCompetitor?.team?.logos?.[0]?.href,
      score: parseInt(awayCompetitor?.score || '0', 10),
      record: awayCompetitor?.record?.[0]?.summary || awayCompetitor?.records?.[0]?.summary,
      statistics: getTeamStats(awayCompetitor?.team?.id || ''),
      playerStats: getPlayerStats(awayCompetitor?.team?.id || ''),
    },
    scoringPlays,
    winProbability: data.winprobability,
  };
}

// ============================================================================
// PLAY-BY-PLAY
// ============================================================================

export interface PlayByPlay {
  teams: { home: string; away: string };
  periods: PlayPeriod[];
}

export interface PlayPeriod {
  period: number;
  label: string;
  plays: Play[];
}

export interface Play {
  id: string;
  type: string;
  text: string;
  awayScore: number;
  homeScore: number;
  clock: string;
  teamId?: string;
  scoringPlay?: boolean;
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
    drives?: {
      current: {
        teams: Array<{ id: string }>;
      };
    };
    competitions?: Array<{
      competitors: Array<{
        homeAway: string;
        team: { id: string };
      }>;
    }>;
  }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/playbyplay?event=${eventId}`
  );

  if (!data) return null;

  // Extract team IDs
  const competition = data.header?.competitions?.[0] || data.competitions?.[0];
  const homeTeam = competition?.competitors?.find(c => c.homeAway === 'home')?.team?.id || '';
  const awayTeam = competition?.competitors?.find(c => c.homeAway === 'away')?.team?.id || '';

  // For now, return basic structure - full play-by-play parsing is complex per sport
  return {
    teams: { home: homeTeam, away: awayTeam },
    periods: [],
  };
}

// ============================================================================
// NEWS
// ============================================================================

export interface NewsArticle {
  id: string;
  title: string;
  description: string;
  link: string;
  image?: string;
  source?: string;
  published?: Date;
  type: string;
  leagueId: string;
}

export async function getLeagueNews(leagueId: string, limit: number = 20): Promise<NewsArticle[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    articles?: Array<{
      id: string;
      headline: string;
      description: string;
      links?: { web: { href: string } };
      images?: Array<{ url: string }>;
      source?: string;
      published?: string;
      type: string;
    }>;
  }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/news?limit=${limit}`
  );

  if (!data?.articles) return [];

  return data.articles.map(article => ({
    id: article.id,
    title: article.headline,
    description: article.description,
    link: article.links?.web?.href || '',
    image: article.images?.[0]?.url,
    source: article.source,
    published: article.published ? new Date(article.published) : undefined,
    type: article.type,
    leagueId,
  }));
}

// ============================================================================
// RANKINGS (College Sports)
// ============================================================================

export interface Ranking {
  rank: number;
  team: {
    id: string;
    name: string;
    shortName: string;
    logo?: string;
  };
  record: string;
  points?: number;
  previousRank?: number;
  firstPlaceVotes?: number;
  trend: 'up' | 'down' | 'same' | 'new';
}

export interface RankingsList {
  id: string;
  name: string;
  shortName: string;
  type: string;
  headline: string;
  week: string;
  year: number;
  rankings: Ranking[];
}

export async function getLeagueRankings(leagueId: string): Promise<RankingsList[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    rankings?: Array<{
      id: string;
      name: string;
      shortName: string;
      type: string;
      headline: string;
      shortHeadline: string;
      occurrence?: {
        number: number;
        type: string;
        value: string;
        displayValue: string;
      };
      date: string;
      season?: {
        year: number;
        displayName: string;
      };
      ranks: Array<{
        current: number;
        previous?: number;
        points?: number;
        firstPlaceVotes?: number;
        trend?: string;
        record?: string;
        team: {
          id: string;
          displayName: string;
          name: string;
          nickname: string;
          abbreviation: string;
          logos?: Array<{ href: string }>;
        };
      }>;
    }>;
  }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/rankings`
  );

  if (!data?.rankings) return [];

  return data.rankings.map(list => ({
    id: list.id,
    name: list.name,
    shortName: list.shortName || list.name,
    type: list.type,
    headline: list.shortHeadline || list.headline,
    week: list.occurrence?.displayValue || list.occurrence?.value || 'Final',
    year: list.season?.year || new Date().getFullYear(),
    rankings: (list.ranks || []).map(rank => ({
      rank: rank.current,
      team: {
        id: rank.team.id,
        name: rank.team.displayName || `${rank.team.nickname} ${rank.team.name}`,
        shortName: rank.team.abbreviation,
        logo: rank.team.logos?.[0]?.href,
      },
      record: rank.record || '',
      points: rank.points,
      previousRank: rank.previous,
      firstPlaceVotes: rank.firstPlaceVotes,
      trend: rank.previous === undefined ? 'new' :
             rank.trend === '-' ? 'same' :
             rank.current < rank.previous ? 'up' : 'down',
    })),
  }));
}

// ============================================================================
// LEAGUE LEADERS
// ============================================================================

export interface LeagueLeader {
  rank: number;
  athlete: {
    id: string;
    name: string;
    headshot?: string;
    position?: string;
  };
  team: {
    id: string;
    name: string;
    shortName: string;
    logo?: string;
  };
  stat: string;
  value: string;
  displayValue: string;
}

export interface LeadersCategory {
  name: string;
  displayName: string;
  shortDisplayName?: string;
  abbreviation: string;
  leaders: LeagueLeader[];
}

export async function getLeagueLeaders(leagueId: string): Promise<LeadersCategory[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    leaders?: {
      categories?: Array<{
        name: string;
        displayName: string;
        shortDisplayName?: string;
        abbreviation: string;
        leaders: Array<{
          displayValue: string;
          value: number;
          athlete?: {
            id: string;
            displayName: string;
            headshot?: { href: string };
            position?: { displayName: string; abbreviation: string };
          };
          team?: {
            id: string;
            displayName: string;
            abbreviation: string;
            logos?: Array<{ href: string }>;
          };
        }>;
      }>;
    };
  }>(
    `https://site.api.espn.com/apis/site/v3/sports/${config.sport}/${config.league}/leaders`
  );

  if (!data?.leaders?.categories) return [];

  return data.leaders.categories.map(category => ({
    name: category.name,
    displayName: category.displayName,
    shortDisplayName: category.shortDisplayName,
    abbreviation: category.abbreviation,
    leaders: (category.leaders || []).slice(0, 10).map((leader, idx) => ({
      rank: idx + 1,
      athlete: {
        id: leader.athlete?.id || '',
        name: leader.athlete?.displayName || '',
        headshot: leader.athlete?.headshot?.href,
        position: leader.athlete?.position?.abbreviation,
      },
      team: {
        id: leader.team?.id || '',
        name: leader.team?.displayName || '',
        shortName: leader.team?.abbreviation || '',
        logo: leader.team?.logos?.[0]?.href,
      },
      stat: category.displayName,
      value: leader.displayValue || String(leader.value),
      displayValue: leader.displayValue || String(leader.value),
    })),
  }));
}

// ============================================================================
// SCOREBOARD BY DATE
// ============================================================================

export async function getScoreboardByDate(leagueId: string, date: Date): Promise<SportsEvent[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');

  const data = await fetchJson<{ events: ESPNEvent[] }>(
    `${ESPN_API_BASE}/${config.sport}/${config.league}/scoreboard?dates=${dateStr}`
  );

  if (!data?.events) return [];

  return data.events.map(e => mapESPNEvent(e, leagueId));
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function getLeaguesByCategory(category: string): { id: string; name: string; sport: string; }[] {
  return Object.entries(SPORT_CONFIG)
    .filter(([_, config]) => config.category === category)
    .map(([key, config]) => ({
      id: key,
      name: config.name,
      sport: config.sport,
    }));
}

export function getLeagueConfig(leagueId: string): { sport: string; league: string; name: string; category: string; } | undefined {
  return SPORT_CONFIG[leagueId];
}
