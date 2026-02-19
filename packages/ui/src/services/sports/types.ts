/**
 * Sports API Types
 *
 * Type definitions for ESPN API responses and domain models
 */

import type { SportsEvent, SportsTeam, SportsLeague, SportsBroadcastChannel } from '@ynotv/core';

export type { SportsEvent, SportsTeam, SportsLeague, SportsBroadcastChannel };

// ESPN API Response Types
export interface ESPNEvent {
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

export interface ESPTeam {
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

export interface ESPNLeague {
  id: string;
  uid: string;
  name: string;
  abbreviation: string;
  slug: string;
}

// Sport Configuration
export interface SportConfig {
  sport: string;
  league: string;
  name: string;
  category: string;
}

// Team Types
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

// Standings Types
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

// UFC Rankings
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

// Game Summary Types
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

// Play-by-Play Types
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

// News Types
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

// Rankings Types
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

// Leaders Types
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
  leaders: LeagueLeader[];
}

// Individual Sports Rankings Types

// Golf - World Golf Rankings
export interface GolfRanking {
  rank: number;
  athlete: {
    id: string;
    name: string;
    flag?: string;
  };
  totalPoints: number;
  numEvents: number;
  avgPoints: number;
}

// Tennis - ATP/WTA Rankings
export interface TennisRanking {
  rank: number;
  athlete: {
    id: string;
    name: string;
    flag?: string;
  };
  points: number;
  previousRank?: number;
}

// Racing - Driver Standings
export interface RacingStanding {
  rank: number;
  driver: {
    id: string;
    name: string;
    team: string;
    flag?: string;
    headshot?: string;
  };
  points: number;
  wins: number;
  podiums: number;
}
