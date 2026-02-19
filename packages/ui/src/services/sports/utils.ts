/**
 * Sports Utils
 *
 * Formatting and utility functions for sports data
 */

export function formatEventTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatEventDate(date: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return 'Tomorrow';
  }
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatEventDateTime(date: Date): string {
  return `${formatEventDate(date)} ${formatEventTime(date)}`;
}

export function formatLastUpdated(date: Date | null): string {
  if (!date) return '';
  
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeDate(date?: Date): string {
  if (!date) return '';
  
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// Status helpers
export function isEventLive<T extends { status: string }>(event: T): boolean {
  return event.status === 'live';
}

export function isEventUpcoming<T extends { status: string; startTime: Date }>(event: T): boolean {
  return event.status === 'scheduled' && event.startTime.getTime() > Date.now();
}

export function isEventFinished<T extends { status: string }>(event: T): boolean {
  return event.status === 'finished';
}

// League/Sport helpers
export function getAvailableSports(): string[] {
  return ['Football', 'Basketball', 'Baseball', 'Hockey', 'Soccer', 'MMA', 'Golf', 'Tennis', 'Racing'];
}

import { SPORT_CONFIG } from './config';
import type { SportsLeague } from './types';

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
    'soccer': ['soccer-eng.1', 'soccer-esp.1', 'soccer-ger.1', 'soccer-ita.1', 'soccer-usa.1'],
    'american football': ['nfl', 'college-football'],
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
