import { useState, useCallback } from 'react';
import type { SportsTeam } from '@ynotv/core';
import { useFavoriteTeams, useRemoveFavorite } from '../../stores/sportsFavoritesStore';
import { TeamDetail } from './TeamDetail';

interface FavoritesTabProps {
  onSearchChannels?: (channelName: string) => void;
}

export function FavoritesTab({ onSearchChannels }: FavoritesTabProps) {
  const favorites = useFavoriteTeams();
  const removeFavorite = useRemoveFavorite();
  const [selectedTeam, setSelectedTeam] = useState<SportsTeam | null>(null);

  const handleChannelClick = (channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
    }
  };

  if (selectedTeam) {
    return (
      <TeamDetail
        team={selectedTeam}
        onClose={() => setSelectedTeam(null)}
        onChannelClick={handleChannelClick}
      />
    );
  }

  if (favorites.length === 0) {
    return (
      <div className="sports-empty">
        <div className="sports-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </div>
        <h3>No Favorite Teams</h3>
        <p>Search for teams and click the star to add them here.</p>
      </div>
    );
  }

  return (
    <div className="sports-tab-content">
      <section className="sports-section">
        <h2 className="sports-section-title">Your Favorite Teams ({favorites.length})</h2>
        <div className="sports-teams-grid">
          {favorites.map((team) => (
            <div key={team.id} className="sports-team-card-wrapper">
              <button
                className="sports-team-card"
                onClick={() => setSelectedTeam(team)}
              >
                {team.logo && (
                  <img src={team.logo} alt={team.name} className="sports-team-card-logo" />
                )}
                <div className="sports-team-card-info">
                  <span className="sports-team-card-name">{team.name}</span>
                  {team.shortName && (
                    <span className="sports-team-card-country">{team.shortName}</span>
                  )}
                </div>
              </button>
              <button
                className="sports-team-card-remove"
                onClick={() => removeFavorite(team.id)}
                title="Remove from favorites"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default FavoritesTab;
