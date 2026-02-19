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

// Note: getAvailableCategories is now in config.ts to avoid circular dependencies
