import { useState, useEffect } from 'react';
import type { SportsEvent } from '@ynotv/core';
import {
  getAvailableCategories,
  getLeaguesByCategory,
  isEventLiveOrPastStart,
} from '../../services/sports';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useSportsPolling, formatLastUpdated } from '../../hooks/useSportsPolling';
import { useSetSportsSelectedTab } from '../../stores/uiStore';
import { useEpgClockFormat } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { GameCard } from './GameCard';
import { GameDetail } from './GameDetail';
import { GameCardSkeleton } from './LoadingSkeleton';
import { TeamChannelSettingsModal } from './TeamChannelSettings';
import { SportsSearchSettingsModal } from './SportsSearchSettingsModal';
import './LoadingSkeleton.css';

interface LiveScoresTabProps {
  onSearchChannels?: (channelName: string) => void;
  onPlayChannel?: (channel: import('../../db').StoredChannel) => void;
  sportsOverlayWidget?: 'autohide' | 'persistent' | null;
  onSportsOverlayWidgetChange?: (mode: 'autohide' | 'persistent' | null) => void;
}

export function LiveScoresTab({
  onSearchChannels,
  onPlayChannel,
  sportsOverlayWidget,
  onSportsOverlayWidgetChange,
}: LiveScoresTabProps) {
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [teamChannelsOpen, setTeamChannelsOpen] = useState(false);
  const [searchSettingsOpen, setSearchSettingsOpen] = useState(false);
  const setSelectedTab = useSetSportsSelectedTab();
  const epgClockFormat = useEpgClockFormat();
  useTranslation();
  
  const { liveLeagues, loaded, loadSettings } = useSportsSettingsStore();

  const { events, loading, error, lastUpdated, refresh, isPolling, progress } = useSportsPolling({
    pollingInterval: 30000,
    enabled: loaded,
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

  const liveCount = filteredEvents.filter(isEventLiveOrPastStart).length;

  const groupedByLeague = filteredEvents.reduce((acc, event) => {
    const leagueName = event.league.name;
    if (!acc[leagueName]) acc[leagueName] = [];
    acc[leagueName].push(event);
    return acc;
  }, {} as Record<string, SportsEvent[]>);

  const sortedLeagues = Object.keys(groupedByLeague).sort((a, b) => {
    const aHasLive = groupedByLeague[a].some(isEventLiveOrPastStart);
    const bHasLive = groupedByLeague[b].some(isEventLiveOrPastStart);
    if (aHasLive && !bHasLive) return -1;
    if (!aHasLive && bHasLive) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="sports-tab-content">
      <div className="live-header">
        <div className="live-header-title">
          <h2>{i18n.t('sports:liveScores')}</h2>
          {liveCount > 0 && (
            <span className="live-count">
              <span className="live-count-dot" />
              {i18n.t('sports:liveCount', { count: liveCount })}
            </span>
          )}
        </div>
        <div className="live-header-divider" />
        <div className="live-controls">
          {progress ? (
            <span className="live-last-updated">
              <span className="live-loading-progress-dot" />
              {i18n.t('sports:fetchingLeagues', { completed: progress.completed, total: progress.total })}
            </span>
          ) : lastUpdated ? (
            <span className="live-last-updated">
              {i18n.t('sports:updatedAt', { time: formatLastUpdated(lastUpdated, epgClockFormat !== '24h') })}
              {isPolling && <span className="live-polling-indicator" title={i18n.t('sports:autoRefreshing')} />}
            </span>
          ) : null}
          <button
            className="live-refresh-btn"
            onClick={refresh}
            disabled={loading}
            title={i18n.t('sports:refreshScores')}
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
        <div className="live-header-divider" />
        <div className="live-categories">
          <button
            className={`live-category-btn ${selectedCategory === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('all')}
          >
            {i18n.t('sports:all')}
          </button>
          {categories.map(cat => {
            const count = events.filter(e => {
              const leagues = getLeaguesByCategory(cat.id);
              return leagues.some(l => l.id === e.league.id);
            }).length;
            
            const hasEnabledLeagues = cat.leagues.some(l => liveLeagues.includes(l));
            const shouldShow = count > 0 || (loading && events.length === 0 && hasEnabledLeagues);
            if (!shouldShow) return null;
            
            return (
              <button
                key={cat.id}
                className={`live-category-btn ${selectedCategory === cat.id ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat.id)}
              >
                {cat.name}
                {count > 0 && <span className="live-category-count">{count}</span>}
              </button>
            );
          })}
        </div>
        {onSportsOverlayWidgetChange && (
          <>
            <button
              className={`live-header-overlay-btn ${sportsOverlayWidget ? 'active' : ''}`}
              onClick={() => {
                if (sportsOverlayWidget === null) {
                  onSportsOverlayWidgetChange('autohide');
                } else if (sportsOverlayWidget === 'autohide') {
                  onSportsOverlayWidgetChange('persistent');
                } else {
                  onSportsOverlayWidgetChange(null);
                }
              }}
              title={i18n.t('sports:overlayCycle')}
            >
              {sportsOverlayWidget === 'autohide' && (
                <>
                  <span className="live-count-dot" style={{ display: 'inline-block', marginRight: '4px', background: '#3b82f6', animation: 'none' }} />
                  {i18n.t('sports:overlayAutohide')}
                </>
              )}
              {sportsOverlayWidget === 'persistent' && (
                <>
                  <span className="live-count-dot" style={{ display: 'inline-block', marginRight: '4px', background: '#10b981', animation: 'none' }} />
                  {i18n.t('sports:overlayPersistent')}
                </>
              )}
              {sportsOverlayWidget === null && (
                <>
                  {i18n.t('sports:overlayEnable')}
                </>
              )}
            </button>
            <div className="sports-tooltip-container" style={{ marginRight: '8px' }}>
              <span className="sports-tooltip-icon">?</span>
              <div className="sports-tooltip-content">
                {i18n.t('sports:overlayTooltip')}
              </div>
            </div>
          </>
        )}
        <button
          className="live-header-settings-reminder"
          style={{ marginLeft: 0 }}
          onClick={() => setSelectedTab('settings')}
          title={i18n.t('sports:configureLeaguesTooltip')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          {i18n.t('sports:configureLeagues')}
        </button>
        <button
          className="live-header-settings-reminder"
          style={{ marginLeft: 0 }}
          onClick={() => setTeamChannelsOpen(true)}
          title={i18n.t('sports:teamChannelsDesc')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
            <polyline points="17 2 12 7 7 2" />
          </svg>
          {i18n.t('sports:manageTeamChannels')}
        </button>
        <button
          className="live-header-settings-reminder"
          style={{ marginLeft: 0 }}
          onClick={() => setSearchSettingsOpen(true)}
          title={i18n.t('sports:searchSettingsDesc', { defaultValue: 'Configure search sources and categories per league' })}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          {i18n.t('sports:searchSettings', { defaultValue: 'Search Settings' })}
        </button>
      </div>

      {loading && events.length === 0 ? (
        <div className="skeleton-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <GameCardSkeleton key={i} />
          ))}
        </div>
      ) : error && events.length === 0 ? (
        <div className="sports-error">
          <p>{error}</p>
          <button className="sports-btn" onClick={refresh}>{i18n.t('common:retry')}</button>
        </div>
      ) : sortedLeagues.length === 0 ? (
        <div className="sports-empty">
          <div className="sports-empty-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
            </svg>
          </div>
          <h3>{i18n.t('sports:noGamesAvailable')}</h3>
          <p>{i18n.t('sports:noGamesCheckBack')}</p>
        </div>
      ) : (
        sortedLeagues.map(leagueName => {
          const leagueEvents = groupedByLeague[leagueName];
          const hasLive = leagueEvents.some(isEventLiveOrPastStart);
          
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
                    onSearchTeams={onSearchChannels}
                    onPlayChannel={onPlayChannel}
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

      <TeamChannelSettingsModal
        isOpen={teamChannelsOpen}
        onClose={() => setTeamChannelsOpen(false)}
      />

      <SportsSearchSettingsModal
        isOpen={searchSettingsOpen}
        onClose={() => setSearchSettingsOpen(false)}
      />
    </div>
  );
}
