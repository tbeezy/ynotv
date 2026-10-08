/**
 * Sports Configuration
 *
 * League and sport configuration constants
 */

import type { SportConfig } from './types';

export const ESPN_API_BASE = 'https://site.web.api.espn.com/apis/site/v2/sports';

export const SPORT_CONFIG: Record<string, SportConfig> = {
  // Football
  'nfl': { sport: 'football', league: 'nfl', name: 'NFL', category: 'football' },
  'cfl': { sport: 'football', league: 'cfl', name: 'CFL', category: 'football' },
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
  'soccer-fifa.world': { sport: 'soccer', league: 'fifa.world', name: 'FIFA World Cup', category: 'soccer' },
  'soccer-fifa.wwc': { sport: 'soccer', league: 'fifa.wwc', name: "FIFA Women's World Cup", category: 'soccer' },
  'soccer-eng.1': { sport: 'soccer', league: 'eng.1', name: 'Premier League', category: 'soccer' },
  'soccer-eng.2': { sport: 'soccer', league: 'eng.2', name: 'Championship', category: 'soccer' },
  'soccer-esp.1': { sport: 'soccer', league: 'esp.1', name: 'La Liga', category: 'soccer' },
  'soccer-ger.1': { sport: 'soccer', league: 'ger.1', name: 'Bundesliga', category: 'soccer' },
  'soccer-ita.1': { sport: 'soccer', league: 'ita.1', name: 'Serie A', category: 'soccer' },
  'soccer-fra.1': { sport: 'soccer', league: 'fra.1', name: 'Ligue 1', category: 'soccer' },
  'soccer-usa.1': { sport: 'soccer', league: 'usa.1', name: 'MLS', category: 'soccer' },
  'soccer-usa.nwsl': { sport: 'soccer', league: 'usa.nwsl', name: 'NWSL', category: 'soccer' },
  'soccer-usa.nwsl.cup': { sport: 'soccer', league: 'usa.nwsl.cup', name: 'NWSL Challenge Cup', category: 'soccer' },
  'soccer-uefa.champions': { sport: 'soccer', league: 'uefa.champions', name: 'Champions League', category: 'soccer' },
  'soccer-uefa.europa': { sport: 'soccer', league: 'uefa.europa', name: 'Europa League', category: 'soccer' },
  'soccer-uefa.europa.conf': { sport: 'soccer', league: 'uefa.europa.conf', name: 'Conference League', category: 'soccer' },
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

  // Rugby
  'rugby-180659': { sport: 'rugby', league: '180659', name: 'Six Nations', category: 'rugby' },
  'rugby-164205': { sport: 'rugby', league: '164205', name: 'Rugby World Cup', category: 'rugby' },
  'rugby-267979': { sport: 'rugby', league: '267979', name: 'Premiership', category: 'rugby' },
  'rugby-242041': { sport: 'rugby', league: '242041', name: 'Super Rugby', category: 'rugby' },
  'rugby-270559': { sport: 'rugby', league: '270559', name: 'Top 14', category: 'rugby' },

  // Rugby League
  'rugby-league-3': { sport: 'rugby-league', league: '3', name: 'NRL', category: 'rugby-league' },

  // Australian Football
  'afl': { sport: 'australian-football', league: 'afl', name: 'AFL', category: 'australian-football' },
};

export const DEFAULT_LIVE_LEAGUES = [
  'soccer-fifa.world',
  'soccer-fifa.wwc',
  'nfl',
  'college-football',
  'cfl',
  'nba',
  'mens-college-basketball',
  'mlb',
  'nhl',
  'soccer-eng.1',
  'soccer-uefa.champions',
  'soccer-usa.1',
  'soccer-usa.nwsl',
  'ufc',
  'rugby-180659',
  'rugby-league-3',
  'afl',
];

export const DEFAULT_UPCOMING_LEAGUES = [
  'soccer-fifa.world',
  'soccer-fifa.wwc',
  'nfl',
  'college-football',
  'cfl',
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
  'soccer-usa.nwsl',
  'ufc',
  'f1',
  'rugby-180659',
  'rugby-164205',
  'rugby-267979',
  'rugby-242041',
  'rugby-270559',
  'rugby-league-3',
  'afl',
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
  rugby: 'Rugby Union',
  'rugby-league': 'Rugby League',
  'australian-football': 'Australian Football',
};

export const LEADERS_LEAGUES = [
  { id: 'nfl', name: 'NFL' },
  { id: 'nba', name: 'NBA' },
  { id: 'mlb', name: 'MLB' },
  { id: 'nhl', name: 'NHL' },
];
