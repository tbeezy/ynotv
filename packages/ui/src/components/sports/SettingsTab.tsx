import { useEffect } from 'react';
import { useSportsSettingsStore, getAllLeagues, getLeaguesByCategory, type LeagueConfig } from '../../stores/sportsSettingsStore';

interface SettingsTabProps {}

export function SettingsTab({}: SettingsTabProps) {
  const { liveLeagues, upcomingLeagues, newsLeagues, toggleLeague, resetToDefaults, loaded, loadSettings } = useSportsSettingsStore();
  const leaguesByCategory = getLeaguesByCategory();
  const allLeagues = getAllLeagues();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  const categoryOrder = ['football', 'basketball', 'baseball', 'hockey', 'soccer', 'mma', 'golf', 'tennis', 'racing'];
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
  };

  const renderLeagueGrid = (section: 'live' | 'upcoming' | 'news', selected: string[]) => {
    return (
      <div className="sports-settings-leagues">
        {categoryOrder.map(category => {
          const leagues = leaguesByCategory[category];
          if (!leagues || leagues.length === 0) return null;

          return (
            <div key={category} className="sports-settings-category">
              <h4 className="sports-settings-category-title">{categoryLabels[category]}</h4>
              <div className="sports-settings-league-grid">
                {leagues.map(league => {
                  const isSelected = selected.includes(league.id);
                  return (
                    <button
                      key={league.id}
                      className={`sports-settings-league-btn ${isSelected ? 'selected' : ''}`}
                      onClick={() => toggleLeague(section, league.id)}
                    >
                      <span className="sports-settings-league-check">
                        {isSelected && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <span className="sports-settings-league-name">{league.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="sports-tab-content">
      <div className="sports-settings-header">
        <h2 className="sports-settings-title">Configure which leagues appear in each section</h2>
        <button className="sports-settings-reset" onClick={resetToDefaults}>
          Reset to Defaults
        </button>
      </div>

      <div className="sports-settings-sections">
        <section className="sports-settings-section">
          <div className="sports-settings-section-header">
            <div className="sports-settings-section-icon live">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
              </svg>
            </div>
            <div className="sports-settings-section-info">
              <h3>Live Now</h3>
              <p>{liveLeagues.length} leagues selected</p>
            </div>
          </div>
          {renderLeagueGrid('live', liveLeagues)}
        </section>

        <section className="sports-settings-section">
          <div className="sports-settings-section-header">
            <div className="sports-settings-section-icon upcoming">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </div>
            <div className="sports-settings-section-info">
              <h3>Upcoming</h3>
              <p>{upcomingLeagues.length} leagues selected</p>
            </div>
          </div>
          {renderLeagueGrid('upcoming', upcomingLeagues)}
        </section>

        <section className="sports-settings-section">
          <div className="sports-settings-section-header">
            <div className="sports-settings-section-icon news">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <div className="sports-settings-section-info">
              <h3>News</h3>
              <p>{newsLeagues.length} leagues selected</p>
            </div>
          </div>
          {renderLeagueGrid('news', newsLeagues)}
        </section>
      </div>
    </div>
  );
}

export default SettingsTab;
