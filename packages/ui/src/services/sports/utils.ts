import { formatTime, formatDate } from '../../utils/dateTime';
import i18n from '../../i18n';
import type { SportsEvent } from '@ynotv/core';

/**
 * Sports Utils
 *
 * Formatting and utility functions for sports data
 */

export function formatEventTime(date: Date, hour12: boolean = true): string {
  return formatTime(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}

export function formatEventDate(date: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) {
    return i18n.t('time:today');
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return i18n.t('time:tomorrow');
  }
  return formatDate(date, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatEventDateTime(date: Date, hour12: boolean = true): string {
  return `${formatEventDate(date)} ${formatEventTime(date, hour12)}`;
}

export function formatLastUpdated(date: Date | null, hour12: boolean = true): string {
  if (!date) return '';
  
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  
  if (seconds < 10) return i18n.t('time:justNow');
  if (seconds < 60) return i18n.t('time:secAgo', { count: seconds });
  if (minutes < 60) return i18n.t('time:mAgo', { count: minutes });
  
  return formatTime(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}

export function formatRelativeDate(date?: Date): string {
  if (!date) return '';
  
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  
  if (hours < 1) return i18n.t('time:justNow');
  if (hours < 24) return i18n.t('time:hAgo', { count: hours });
  if (days < 7) return i18n.t('time:dAgo', { count: days });
  return formatDate(date);
}

// Status helpers
export function isEventLive<T extends { status: string }>(event: T): boolean {
  return event.status === 'live';
}

export function isEventLiveOrPastStart<T extends { status: string; startTime?: Date | string }>(event: T): boolean {
  if (event.status === 'live') return true;
  if (event.status === 'scheduled' && event.startTime) {
    const startTime = event.startTime instanceof Date ? event.startTime : new Date(event.startTime);
    return startTime.getTime() <= Date.now();
  }
  return false;
}

export function isEventUpcoming<T extends { status: string; startTime: Date }>(event: T): boolean {
  return event.status === 'scheduled' && event.startTime.getTime() > Date.now();
}

export function isEventFinished<T extends { status: string }>(event: T): boolean {
  return event.status === 'finished';
}

// Status display text (period/quarter/inning + elapsed time) for the score overlays
export function getStatusDisplay(event: SportsEvent): string {
  if (event.status === 'scheduled' && isEventLiveOrPastStart(event)) {
    return event.timeElapsed || i18n.t('sports:statusLive');
  }
  if (event.status !== 'live') return '';
  const sport = event.league.sport.toLowerCase();
  const period = event.period ? parseInt(event.period, 10) : 0;

  switch (sport) {
    case 'football':
    case 'basketball':
      return `Q${event.period || '-'}${event.timeElapsed ? ' ' + event.timeElapsed : ''}`;
    case 'baseball': {
      const inningLabel = period > 9 ? `${period}th` :
        period === 1 ? '1st' :
          period === 2 ? '2nd' :
            period === 3 ? '3rd' :
              period ? `${period}th` : '';
      return `${inningLabel || '-'}${event.timeElapsed ? ' ' + event.timeElapsed : ''}`;
    }
    case 'hockey': {
      const periodLabel = period <= 3 ? `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : period === 3 ? 'rd' : 'th'}` :
        period === 4 ? 'OT' :
          period === 5 ? 'SO' : `${period - 3}OT`;
      return `${periodLabel || '-'}${event.timeElapsed ? ' ' + event.timeElapsed : ''}`;
    }
    case 'soccer':
    default:
      return event.timeElapsed || i18n.t('sports:statusLive');
  }
}

// Change detection — identical content in a new array should not trigger a re-render.
// Used by the score overlays so a no-op poll doesn't flash/remount the whole widget.
export function eventSignature(event: SportsEvent): string {
  return [
    event.id,
    event.status,
    event.homeScore ?? '',
    event.awayScore ?? '',
    event.period ?? '',
    event.timeElapsed ?? '',
    event.league?.name ?? '',
    event.homeTeam?.shortName || event.homeTeam?.name || '',
    event.awayTeam?.shortName || event.awayTeam?.name || '',
    event.startTime ? new Date(event.startTime).getTime() : '',
  ].join('|');
}

export function sameEvents(a: SportsEvent[], b: SportsEvent[]): boolean {
  if (a.length !== b.length) return false;
  const sigA = new Map(a.map((e) => [e.id, eventSignature(e)] as const));
  const sigB = new Map(b.map((e) => [e.id, eventSignature(e)] as const));
  if (sigA.size !== sigB.size) return false;
  for (const [id, sig] of sigA) {
    if (sigB.get(id) !== sig) return false;
  }
  return true;
}

// League/Sport helpers
export function getAvailableSports(): string[] {
  return ['Football', 'Basketball', 'Baseball', 'Hockey', 'Soccer', 'MMA', 'Golf', 'Tennis', 'Racing', 'Rugby Union', 'Rugby League'];
}

import { SPORT_CONFIG } from './config';
import { fetchJson, buildCoreLeagueUrl } from './client';
import type { SportsLeague, CoreLeagueResponse } from './types';

/**
 * Fetch official league logos from ESPN's core API.
 *
 * Each league object exposes a `logos` array with a full-color "default"
 * variant and a white "dark" variant (for dark backgrounds). The app is
 * dark-themed, so we prefer the dark variant and fall back to the first logo.
 *
 * @returns a map of leagueId -> logo href for every league that has one
 */
export const LEAGUE_LOGOS_CACHE_KEY = 'sports_league_logos_cache_v3';

export function getCachedLeagueLogos(): Record<string, string> {
  try {
    if (typeof window === 'undefined') return {};
    const raw = localStorage.getItem(LEAGUE_LOGOS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.data === 'object') {
        return parsed.data;
      }
    }
  } catch {
    // Ignore storage parse errors
  }
  return {};
}

export function saveCachedLeagueLogos(logos: Record<string, string>) {
  try {
    if (typeof window === 'undefined') return;
    const payload = {
      data: logos,
      timestamp: Date.now(),
    };
    localStorage.setItem(LEAGUE_LOGOS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write errors
  }
}

export function clearLeagueLogosCache(): void {
  try {
    if (typeof window === 'undefined') return;
    const keysToRemove: string[] = [];
    // Collect first, delete after. Iterating while removing would shift indices;
    // also localStorage.length is re-read every iteration, so a concurrent tab
    // mutation could cause key(i) to return null (which the `key &&` guard skips).
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sports_teams_cache_') || key.startsWith('sports_league_logos_') || key.startsWith('sports_logo_'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
    console.log('[Sports Cache] Cleared all permanent sports logo and team caches');
  } catch (err) {
    console.error('Failed to clear logos cache:', err);
  }
}

export async function getLeagueLogos(leagueIds?: string[]): Promise<Record<string, string>> {
  const ids = leagueIds && leagueIds.length > 0 ? leagueIds : Object.keys(SPORT_CONFIG);
  const cached = getCachedLeagueLogos();

  // If all requested league logos are already present in persistent cache, return immediately
  const missingIds = ids.filter((id) => !cached[id]);
  if (missingIds.length === 0) {
    return cached;
  }

  const results: Record<string, string> = { ...cached };

  // Fire the missing lookups in small batches to avoid hammering ESPN with one
  // big Promise.all burst when many leagues are uncached (rate limiting / 403s).
  const CHUNK_SIZE = 6;
  const fetchOne = async (leagueId: string): Promise<void> => {
    const config = SPORT_CONFIG[leagueId];
    if (!config) return;

    const data = await fetchJson<CoreLeagueResponse>(
      buildCoreLeagueUrl(config.sport, config.league),
      { ttlMs: 365 * 24 * 60 * 60 * 1000, suppressWarns: true }
    );
    if (!data?.logos?.length) return;

    const dark = data.logos.find((l) => l.rel?.includes('dark'));
    const href = (dark ?? data.logos[0])?.href;
    if (href) results[leagueId] = href;
  };

  for (let i = 0; i < missingIds.length; i += CHUNK_SIZE) {
    const chunk = missingIds.slice(i, i + CHUNK_SIZE);
    await Promise.all(chunk.map(fetchOne));
  }

  saveCachedLeagueLogos(results);
  return results;
}

export function getAvailableLeagues(): { id: string; name: string; sport: string; }[] {
  return Object.entries(SPORT_CONFIG).map(([key, config]) => ({
    id: key,
    name: config.name,
    sport: config.sport,
  }));
}

export function getAvailableCategories(): { id: string; name: string; leagues: string[]; }[] {
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
    rugby: 'Rugby Union',
    'rugby-league': 'Rugby League',
  };

  return Object.entries(categories).map(([id, leagues]) => ({
    id,
    name: categoryNames[id] || id,
    leagues,
  }));
}

export function getLeaguesByCategory(category: string): { id: string; name: string; sport: string; }[] {
  return Object.entries(SPORT_CONFIG)
    .filter(([_, config]) => config.category === category)
    .map(([key, config]) => ({
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
    'soccer': ['soccer-eng.1', 'soccer-esp.1', 'soccer-ger.1', 'soccer-ita.1', 'soccer-usa.1', 'soccer-usa.nwsl', 'soccer-usa.nwsl.cup', 'soccer-fifa.wwc'],
    'american football': ['nfl', 'college-football'],
    'rugby union': ['rugby-180659', 'rugby-164205', 'rugby-267979', 'rugby-242041', 'rugby-270559'],
    'rugby league': ['rugby-league-3'],
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
