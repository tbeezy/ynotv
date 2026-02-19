import { useState, useEffect } from 'react';
import type { SportsEvent } from '@ynotv/core';
import {
  getAvailableCategories,
  getLeaguesByCategory,
} from '../../services/sports';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useSportsPolling, formatLastUpdated } from '../../hooks/useSportsPolling';
import { GameCard } from './GameCard';
import { GameDetail } from './GameDetail';
import { GameCardSkeleton } from './LoadingSkeleton';
import './LoadingSkeleton.css';

interface LiveScoresTabProps {
  onSearchChannels?: (channelName: string) => void;
}

export function LiveScoresTab({ onSearchChannels }: LiveScoresTabProps) {
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  
  const { liveLeagues, loaded, loadSettings } = useSportsSettingsStore();

  const { events, loading, error, lastUpdated, refresh, isPolling } = useSportsPolling({
    pollingInterval: 30000,
    enabled: true,
    leagues: loaded ? liveLeagues : undefined,
  });
  
  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  const handleChannelClick = (channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
    }
  };

  const categories = getAvailableCategories();
  
  const filteredEvents = selectedCategory === 'all' 
    ? events 
    : events.filter(e => {
        const leagueConfig = getLeaguesByCategory(selectedCategory);
        return leagueConfig.some(l => l.id === e.league.id);
      });

  const liveCount = filteredEvents.filter(e => e.status === 'live').length;

  const groupedByLeague = filteredEvents.reduce((acc, event) => {
    const leagueName = event.league.name;
    if (!acc[leagueName]) acc[leagueName] = [];
    acc[leagueName].push(event);
    return acc;
  }, {} as Record<string, SportsEvent[]>);

  const sortedLeagues = Object.keys(groupedByLeague).sort((a, b) => {
    const aHasLive = groupedByLeague[a].some(e => e.status === 'live');
    const bHasLive = groupedByLeague[b].some(e => e.status === 'live');
    if (aHasLive && !bHasLive) return -1;
    if (!aHasLive && bHasLive) return 1;
    return a.localeCompare(b);
  });

  if (loading && events.length === 0) {
    return (
      <div className="sports-tab-content">
        <div className="live-header">
          <div className="live-header-title">
            <h2>Live Scores</h2>
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

  if (error && events.length === 0) {
    return (
      <div className="sports-error">
        <p>{error}</p>
        <button className="sports-btn" onClick={refresh}>Retry</button>
      </div>
    );
  }

  return (
    <div className="sports-tab-content">
      <div className="live-header">
        <div className="live-header-title">
          <h2>Live Scores</h2>
          {liveCount > 0 && (
            <span className="live-count">
              <span className="live-count-dot" />
              {liveCount} Live
            </span>
          )}
        </div>
        <div className="live-controls">
          {lastUpdated && (
            <span className="live-last-updated">
              Updated {formatLastUpdated(lastUpdated)}
              {isPolling && <span className="live-polling-indicator" title="Auto-refreshing" />}
            </span>
          )}
          <button 
            className="live-refresh-btn" 
            onClick={refresh} 
            disabled={loading}
            title="Refresh scores"
          >
            <svg 
              width="16" 
              height="16" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2"
              className={loading ? 'spinning' : ''}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
        <div className="live-categories">
          <button 
            className={`live-category-btn ${selectedCategory === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('all')}
          >
            All
          </button>
          {categories.map(cat => {
            const count = events.filter(e => {
              const leagues = getLeaguesByCategory(cat.id);
              return leagues.some(l => l.id === e.league.id);
            }).length;
            if (count === 0) return null;
            return (
              <button
                key={cat.id}
                className={`live-category-btn ${selectedCategory === cat.id ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat.id)}
              >
                {cat.name}
                <span className="live-category-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {sortedLeagues.length === 0 ? (
        <div className="sports-empty">
          <div className="sports-empty-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
            </svg>
          </div>
          <h3>No Games Available</h3>
          <p>Check back later or browse by league.</p>
        </div>
      ) : (
        sortedLeagues.map(leagueName => {
          const leagueEvents = groupedByLeague[leagueName];
          const hasLive = leagueEvents.some(e => e.status === 'live');
          
          return (
            <section key={leagueName} className="sports-section">
              <h2 className="sports-section-title">
                {hasLive && <span className="sports-section-dot live" />}
                {leagueName}
                <span className="sports-section-count">({leagueEvents.length})</span>
              </h2>
              <div className="sports-events-grid">
                {leagueEvents.map(event => (
                  <GameCard
                    key={event.id}
                    event={event}
                    onClick={() => setSelectedEvent(event)}
                    onChannelClick={handleChannelClick}
                  />
                ))}
              </div>
            </section>
          );
        })
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
