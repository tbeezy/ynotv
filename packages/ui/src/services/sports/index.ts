/**
 * Sports API Service
 *
 * Modular sports data fetching from ESPN's public API
 * 
 * @example
 * ```typescript
 * import { getLiveScores, getLeagueNews, getGameSummary } from './services/sports';
 * 
 * const scores = await getLiveScores();
 * const news = await getLeagueNews('nfl', 10);
 * const game = await getGameSummary('event-id', 'nfl');
 * ```
 */

// Types
export type {
  // Base types
  SportsEvent,
  SportsTeam,
  SportsLeague,
  SportsBroadcastChannel,
  
  // ESPN API types
  ESPNEvent,
  ESPTeam,
  ESPNLeague,
  SportConfig,
  
  // Team types
  TeamRecord,
  TeamAthlete,
  TeamDetails,
  
  // Standings types
  StandingTeam,
  StandingGroup,
  
  // UFC types
  UFCWeightClassRanking,
  
  // Game types
  TeamStatistics,
  PlayerStat,
  PlayerStatCategory,
  GameSummaryTeam,
  ScoringPlay,
  GameSummary,
  PlayByPlay,
  PlayPeriod,
  Play,
  
  // News types
  NewsArticle,
  
  // Rankings types
  Ranking,
  RankingsList,
  
  // Leaders types
  LeagueLeader,
  LeadersCategory,
  
  // Individual sports rankings
  GolfRanking,
  TennisRanking,
  RacingStanding,
} from './types';

// Configuration
export {
  ESPN_API_BASE,
  SPORT_CONFIG,
  DEFAULT_LIVE_LEAGUES,
  DEFAULT_UPCOMING_LEAGUES,
  CATEGORY_NAMES,
  LEADERS_LEAGUES,
} from './config';

// API Client
export {
  fetchJson,
  buildScoreboardUrl,
  buildDateRangeUrl,
  buildTeamsUrl,
  buildTeamUrl,
  buildTeamScheduleUrl,
  buildStandingsUrl,
  buildNewsUrl,
  buildRankingsUrl,
  buildLeadersUrl,
  buildGameSummaryUrl,
  buildPlayByPlayUrl,
  buildUFCRankingsUrl,
} from './client';

// Mappers
export {
  mapESPNEvent,
  mapESPNTeam,
  getSportConfig,
  getCategoryDisplayName,
} from './mappers';

// Scores API
export {
  getScoreboard,
  getLiveScores,
  getUpcomingEvents,
  getLeagueEvents,
  getEventsForDate,
  type ScoreboardFilters,
} from './scores';

// Teams API
export {
  searchTeams,
  getTeamById,
  getTeamNextEvents,
  getTeamPastEvents,
  getTeamSchedule,
  getTeamDetails,
  getLeagueTeams,
  getLeagueStandings,
  getLeagueStandingsGrouped,
} from './teams';

// Games API
export {
  getGameSummary,
  getPlayByPlay,
} from './games';

// News API
export {
  getLeagueNews,
} from './news';

// Rankings API
export {
  getLeagueRankings,
  getUFCRankings,
  getGolfRankings,
  getTennisRankings,
  getRacingStandings,
} from './rankings';

// Leaders API
export {
  getLeagueLeaders,
} from './leaders';

// Utils
export {
  formatEventTime,
  formatEventDate,
  formatEventDateTime,
  formatLastUpdated,
  formatRelativeDate,
  isEventLive,
  isEventUpcoming,
  isEventFinished,
  getAvailableSports,
  getAvailableLeagues,
  getAvailableCategories,
  getLeaguesByCategory,
  getLeaguesBySport,
} from './utils';
