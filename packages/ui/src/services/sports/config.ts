/**
 * Sports Configuration
 *
 * League and sport configuration constants
 */

import type { SportConfig } from './types';

export const ESPN_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

export const SPORT_CONFIG: Record<string, SportConfig> = {
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

export const DEFAULT_LIVE_LEAGUES = [
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

export const DEFAULT_UPCOMING_LEAGUES = [
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

export const CATEGORY_NAMES: Record<string, string> = {
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

export const LEADERS_LEAGUES = [
  { id: 'nfl', name: 'NFL' },
  { id: 'nba', name: 'NBA' },
  { id: 'mlb', name: 'MLB' },
  { id: 'nhl', name: 'NHL' },
];
