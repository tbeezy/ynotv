import { useState, useEffect, useCallback } from 'react';
import type { SportsEvent, SportsTeam, SportsLeague, SportsTabId } from '@ynotv/core';
import {
  getLeaguesBySport,
  getAvailableSports,
} from '../../services/sports';
import { useSportsSelectedTab, useSetSportsSelectedTab } from '../../stores/uiStore';
import { SportsErrorBoundary } from './shared/SportsErrorBoundary';
import { LiveScoresTab } from './LiveScoresTab';
import { UpcomingTab } from './UpcomingTab';
import { LeaguesTab } from './LeaguesTab';
import { FavoritesTab } from './FavoritesTab';
import { NewsTab } from './NewsTab';
import { LeadersTab } from './LeadersTab';
import { SettingsTab } from './SettingsTab';
import './SportsHub.css';

interface SportsHubProps {
  onClose: () => void;
  onSearchChannels?: (query: string) => void;
}

export function SportsHub({ onClose, onSearchChannels }: SportsHubProps) {
  const activeTab = useSportsSelectedTab();
  const setActiveTab = useSetSportsSelectedTab();
  const [selectedSport, setSelectedSport] = useState<string | null>(null);
  const [selectedLeague, setSelectedLeague] = useState<SportsLeague | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<SportsTeam | null>(null);
  const [leagues, setLeagues] = useState<SportsLeague[]>([]);
  const [loading, setLoading] = useState(false);

  const sports = getAvailableSports();

  useEffect(() => {
    if (selectedSport) {
      setLoading(true);
      getLeaguesBySport(selectedSport)
        .then(setLeagues)
        .finally(() => setLoading(false));
    }
  }, [selectedSport]);

  const handleSearchChannels = useCallback((channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
      // Note: do NOT call onClose() here — onSearchChannels already switches
      // activeView to 'guide', so calling onClose() would immediately undo that.
    }
  }, [onSearchChannels]);

  const handleBack = useCallback(() => {
    if (selectedTeam) {
      setSelectedTeam(null);
    } else if (selectedLeague) {
      setSelectedLeague(null);
    } else if (selectedSport) {
      setSelectedSport(null);
    } else {
      onClose();
    }
  }, [selectedTeam, selectedLeague, selectedSport, onClose]);

  const getTabIcon = (tab: SportsTabId) => {
    switch (tab) {
      case 'live':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
          </svg>
        );
      case 'upcoming':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        );
      case 'leagues':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
            <line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        );
      case 'favorites':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        );
      case 'news':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        );
      case 'leaders':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        );
      case 'settings':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        );
    }
  };

  const getTabLabel = (tab: SportsTabId) => {
    switch (tab) {
      case 'live':
        return 'Live Now';
      case 'upcoming':
        return 'Upcoming';
      case 'leagues':
        return 'Leagues';
      case 'favorites':
        return 'Favorites';
      case 'news':
        return 'News';
      case 'leaders':
        return 'Leaders';
      case 'settings':
        return 'Settings';
    }
  };

  const renderContent = () => {
    const tabContent = (() => {
      switch (activeTab) {
        case 'live':
          return <LiveScoresTab onSearchChannels={handleSearchChannels} />;
        case 'upcoming':
          return <UpcomingTab onSearchChannels={handleSearchChannels} />;
        case 'leagues':
          return <LeaguesTab onSearchChannels={handleSearchChannels} />;
        case 'favorites':
          return <FavoritesTab onSearchChannels={handleSearchChannels} />;
        case 'news':
          return <NewsTab onSearchChannels={handleSearchChannels} />;
        case 'leaders':
          return <LeadersTab onSearchChannels={handleSearchChannels} />;
        case 'settings':
          return <SettingsTab />;
      }
    })();

    return (
      <SportsErrorBoundary>
        {tabContent}
      </SportsErrorBoundary>
    );
  };

  return (
    <div className="sports-hub">
      <aside className="sports-sidebar">
        <div className="sports-sidebar-header">
          <h2 className="sports-sidebar-title">Sports Hub</h2>
          <p className="sports-sidebar-subtitle">Live Scores & TV Listings</p>
        </div>

        <nav className="sports-nav">
          {(['live', 'upcoming', 'leagues', 'favorites', 'news', 'leaders', 'settings'] as SportsTabId[]).map((tab) => (
            <button
              key={tab}
              className={`sports-nav-item ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <span className="sports-nav-icon">{getTabIcon(tab)}</span>
              <span className="sports-nav-label">{getTabLabel(tab)}</span>
            </button>
          ))}
        </nav>

        <div className="sports-sidebar-footer">
          <button className="sports-back-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to TV
          </button>
        </div>
      </aside>

      <main className="sports-main">
        <header className="sports-main-header">
          <h1 className="sports-main-title">{getTabLabel(activeTab)}</h1>
        </header>

        <div className="sports-content">
          {renderContent()}
        </div>
      </main>
    </div>
  );
}
