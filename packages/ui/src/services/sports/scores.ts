/**
 * Scores API
 *
 * Functions for fetching scoreboards and live scores
 */

import type { ESPNEvent, SportsEvent } from './types';
import { SPORT_CONFIG, DEFAULT_LIVE_LEAGUES, DEFAULT_UPCOMING_LEAGUES } from './config';
import { fetchJson, buildScoreboardUrl, buildDateRangeUrl } from './client';
import { mapESPNEvent } from './mappers';

export interface ScoreboardFilters {
  leagues?: string[];
  date?: Date;
}

export async function getScoreboard(sportKey: string, date?: Date): Promise<SportsEvent[]> {
  const config = SPORT_CONFIG[sportKey];
  if (!config) {
    console.warn('[ESPN API] Unknown sport key:', sportKey);
    return [];
  }

  const url = buildScoreboardUrl(config.sport, config.league, date);
  const data = await fetchJson<{ events: ESPNEvent[] }>(url);

  if (!data?.events) return [];

  return data.events.map(e => mapESPNEvent(e, sportKey));
}

export async function getLiveScores(leagues?: string[]): Promise<SportsEvent[]> {
  const allEvents: SportsEvent[] = [];
  const targetLeagues = leagues || DEFAULT_LIVE_LEAGUES;

  const now = new Date();
  // Use LOCAL date for "today" - games should show based on user's local date
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  
  for (const sportKey of targetLeagues) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;
    
    try {
      const url = buildScoreboardUrl(config.sport, config.league);
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
  // 2. Games scheduled for today (local date)
  // 3. Finished games that ended within the last 6 hours
  const filteredEvents = allEvents.filter(event => {
    if (event.status === 'live') return true;

    // Convert event time to local date for comparison
    // This ensures games show on the user's local "today", not UTC "today"
    const eventLocalDate = new Date(
      event.startTime.getFullYear(),
      event.startTime.getMonth(),
      event.startTime.getDate()
    );
    const todayLocalDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate());

    // Show scheduled games for today only (local date comparison)
    if (event.status === 'scheduled') {
      return eventLocalDate.getTime() === todayLocalDate.getTime();
    }

    // Show finished games from the last 6 hours (local time for recency)
    if (event.status === 'finished') {
      return event.startTime.getTime() >= sixHoursAgo.getTime();
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

export async function getUpcomingEvents(days: number = 7, leagues?: string[]): Promise<SportsEvent[]> {
  const allEvents: SportsEvent[] = [];
  const targetLeagues = leagues || DEFAULT_UPCOMING_LEAGUES;
  
  const now = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  
  for (const sportKey of targetLeagues) {
    const config = SPORT_CONFIG[sportKey];
    if (!config) continue;
    
    try {
      const url = buildDateRangeUrl(config.sport, config.league, now, endDate);
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

export async function getLeagueEvents(leagueId: string): Promise<SportsEvent[]> {
  return getScoreboard(leagueId);
}

export async function getEventsForDate(date: Date): Promise<SportsEvent[]> {
  return getLiveScores();
}
