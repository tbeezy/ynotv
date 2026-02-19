import { useState, useEffect, useCallback } from 'react';
import type { SportsEvent } from '@ynotv/core';
import {
  getUpcomingEvents,
  formatEventDate,
} from '../../services/sports';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { GameCard } from './GameCard';
import { GameDetail } from './GameDetail';
import { GameCardSkeleton } from './LoadingSkeleton';
import './LoadingSkeleton.css';

interface UpcomingTabProps {
  onSearchChannels?: (channelName: string) => void;
}

export function UpcomingTab({ onSearchChannels }: UpcomingTabProps) {
  const [events, setEvents] = useState<SportsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const [daysAhead, setDaysAhead] = useState(3);
  
  const { upcomingLeagues, loaded, loadSettings } = useSportsSettingsStore();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  const loadEvents = useCallback(async () => {
    if (!loaded) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getUpcomingEvents(daysAhead, upcomingLeagues);
      setEvents(data);
    } catch (err) {
      console.error('[Upcoming] Failed to load:', err);
      setError('Failed to load upcoming games. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [daysAhead, upcomingLeagues, loaded]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleChannelClick = (channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
    }
  };

  const groupByDate = (events: SportsEvent[]) => {
    const groups: Map<string, SportsEvent[]> = new Map();
    for (const event of events) {
      const dateKey = event.startTime.toDateString();
      const existing = groups.get(dateKey) || [];
      existing.push(event);
      groups.set(dateKey, existing);
    }
    return groups;
  };

  const groupedEvents = groupByDate(events);

  if (loading && events.length === 0) {
    return (
      <div className="sports-tab-content">
        <div className="upcoming-header">
          <h2>Upcoming Games</h2>
          <div className="sports-filters">
            <label>Show games for:</label>
            <select value={daysAhead} onChange={(e) => setDaysAhead(Number(e.target.value))}>
              <option value={1}>Today</option>
              <option value={3}>Next 3 days</option>
              <option value={7}>Next 7 days</option>
              <option value={14}>Next 14 days</option>
            </select>
          </div>
        </div>
        <div className="skeleton-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <GameCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sports-error">
        <p>{error}</p>
        <button className="sports-btn" onClick={loadEvents}>Retry</button>
      </div>
    );
  }

  return (
    <div className="sports-tab-content">
      <div className="upcoming-header">
        <h2>Upcoming Games</h2>
        <div className="sports-filters">
          <label>Show games for:</label>
          <select value={daysAhead} onChange={(e) => setDaysAhead(Number(e.target.value))}>
            <option value={1}>Today</option>
            <option value={3}>Next 3 days</option>
            <option value={7}>Next 7 days</option>
            <option value={14}>Next 14 days</option>
          </select>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="sports-empty">
          <div className="sports-empty-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>
          <h3>No Upcoming Games</h3>
          <p>No games scheduled in the next {daysAhead} day{daysAhead > 1 ? 's' : ''}.</p>
        </div>
      ) : (
        Array.from(groupedEvents.entries()).map(([dateKey, dayEvents]) => (
          <section key={dateKey} className="sports-section">
            <h2 className="sports-section-title">
              {formatEventDate(new Date(dateKey))}
              <span className="sports-section-count">({dayEvents.length} game{dayEvents.length > 1 ? 's' : ''})</span>
            </h2>
            <div className="sports-events-grid">
              {dayEvents.map(event => (
                <GameCard
                  key={event.id}
                  event={event}
                  onClick={() => setSelectedEvent(event)}
                  onChannelClick={handleChannelClick}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {selectedEvent && (
        <GameDetail
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onChannelClick={handleChannelClick}
        />
      )}
    </div>
  );
}
