/**
 * Scores API
 *
 * Functions for fetching scoreboards and live scores
 */

import type { ESPNEvent, SportsEvent } from './types';
import { SPORT_CONFIG, DEFAULT_LIVE_LEAGUES, DEFAULT_UPCOMING_LEAGUES } from './config';
import { fetchJson, buildScoreboardUrl, buildDateRangeUrl } from './client';
import { mapESPNEvent } from './mappers';
import { isEventLiveOrPastStart } from './utils';

export interface ScoreboardFilters {
  leagues?: string[];
  date?: Date;
}

// Batch configuration
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 5000; // 5 seconds between batches

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

/**
 * Fetch a single sport's scores
 */
async function fetchSportScores(sportKey: string): Promise<SportsEvent[]> {
  const config = SPORT_CONFIG[sportKey];
  if (!config) return [];

  try {
    const url = buildScoreboardUrl(config.sport, config.league);
    const data = await fetchJson<{ events: ESPNEvent[] }>(url);

    if (data?.events) {
      return data.events.map(e => mapESPNEvent(e, sportKey));
    }
  } catch (err) {
    console.error('[ESPN API] Error fetching', sportKey, err);
  }
  return [];
}

/**
 * Filter events to only show:
 * 1. Live games (status === 'live')
 * 2. Games scheduled for today (local date)
 * 3. Finished games that ended within the last 6 hours
 */
