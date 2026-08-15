import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSportsSettingsStore, getLeaguesByCategory } from '../../stores/sportsSettingsStore';
import { clearLeagueLogosCache } from '../../services/sports/utils';
import { TeamChannelSettingsModal } from './TeamChannelSettings';

interface SettingsTabProps {}

export function SettingsTab({}: SettingsTabProps) {
  const { t } = useTranslation('sports');
  const [clearedLogosMessage, setClearedLogosMessage] = useState(false);
  const [teamChannelsOpen, setTeamChannelsOpen] = useState(false);
  const {
    enabledLeagues,
    toggleLeagueAll,
    setCategoryAll,
    resetToDefaults,
    loaded,
    loadSettings,
    showWorldCupTab,
    setShowWorldCupTab,
  } = useSportsSettingsStore();
  const leaguesByCategory = getLeaguesByCategory();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  const categoryOrder = ['football', 'basketball', 'baseball', 'hockey', 'soccer', 'mma', 'golf', 'tennis', 'racing', 'rugby', 'rugby-league'];
  const categoryLabels: Record<string, string> = {
    football: 'Football',
    basketball: 'Basketball',
    baseball: 'Baseball',
    hockey: 'Hockey',
    soccer: 'Soccer',
    mma: 'MMA',
    golf: 'Golf',
    tennis: 'Tennis',
    racing: 'Racing',
    rugby: 'Rugby Union',
    'rugby-league': 'Rugby League',
  };

  const isAllInCategory = (category: string) => {
    const leagues = leaguesByCategory[category];
    if (!leagues || leagues.length === 0) return false;
    return leagues.every(l => enabledLeagues.includes(l.id));
  };

  return (
    <div className="sports-tab-content">
      <div className="sports-settings-header">
        <div>
          <h2 className="sports-settings-title" style={{ fontSize: '1.4rem', fontWeight: 750, color: 'var(--text-primary, #ffffff)' }}>
            {t('configureActiveLeagues')}
          </h2>
          <p className="sports-settings-subtitle">{t('enabledLeaguesDesc')}</p>
        </div>
        <button className="sports-settings-reset" onClick={resetToDefaults}>
          {i18n.t('common:resetToDefaults')}
        </button>
      </div>

      <div className="sports-settings-grid">
        <div className="sports-settings-card">
          <div className="sports-settings-card-header">
            <span className="sports-settings-category-title">{t('generalSettings')}</span>
          </div>
          <div className="sports-settings-leagues-list">
            <div className="sports-settings-league-item">
              <span className="sports-settings-league-name">{t('showWorldCupTab')}</span>
              <label className="sports-settings-toggle">
                <input
                  type="checkbox"
                  checked={showWorldCupTab}
                  onChange={(e) => setShowWorldCupTab(e.target.checked)}
                />
                <span className="sports-settings-toggle-slider"></span>
              </label>
            </div>

            <div className="sports-settings-league-item" style={{ paddingTop: 10, borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div>
                <span className="sports-settings-league-name">{t('cachedSportsLogos')}</span>
                <p style={{ margin: '2px 0 0 0', fontSize: '0.775rem', color: 'rgba(255, 255, 255, 0.5)' }}>
                  {t('logosCacheDesc')}
                </p>
              </div>
              <button
                className="sports-settings-reset"
                style={{ padding: '6px 12px', fontSize: '0.8rem', flexShrink: 0 }}
                onClick={() => {
                  clearLeagueLogosCache();
                  setClearedLogosMessage(true);
                  setTimeout(() => setClearedLogosMessage(false), 3000);
                }}
              >
                {clearedLogosMessage ? t('cacheCleared') : t('clearLogoCache')}
              </button>
            </div>

            <div className="sports-settings-league-item" style={{ paddingTop: 10, borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div>
                <span className="sports-settings-league-name">{t('teamChannels')}</span>
                <p style={{ margin: '2px 0 0 0', fontSize: '0.775rem', color: 'rgba(255, 255, 255, 0.5)' }}>
                  {t('teamChannelsDesc')}
                </p>
              </div>
              <button
                className="sports-settings-reset"
                style={{ padding: '6px 12px', fontSize: '0.8rem', flexShrink: 0 }}
                onClick={() => setTeamChannelsOpen(true)}
              >
                {t('manageTeamChannels')}
              </button>
            </div>
          </div>
        </div>

        {categoryOrder.map(category => {
          const leagues = leaguesByCategory[category];
          if (!leagues || leagues.length === 0) return null;

          const isAllEnabled = isAllInCategory(category);

          return (
            <div key={category} className="sports-settings-card">
              <div className="sports-settings-card-header">
                <span className="sports-settings-category-title">{categoryLabels[category]}</span>
                <label className="sports-settings-toggle">
                  <input
                    type="checkbox"
                    checked={isAllEnabled}
                    onChange={(e) => setCategoryAll(category, e.target.checked)}
                  />
                  <span className="sports-settings-toggle-slider"></span>
                  <span className="sports-settings-toggle-label">{t('all')}</span>
                </label>
              </div>

              <div className="sports-settings-leagues-list">
                {leagues.map(league => {
                  const isEnabled = enabledLeagues.includes(league.id);
                  return (
                    <div key={league.id} className="sports-settings-league-item">
                      <span className="sports-settings-league-name">{league.name}</span>
                      <label className="sports-settings-toggle">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={() => toggleLeagueAll(league.id)}
                        />
                        <span className="sports-settings-toggle-slider"></span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <TeamChannelSettingsModal isOpen={teamChannelsOpen} onClose={() => setTeamChannelsOpen(false)} />
    </div>
  );
}

export default SettingsTab;
