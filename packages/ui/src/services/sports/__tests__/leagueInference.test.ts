import { describe, it, expect } from 'vitest';
import { inferTeamLeague, inferLeagueFromTeamName, inferLeagueFromLogoUrl } from '../leagueInference';
import { eventInvolvesTeam } from '../../../components/sports/favoritesMatch';
import { matchesFavorite, useSportsFavoritesStore } from '../../../stores/sportsFavoritesStore';
import { getFavKey } from '../../../components/sports/FavoritesTab';
import type { SportsEvent } from '@ynotv/core';

describe('League Inference & Cross-League Isolation', () => {
  describe('inferLeagueFromTeamName', () => {
    it('correctly infers NBA teams', () => {
      expect(inferLeagueFromTeamName('Denver Nuggets')).toBe('nba');
      expect(inferLeagueFromTeamName('Los Angeles Lakers')).toBe('nba');
      expect(inferLeagueFromTeamName('Boston Celtics')).toBe('nba');
      expect(inferLeagueFromTeamName('Golden State Warriors')).toBe('nba');
      expect(inferLeagueFromTeamName('Utah Jazz')).toBe('nba');
    });

    it('correctly infers NFL teams', () => {
      expect(inferLeagueFromTeamName('Denver Broncos')).toBe('nfl');
      expect(inferLeagueFromTeamName('Kansas City Chiefs')).toBe('nfl');
      expect(inferLeagueFromTeamName('Indianapolis Colts')).toBe('nfl');
      expect(inferLeagueFromTeamName('New England Patriots')).toBe('nfl');
      expect(inferLeagueFromTeamName('Baltimore Ravens')).toBe('nfl');
    });

    it('correctly infers MLB teams', () => {
      expect(inferLeagueFromTeamName('New York Yankees')).toBe('mlb');
      expect(inferLeagueFromTeamName('Boston Red Sox')).toBe('mlb');
      expect(inferLeagueFromTeamName('Kansas City Royals')).toBe('mlb');
      expect(inferLeagueFromTeamName('Houston Astros')).toBe('mlb');
    });

    it('correctly infers NHL teams', () => {
      expect(inferLeagueFromTeamName('Buffalo Sabres')).toBe('nhl');
      expect(inferLeagueFromTeamName('Montreal Canadiens')).toBe('nhl');
      expect(inferLeagueFromTeamName('Toronto Maple Leafs')).toBe('nhl');
      expect(inferLeagueFromTeamName('Colorado Avalanche')).toBe('nhl');
    });

    it('disambiguates city/team collisions', () => {
      expect(inferLeagueFromTeamName('Arizona Cardinals')).toBe('nfl');
      expect(inferLeagueFromTeamName('St. Louis Cardinals')).toBe('mlb');
      expect(inferLeagueFromTeamName('New York Giants')).toBe('nfl');
      expect(inferLeagueFromTeamName('San Francisco Giants')).toBe('mlb');
      expect(inferLeagueFromTeamName('Sacramento Kings')).toBe('nba');
      expect(inferLeagueFromTeamName('Los Angeles Kings')).toBe('nhl');
      expect(inferLeagueFromTeamName('New York Jets')).toBe('nfl');
      expect(inferLeagueFromTeamName('Winnipeg Jets')).toBe('nhl');
    });

    it('correctly isolates cross-sport identities with shared substrings', () => {
      expect(inferLeagueFromTeamName('Detroit Red Wings')).toBe('nhl');
      expect(inferLeagueFromTeamName('Dallas Wings')).toBe('wnba');
      expect(inferLeagueFromTeamName('Brisbane Lions')).toBe('afl');
      expect(inferLeagueFromTeamName('Detroit Lions')).toBe('nfl');
      expect(inferLeagueFromTeamName('West Coast Eagles')).toBe('afl');
      expect(inferLeagueFromTeamName('Philadelphia Eagles')).toBe('nfl');
      expect(inferLeagueFromTeamName('Tottenham Hotspur')).toBe('soccer-eng.1');
      expect(inferLeagueFromTeamName('San Antonio Spurs')).toBe('nba');
      expect(inferLeagueFromTeamName('Gold Coast Suns')).toBe('afl');
      expect(inferLeagueFromTeamName('Phoenix Suns')).toBe('nba');
    });

    it('fails closed and returns undefined for ambiguous generic nicknames without city context', () => {
      expect(inferLeagueFromTeamName('Kings')).toBeUndefined();
      expect(inferLeagueFromTeamName('Wings')).toBeUndefined();
      expect(inferLeagueFromTeamName('Lions')).toBeUndefined();
      expect(inferLeagueFromTeamName('Eagles')).toBeUndefined();
      expect(inferLeagueFromTeamName('Spurs')).toBeUndefined();
      expect(inferLeagueFromTeamName('Giants')).toBeUndefined();
      expect(inferLeagueFromTeamName('Panthers')).toBeUndefined();
      expect(inferLeagueFromTeamName('Cardinals')).toBeUndefined();
      expect(inferLeagueFromTeamName('Jets')).toBeUndefined();
      expect(inferLeagueFromTeamName('Rangers')).toBeUndefined();
    });
  });

  describe('inferLeagueFromLogoUrl', () => {
    it('infers from standard ESPN CDN paths', () => {
      expect(inferLeagueFromLogoUrl('https://a.espncdn.com/i/teamlogos/nba/500/7.png')).toBe('nba');
      expect(inferLeagueFromLogoUrl('https://a.espncdn.com/i/teamlogos/nfl/500/7.png')).toBe('nfl');
      expect(inferLeagueFromLogoUrl('https://a.espncdn.com/i/teamlogos/mlb/500/7.png')).toBe('mlb');
      expect(inferLeagueFromLogoUrl('https://a.espncdn.com/i/teamlogos/nhl/500/7.png')).toBe('nhl');
      expect(inferLeagueFromLogoUrl('https://a.espncdn.com/i/teamlogos/wnba/500/1.png')).toBe('wnba');
    });
  });

  describe('inferTeamLeague', () => {
    it('uses existing leagueId if valid', () => {
      expect(inferTeamLeague({ id: '7', name: 'Denver Broncos', leagueId: 'nfl' })).toBe('nfl');
      expect(inferTeamLeague({ id: '7', name: 'Denver Nuggets', leagueId: 'nba' })).toBe('nba');
    });

    it('infers from team name when leagueId is missing', () => {
      expect(inferTeamLeague({ id: '7', name: 'Denver Nuggets' })).toBe('nba');
      expect(inferTeamLeague({ id: '7', name: 'Denver Broncos' })).toBe('nfl');
    });

    it('infers from logo URL when name is missing or ambiguous', () => {
      expect(inferTeamLeague({ id: '7', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/7.png' })).toBe('nba');
    });
  });

  describe('matchesFavorite isolation for same-ID teams', () => {
    const nuggets = { id: '7', name: 'Denver Nuggets', leagueId: 'nba', addedAt: 1 };
    const broncos = { id: '7', name: 'Denver Broncos', leagueId: 'nfl', addedAt: 2 };
    const royals = { id: '7', name: 'Kansas City Royals', leagueId: 'mlb', addedAt: 3 };
    const sabres = { id: '7', name: 'Buffalo Sabres', leagueId: 'nhl', addedAt: 4 };

    it('prevents Denver Nuggets and Denver Broncos from matching despite having same ID 7', () => {
      expect(matchesFavorite(nuggets, '7', 'nba')).toBe(true);
      expect(matchesFavorite(nuggets, '7', 'nfl')).toBe(false);
      expect(matchesFavorite(nuggets, '7', 'mlb')).toBe(false);
      expect(matchesFavorite(nuggets, '7', 'nhl')).toBe(false);

      expect(matchesFavorite(broncos, '7', 'nfl')).toBe(true);
      expect(matchesFavorite(broncos, '7', 'nba')).toBe(false);
    });

    it('handles legacy favorite missing leagueId by inferring from name', () => {
      const legacyNuggets = { id: '7', name: 'Denver Nuggets', addedAt: 1 };
      expect(matchesFavorite(legacyNuggets, '7', 'nba')).toBe(true);
      expect(matchesFavorite(legacyNuggets, '7', 'nfl')).toBe(false);
    });

    it('allows both Denver Nuggets and Denver Broncos to be added as distinct favorites', () => {
      const store = useSportsFavoritesStore.getState();
      store.clearFavorites();

      store.addFavorite({ id: '7', name: 'Denver Nuggets', leagueId: 'nba' });
      store.addFavorite({ id: '7', name: 'Denver Broncos', leagueId: 'nfl' });

      const favorites = useSportsFavoritesStore.getState().favorites;
      expect(favorites).toHaveLength(2);
      expect(favorites.some(f => f.id === '7' && f.leagueId === 'nba')).toBe(true);
      expect(favorites.some(f => f.id === '7' && f.leagueId === 'nfl')).toBe(true);
    });
  });

  describe('eventInvolvesTeam cross-league matching protection', () => {
    const nflEvent: SportsEvent = {
      id: '401547417',
      title: 'Denver Broncos at Kansas City Chiefs',
      homeTeam: { id: '12', name: 'Kansas City Chiefs', leagueId: 'nfl' },
      awayTeam: { id: '7', name: 'Denver Broncos', leagueId: 'nfl' },
      league: { id: 'nfl', name: 'NFL', sport: 'football' },
      startTime: new Date('2026-09-14T23:15:00Z'),
      status: 'scheduled',
      channels: [],
    };

    const nbaEvent: SportsEvent = {
      id: '401584000',
      title: 'Utah Jazz at Denver Nuggets',
      homeTeam: { id: '7', name: 'Denver Nuggets', leagueId: 'nba' },
      awayTeam: { id: '26', name: 'Utah Jazz', leagueId: 'nba' },
      league: { id: 'nba', name: 'NBA', sport: 'basketball' },
      startTime: new Date('2026-10-04T23:00:00Z'),
      status: 'scheduled',
      channels: [],
    };

    it('does NOT match NFL Broncos game to NBA Nuggets favorite', () => {
      const nuggetsFav = { id: '7', name: 'Denver Nuggets', leagueId: 'nba' };
      expect(eventInvolvesTeam(nflEvent, nuggetsFav)).toBe(false);
    });

    it('matches NFL Broncos game to NFL Broncos favorite', () => {
      const broncosFav = { id: '7', name: 'Denver Broncos', leagueId: 'nfl' };
      expect(eventInvolvesTeam(nflEvent, broncosFav)).toBe(true);
    });

    it('does NOT match NBA Jazz game to NFL Broncos favorite', () => {
      const broncosFav = { id: '7', name: 'Denver Broncos', leagueId: 'nfl' };
      expect(eventInvolvesTeam(nbaEvent, broncosFav)).toBe(false);
    });

    it('matches NBA Jazz game to NBA Nuggets favorite', () => {
      const nuggetsFav = { id: '7', name: 'Denver Nuggets', leagueId: 'nba' };
      expect(eventInvolvesTeam(nbaEvent, nuggetsFav)).toBe(true);
    });

    it('infers league for legacy favorites without leagueId and rejects cross-league matches', () => {
      const legacyNuggets = { id: '7', name: 'Denver Nuggets' };
      expect(eventInvolvesTeam(nflEvent, legacyNuggets)).toBe(false);
      expect(eventInvolvesTeam(nbaEvent, legacyNuggets)).toBe(true);

      const legacyBroncos = { id: '7', name: 'Denver Broncos' };
      expect(eventInvolvesTeam(nflEvent, legacyBroncos)).toBe(true);
      expect(eventInvolvesTeam(nbaEvent, legacyBroncos)).toBe(false);
    });

    it('fails closed when an unresolvable legacy favorite is evaluated against events', () => {
      const unresolvableFavorite = { id: '7', name: 'Some Team Without Clear League' };
      expect(eventInvolvesTeam(nflEvent, unresolvableFavorite)).toBe(false);
      expect(eventInvolvesTeam(nbaEvent, unresolvableFavorite)).toBe(false);
    });
  });

  describe('getFavKey collision safety', () => {
    it('produces distinct keys for same-ID teams across different leagues', () => {
      const nbaNuggets = { id: '7', name: 'Denver Nuggets', leagueId: 'nba' };
      const nflBroncos = { id: '7', name: 'Denver Broncos', leagueId: 'nfl' };
      expect(getFavKey(nbaNuggets)).toBe('nba-7');
      expect(getFavKey(nflBroncos)).toBe('nfl-7');
      expect(getFavKey(nbaNuggets)).not.toBe(getFavKey(nflBroncos));
    });

    it('produces collision-safe keys for unresolved teams with the same ID', () => {
      const teamA = { id: '7', name: 'Ambiguous Team Alpha' };
      const teamB = { id: '7', name: 'Ambiguous Team Beta' };
      expect(getFavKey(teamA)).toBe('unknown-7-ambiguous-team-alpha');
      expect(getFavKey(teamB)).toBe('unknown-7-ambiguous-team-beta');
      expect(getFavKey(teamA)).not.toBe(getFavKey(teamB));
    });
  });

  describe('sportsFavoritesStore hooks stability', () => {
    it('provides stable selector values for repair state', () => {
      const state = useSportsFavoritesStore.getState();
      expect(typeof state.repairPromptDismissed).toBe('boolean');
      expect(typeof state.dismissRepairPrompt).toBe('function');
      expect(typeof state.showRepairPrompt).toBe('function');
    });
  });
});