function filterLiveEvents(events: SportsEvent[]): SportsEvent[] {
  const now = new Date();
  // Use LOCAL date for "today" - games should show based on user's local date
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

  return events.filter(event => {
    if (event.status === 'live') return true;

    // Convert event time to local date for comparison
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
}

/**
 * Sort events: live games first, then by start time
 */
function sortEvents(events: SportsEvent[]): SportsEvent[] {
  return events.sort((a, b) => {
    const aLive = isEventLiveOrPastStart(a);
    const bLive = isEventLiveOrPastStart(b);
    // Live or past-start-time games first
    if (aLive && !bLive) return -1;
    if (bLive && !aLive) return 1;
    // Then by start time
    return a.startTime.getTime() - b.startTime.getTime();
  });
}

/**
 * Progressive callback type for receiving batch updates
 */
export type OnBatchProgress = (
  events: SportsEvent[],
  batchIndex: number,
  totalBatches: number,
  completedApis: number,
  totalApis: number
) => void;

/**
 * Internal function to fetch scores for specific leagues with optional progress callback
 */
async function getScoresForLeaguesInternal(
  targetLeagues: string[],
  onProgress?: OnBatchProgress,
  existingEvents?: SportsEvent[]
): Promise<SportsEvent[]> {
  // Map of leagueId -> SportsEvent[]
  const leagueEventsMap = new Map<string, SportsEvent[]>();

  // If existing events provided, group them by league.id
  if (existingEvents && existingEvents.length > 0) {
    for (const event of existingEvents) {
      const lid = event.league.id;
      if (!leagueEventsMap.has(lid)) {
        leagueEventsMap.set(lid, []);
      }
      leagueEventsMap.get(lid)!.push(event);
    }
  }

  // Split leagues into batches
  const batches: string[][] = [];
  for (let i = 0; i < targetLeagues.length; i += BATCH_SIZE) {
    batches.push(targetLeagues.slice(i, i + BATCH_SIZE));
  }

  const totalBatches = batches.length;
  const totalApis = targetLeagues.length;
  let completedApis = 0;
  console.log(`[ESPN API] Fetching ${targetLeagues.length} leagues in ${totalBatches} batches of ${BATCH_SIZE}`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // Wait between batches (except for first batch)
    if (batchIndex > 0) {
      console.log(`[ESPN API] Waiting ${BATCH_DELAY_MS}ms before batch ${batchIndex + 1}/${totalBatches}`);
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    // Fetch current batch in parallel
    console.log(`[ESPN API] Fetching batch ${batchIndex + 1}/${totalBatches}: ${batch.join(', ')}`);
    const batchPromises = batch.map(async (sportKey) => {
      try {
        const res = await fetchSportScores(sportKey);
        // Replace this league's events in the map with fresh data
        leagueEventsMap.set(sportKey, res);
      } catch (err) {
        console.error(`[ESPN API] Error in progressive fetch for ${sportKey}:`, err);
      } finally {
        completedApis++;
        if (onProgress) {
          const combined: SportsEvent[] = [];
          for (const evs of leagueEventsMap.values()) {
            combined.push(...evs);
          }
          const filtered = filterLiveEvents(combined);
          const sorted = sortEvents(filtered);
          onProgress(sorted, batchIndex, totalBatches, completedApis, totalApis);
        }
      }
    });

    await Promise.all(batchPromises);
    console.log(`[ESPN API] Batch ${batchIndex + 1}/${totalBatches} complete`);
  }

  // Final filter and sort
  const finalCombined: SportsEvent[] = [];
  for (const evs of leagueEventsMap.values()) {
    finalCombined.push(...evs);
  }
  const filteredEvents = filterLiveEvents(finalCombined);
  const sortedEvents = sortEvents(filteredEvents);

  console.log(`[ESPN API] Total: ${sortedEvents.length} events (${sortedEvents.filter((e) => e.status === 'live').length} live)`);
  return sortedEvents;
}

/**
 * Get live scores with batch fetching and optional progress callback
 *
 * - Fetches in parallel batches of BATCH_SIZE (5)
 * - Waits BATCH_DELAY_MS (5s) between batches
 * - Calls onProgress immediately when each batch completes
 * - Returns all events at the end
 */
export async function getLiveScores(
  leagues?: string[],
  onProgress?: OnBatchProgress,
  existingEvents?: SportsEvent[]
): Promise<SportsEvent[]> {
  const targetLeagues = leagues || DEFAULT_LIVE_LEAGUES;
  return getScoresForLeaguesInternal(targetLeagues, onProgress, existingEvents);
}

/**
 * Get live scores for specific leagues only, merging with existing events
 * Used for selective polling - only fetches leagues that need updates
 *
 * @param leaguesToFetch - Specific league IDs to fetch
 * @param existingEvents - Current events to merge with (for leagues not being fetched)
 * @param onProgress - Optional callback for progress updates
 */
export async function getLiveScoresForLeagues(
  leaguesToFetch: string[],
  existingEvents: SportsEvent[],
  onProgress?: OnBatchProgress
): Promise<SportsEvent[]> {
  if (leaguesToFetch.length === 0) {
    // No leagues to fetch, return existing events (filtered/sorted)
    const filtered = filterLiveEvents(existingEvents);
    return sortEvents(filtered);
  }

  console.log(`[ESPN API Selective] Merging with ${existingEvents.length} cached events, fetching ${leaguesToFetch.length} leagues`);

  // Fetch only the specified leagues, merging with kept events
  return getScoresForLeaguesInternal(leaguesToFetch, onProgress, existingEvents);
}

/**
 * Fetch a single sport's upcoming scores
 */
async function fetchSportUpcomingScores(sportKey: string, now: Date, endDate: Date): Promise<SportsEvent[]> {
  const config = SPORT_CONFIG[sportKey];
  if (!config) return [];

  try {
    const url = buildDateRangeUrl(config.sport, config.league, now, endDate);
    const data = await fetchJson<{ events: ESPNEvent[] }>(url);

    if (data?.events) {
      return data.events.map(e => mapESPNEvent(e, sportKey));
    }
  } catch (err) {
    console.error('[ESPN API] Error fetching upcoming', sportKey, err);
  }
  return [];
}

export async function getUpcomingEvents(days: number = 7, leagues?: string[]): Promise<SportsEvent[]> {
  const targetLeagues = leagues || DEFAULT_UPCOMING_LEAGUES;
  const allEvents: SportsEvent[] = [];

  const now = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const endTime = endDate.getTime();

  // Split leagues into batches
  const batches: string[][] = [];
  for (let i = 0; i < targetLeagues.length; i += BATCH_SIZE) {
    batches.push(targetLeagues.slice(i, i + BATCH_SIZE));
  }

  const totalBatches = batches.length;
  console.log(`[ESPN API Upcoming] Fetching ${targetLeagues.length} leagues in ${totalBatches} batches of ${BATCH_SIZE}`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // Wait between batches (except for first batch)
    if (batchIndex > 0) {
      console.log(`[ESPN API Upcoming] Waiting ${BATCH_DELAY_MS}ms before batch ${batchIndex + 1}/${totalBatches}`);
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }

    // Fetch current batch in parallel
    console.log(`[ESPN API Upcoming] Fetching batch ${batchIndex + 1}/${totalBatches}: ${batch.join(', ')}`);
    const batchPromises = batch.map(sportKey => fetchSportUpcomingScores(sportKey, now, endDate));
    const batchResults = await Promise.all(batchPromises);

    // Flatten batch results
    const batchEvents = batchResults.flat();
    allEvents.push(...batchEvents);

    console.log(`[ESPN API Upcoming] Batch ${batchIndex + 1}/${totalBatches} complete: ${batchEvents.length} events`);
  }

  // Filter to only show scheduled games in the future within the specified range
  return allEvents
    .filter(e => {
      if (e.status !== 'scheduled') return false;
      const eventTime = e.startTime.getTime();
      return eventTime >= now.getTime() && eventTime <= endTime;
    })
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

export async function getLeagueEvents(leagueId: string, date?: Date): Promise<SportsEvent[]> {
  return getScoreboard(leagueId, date);
}

export async function getEventsForDate(date: Date): Promise<SportsEvent[]> {
  return getLiveScores();
}
