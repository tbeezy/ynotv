/**
 * ESPN API Client
 *
 * HTTP client for making requests to ESPN API
 */

import { fetch } from '@tauri-apps/plugin-http';
import { ESPN_API_BASE } from './config';

export async function fetchJson<T>(url: string): Promise<T | null> {
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

export function buildScoreboardUrl(sport: string, league: string, date?: Date): string {
  let url = `${ESPN_API_BASE}/${sport}/${league}/scoreboard`;
  
  if (date) {
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    url += `?dates=${dateStr}`;
  }
  
  return url;
}

export function buildDateRangeUrl(sport: string, league: string, startDate: Date, endDate: Date): string {
  const formatDate = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, '');
  const dateRange = `${formatDate(startDate)}-${formatDate(endDate)}`;
  return `${ESPN_API_BASE}/${sport}/${league}/scoreboard?dates=${dateRange}`;
}

export function buildTeamsUrl(sport: string, league: string): string {
  return `${ESPN_API_BASE}/${sport}/${league}/teams`;
}

export function buildTeamUrl(sport: string, league: string, teamId: string): string {
  return `${ESPN_API_BASE}/${sport}/${league}/teams/${teamId}`;
}

export function buildTeamScheduleUrl(sport: string, league: string, teamId: string): string {
  return `${ESPN_API_BASE}/${sport}/${league}/teams/${teamId}/schedule`;
}

export function buildStandingsUrl(sport: string, league: string): string {
  return `https://site.web.api.espn.com/apis/v2/sports/${sport}/${league}/standings`;
}

export function buildNewsUrl(sport: string, league: string, limit: number = 20): string {
  return `${ESPN_API_BASE}/${sport}/${league}/news?limit=${limit}`;
}

export function buildRankingsUrl(sport: string, league: string): string {
  return `${ESPN_API_BASE}/${sport}/${league}/rankings`;
}

export function buildLeadersUrl(sport: string, league: string): string {
  // Leaders endpoint requires v3 API
  return `https://site.api.espn.com/apis/site/v3/sports/${sport}/${league}/leaders`;
}

export function buildGameSummaryUrl(sport: string, league: string, eventId: string): string {
  return `${ESPN_API_BASE}/${sport}/${league}/summary?event=${eventId}`;
}

export function buildPlayByPlayUrl(sport: string, league: string, eventId: string): string {
  return `${ESPN_API_BASE}/${sport}/${league}/playbyplay?event=${eventId}`;
}

export function buildUFCRankingsUrl(): string {
  return `${ESPN_API_BASE}/mma/ufc/rankings`;
}
