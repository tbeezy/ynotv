import { describe, it, expect, vi } from 'vitest';
import { SPORT_CONFIG, DEFAULT_LIVE_LEAGUES, DEFAULT_UPCOMING_LEAGUES, CATEGORY_NAMES } from '../config';
import { ALL_LEAGUES } from '../../../stores/sportsSettingsStore';
import { matchesFavorite } from '../../../stores/sportsFavoritesStore';
import { getCategoryDisplayName } from '../mappers';
import { getLeaguesBySport, getAvailableCategories } from '../utils';
import { buildScoreboardUrl, buildTeamsUrl, buildStandingsUrl } from '../client';
import * as client from '../client';
import { extractScoringPlays, extractPlayerStats } from '../games';
import { getTeamDetails, getTeamInjuries } from '../teams';

describe('AFL Sports Configuration', () => {
  it('has AFL configured in SPORT_CONFIG', () => {
    expect(SPORT_CONFIG['afl']).toBeDefined();
    expect(SPORT_CONFIG['afl']).toEqual({
      sport: 'australian-football',
      league: 'afl',
      name: 'AFL',
      category: 'australian-football',
    });
  });

  it('includes AFL in DEFAULT_LIVE_LEAGUES and DEFAULT_UPCOMING_LEAGUES', () => {
    expect(DEFAULT_LIVE_LEAGUES).toContain('afl');
    expect(DEFAULT_UPCOMING_LEAGUES).toContain('afl');
  });

  it('registers AFL in sportsSettingsStore ALL_LEAGUES', () => {
    const aflLeague = ALL_LEAGUES.find((l) => l.id === 'afl');
    expect(aflLeague).toBeDefined();
    expect(aflLeague?.name).toBe('AFL');
    expect(aflLeague?.sport).toBe('australian-football');
    expect(aflLeague?.category).toBe('australian-football');
  });

  it('provides Australian Football category name', () => {
    expect(CATEGORY_NAMES['australian-football']).toBe('Australian Football');
    expect(getCategoryDisplayName('australian-football')).toBe('Australian Football');
  });

  it('resolves AFL in getLeaguesBySport', async () => {
    const leaguesBySport = await getLeaguesBySport('australian football');
    expect(leaguesBySport.some((l) => l.id === 'afl')).toBe(true);

    const leaguesByAussie = await getLeaguesBySport('aussie rules');
    expect(leaguesByAussie.some((l) => l.id === 'afl')).toBe(true);

    const leaguesByAbbrev = await getLeaguesBySport('afl');
    expect(leaguesByAbbrev.some((l) => l.id === 'afl')).toBe(true);
  });

  it('includes australian-football in getAvailableCategories', () => {
    const categories = getAvailableCategories();
    const aflCat = categories.find((c) => c.id === 'australian-football');
    expect(aflCat).toBeDefined();
    expect(aflCat?.name).toBe('Australian Football');
    expect(aflCat?.leagues).toContain('afl');
  });

  it('builds valid ESPN endpoints for AFL', () => {
    const config = SPORT_CONFIG['afl'];
    expect(buildScoreboardUrl(config.sport, config.league)).toBe(
      'https://site.web.api.espn.com/apis/site/v2/sports/australian-football/afl/scoreboard'
    );
    expect(buildTeamsUrl(config.sport, config.league)).toBe(
      'https://site.web.api.espn.com/apis/site/v2/sports/australian-football/afl/teams'
    );
    expect(buildStandingsUrl(config.sport, config.league)).toBe(
      'https://site.web.api.espn.com/apis/v2/sports/australian-football/afl/standings'
    );
  });

  it('isolates favorites by leagueId so teams with identical numeric IDs do not collide', () => {
    const nflPatriots = { id: '17', name: 'New England Patriots', leagueId: 'nfl', addedAt: 1 };
    
    // AFL Collingwood also has id '17'
    expect(matchesFavorite(nflPatriots, '17', 'afl')).toBe(false);
    expect(matchesFavorite(nflPatriots, '17', 'nfl')).toBe(true);

    // Legacy favorites with identifiable names infer league and isolate correctly
    const legacyCollingwood = { id: '17', name: 'Collingwood Magpies', addedAt: 1 };
    expect(matchesFavorite(legacyCollingwood, '17', 'afl')).toBe(true);
    expect(matchesFavorite(legacyCollingwood, '17', 'nfl')).toBe(false);

    // Completely unresolvable favorites fail closed to prevent cross-league collision
    const unresolvableFav = { id: '17', name: 'Some Unknown Team', addedAt: 1 };
    expect(matchesFavorite(unresolvableFav, '17', 'afl')).toBe(false);
  });

  it('extracts AFL scoring plays including Goals, Behinds, and Rushed behinds', () => {
    const mockAflData = {
      plays: [
        {
          id: '6298379',
          type: { id: '21', text: 'Goal', type: 'goal' },
          text: 'D. McStay Goal',
          awayScore: 6,
          homeScore: 0,
          period: { number: 1 },
          clock: { displayValue: '3:12' },
          team: { id: '17' },
        },
        {
          id: '6298398',
          type: { id: '13', text: 'Behind', type: 'behind' },
          text: 'J. Dolan Behind',
          awayScore: 6,
          homeScore: 1,
          period: { number: 1 },
          clock: { displayValue: '6:02' },
          team: { id: '6' },
        },
        {
          id: '6298951',
          type: { id: '57', text: 'Rushed', type: 'rushed' },
          text: 'Rushed',
          awayScore: 26,
          homeScore: 33,
          period: { number: 2 },
          clock: { displayValue: '13:18' },
          team: { id: '17' },
        },
      ],
    };

    const plays = extractScoringPlays(mockAflData, '6');
    expect(plays).toHaveLength(3);

    // Goal
    expect(plays[0]).toEqual({
      id: '6298379',
      period: 'Q1',
      clock: '3:12',
      text: 'D. McStay Goal',
      homeScore: 0,
      awayScore: 6,
      scoringType: 'Goal',
      teamId: '17',
    });

    // Behind
    expect(plays[1]).toEqual({
      id: '6298398',
      period: 'Q1',
      clock: '6:02',
      text: 'J. Dolan Behind',
      homeScore: 1,
      awayScore: 6,
      scoringType: 'Behind',
      teamId: '6',
    });

    // Rushed behind
    expect(plays[2]).toEqual({
      id: '6298951',
      period: 'Q2',
      clock: '13:18',
      text: 'Rushed Behind',
      homeScore: 33,
      awayScore: 26,
      scoringType: 'Behind',
      teamId: '17',
    });
  });

  it('extracts AFL player statistics with default fallback category title', () => {
    const mockBoxscore = {
      players: [
        {
          team: { id: '6' },
          statistics: [
            {
              labels: ['D', 'G', 'B', 'T'],
              descriptions: ['Disposals', 'Goals', 'Behinds', 'Tackles'],
              athletes: [
                {
                  athlete: { id: '84', displayName: 'Marcus Bontempelli' },
                  stats: ['32', '1', '2', '0'],
                },
              ],
            },
          ],
        },
      ],
    };

    const stats = extractPlayerStats('6', mockBoxscore);
    expect(stats).toHaveLength(1);
    expect(stats[0].name).toBe('playerStats');
    expect(stats[0].text).toBe('Player Stats');
    expect(stats[0].labels).toEqual(['D', 'G', 'B', 'T']);
    expect(stats[0].descriptions).toEqual(['Disposals', 'Goals', 'Behinds', 'Tackles']);
    expect(stats[0].athletes).toHaveLength(1);
    expect(stats[0].athletes[0].name).toBe('Marcus Bontempelli');
    expect(stats[0].athletes[0].stats).toEqual(['32', '1', '2', '0']);
  });

  it('deduplicates AFL team roster athletes in getTeamDetails', async () => {
    const fetchSpy = vi.spyOn(client, 'fetchJson').mockResolvedValueOnce({
      team: {
        id: '17',
        displayName: 'Collingwood',
        athletes: [
          { id: '414', displayName: 'Taylor Adams', jersey: '3', position: { displayName: 'INT' } },
          { id: '414', displayName: 'Taylor Adams', jersey: '3', position: { displayName: 'INT' } },
          { id: '8', displayName: 'Trent Bianco', jersey: '8', position: { displayName: 'INT' } },
          { id: '8', displayName: 'Trent Bianco', jersey: '8', position: { displayName: 'INT' } },
          { id: '18', displayName: 'Mason Cox', jersey: '18', position: { displayName: 'INT' } },
        ],
      },
    });

    const details = await getTeamDetails('17', 'afl');
    expect(details).toBeDefined();
    expect(details?.athletes).toHaveLength(3);
    expect(details?.athletes.map(a => a.id)).toEqual(['414', '8', '18']);

    fetchSpy.mockRestore();
  });

  it('deduplicates AFL team injuries in getTeamInjuries', async () => {
    const fetchSpy = vi.spyOn(client, 'fetchJson').mockResolvedValueOnce({
      team: {
        athletes: [
          {
            id: '414',
            displayName: 'Taylor Adams',
            injuries: [{ id: 'inj-1', status: 'Questionable', comment: 'Hamstring' }],
          },
          {
            id: '414',
            displayName: 'Taylor Adams',
            injuries: [{ id: 'inj-1', status: 'Questionable', comment: 'Hamstring' }],
          },
          {
            id: '18',
            displayName: 'Mason Cox',
            injuries: [{ id: 'inj-2', status: 'Out', comment: 'Knee' }],
          },
        ],
      },
    });

    const injuries = await getTeamInjuries('17', 'afl');
    expect(injuries).toHaveLength(2);
    expect(injuries[0].athleteName).toBe('Taylor Adams');
    expect(injuries[1].athleteName).toBe('Mason Cox');

    fetchSpy.mockRestore();
  });
});

describe('CFL Sports Configuration', () => {
  it('has CFL configured in SPORT_CONFIG under football', () => {
    expect(SPORT_CONFIG['cfl']).toEqual({
      sport: 'football',
      league: 'cfl',
      name: 'CFL',
      category: 'football',
    });
  });

  it('includes CFL in DEFAULT_LIVE_LEAGUES and DEFAULT_UPCOMING_LEAGUES', () => {
    expect(DEFAULT_LIVE_LEAGUES).toContain('cfl');
    expect(DEFAULT_UPCOMING_LEAGUES).toContain('cfl');
  });

  it('registers CFL in sportsSettingsStore ALL_LEAGUES', () => {
    const cflLeague = ALL_LEAGUES.find((l) => l.id === 'cfl');
    expect(cflLeague).toBeDefined();
    expect(cflLeague?.name).toBe('CFL');
    expect(cflLeague?.sport).toBe('football');
    expect(cflLeague?.category).toBe('football');
  });

  it('lists CFL in the Football section of available categories', () => {
    const football = getAvailableCategories().find((c) => c.id === 'football');
    expect(football).toBeDefined();
    expect(football?.leagues).toContain('nfl');
    expect(football?.leagues).toContain('cfl');
  });

  it('resolves CFL in getLeaguesBySport', async () => {
    const leaguesByFootball = await getLeaguesBySport('football');
    expect(leaguesByFootball.some((l) => l.id === 'cfl')).toBe(true);

    const leaguesByAmerican = await getLeaguesBySport('american football');
    expect(leaguesByAmerican.some((l) => l.id === 'cfl')).toBe(true);

    const leaguesByCanadian = await getLeaguesBySport('canadian football');
    expect(leaguesByCanadian.map((l) => l.id)).toEqual(['cfl']);

    const leaguesByAbbrev = await getLeaguesBySport('cfl');
    expect(leaguesByAbbrev.map((l) => l.id)).toEqual(['cfl']);
  });

  it('builds valid ESPN endpoints for CFL', () => {
    const config = SPORT_CONFIG['cfl'];
    expect(buildScoreboardUrl(config.sport, config.league)).toBe(
      'https://site.web.api.espn.com/apis/site/v2/sports/football/cfl/scoreboard'
    );
    expect(buildTeamsUrl(config.sport, config.league)).toBe(
      'https://site.web.api.espn.com/apis/site/v2/sports/football/cfl/teams'
    );
    expect(buildStandingsUrl(config.sport, config.league)).toBe(
      'https://site.web.api.espn.com/apis/v2/sports/football/cfl/standings'
    );
  });
});

