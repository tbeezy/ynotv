import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './PlaybackTab.css'; // Reuse existing tab styles

interface NavigationTabProps {
  navHiddenTabs: string[];
  onNavHiddenTabsChange: (tabs: string[]) => void;
  epgHiddenButtons: string[];
  onEpgHiddenButtonsChange: (buttons: string[]) => void;
  // Category props
  showAllChannels: boolean;
  onShowAllChannelsChange: (enabled: boolean) => void;
  showFavorites: boolean;
  onShowFavoritesChange: (enabled: boolean) => void;
  showWatchlist: boolean;
  onShowWatchlistChange: (enabled: boolean) => void;
  showRecentlyViewed: boolean;
  onShowRecentlyViewedChange: (enabled: boolean) => void;
}

const NAV_ITEMS = [
  { id: 'movies' },
  { id: 'series' },
  { id: 'dvr' },
  { id: 'sports' },
  { id: 'stremio' },
  { id: 'nuvio' },
  { id: 'calendar' },
  { id: 'cast' },
] as const;

const EPG_BUTTONS = [
  { id: 'channel-search' },
  { id: 'alphabet-jumper' },
  { id: 'manage-channels' },
  { id: 'refresh-source' },
  { id: 'epg-shift' },
  { id: 'playlist-editor' },
  { id: 'failover-group' },
  { id: 'channel-probe' },
] as const;

type NavItemId = (typeof NAV_ITEMS)[number]['id'];
type EpgButtonId = (typeof EPG_BUTTONS)[number]['id'];

// Literal i18n keys (nav namespace). Kept as flat lookups so every translated
// label is greppable and stays in sync with en.json by hand.
const NAV_ITEM_LABEL_KEYS = {
  movies: 'items.movies',
  series: 'items.series',
  dvr: 'items.dvr',
  sports: 'items.sports',
  stremio: 'items.stremio',
  nuvio: 'items.nuvio',
  calendar: 'items.calendar',
  cast: 'items.cast',
} as const satisfies Record<NavItemId, `items.${NavItemId}`>;

const EPG_BUTTON_LABEL_KEYS = {
  'channel-search': 'epgButtons.channel-search',
  'alphabet-jumper': 'epgButtons.alphabet-jumper',
  'manage-channels': 'epgButtons.manage-channels',
  'refresh-source': 'epgButtons.refresh-source',
  'epg-shift': 'epgButtons.epg-shift',
  'playlist-editor': 'epgButtons.playlist-editor',
  'failover-group': 'epgButtons.failover-group',
  'channel-probe': 'epgButtons.channel-probe',
} as const satisfies Record<EpgButtonId, `epgButtons.${EpgButtonId}`>;

export function NavigationTab({
  navHiddenTabs,
  onNavHiddenTabsChange,
  epgHiddenButtons,
  onEpgHiddenButtonsChange,
  showAllChannels,
  onShowAllChannelsChange,
  showFavorites,
  onShowFavoritesChange,
  showWatchlist,
  onShowWatchlistChange,
  showRecentlyViewed,
  onShowRecentlyViewedChange,
}: NavigationTabProps) {
  const [activeSubTab, setActiveSubTab] = useState<'titlebar' | 'category' | 'epg'>('titlebar');
  const { t } = useTranslation('nav');
  const isVisible = (id: string) => !navHiddenTabs.includes(id);

  const handleToggle = (id: string, checked: boolean) => {
    if (checked) {
      onNavHiddenTabsChange(navHiddenTabs.filter((t) => t !== id));
    } else {
      onNavHiddenTabsChange([...navHiddenTabs, id]);
    }
  };

  const isEpgButtonVisible = (id: string) => !epgHiddenButtons.includes(id);

  const handleEpgToggle = (id: string, checked: boolean) => {
    if (checked) {
      onEpgHiddenButtonsChange(epgHiddenButtons.filter((b) => b !== id));
    } else {
      onEpgHiddenButtonsChange([...epgHiddenButtons, id]);
    }
  };

  return (
    <div className="playback-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="settings-tabs" style={{ padding: '0 20px', flexShrink: 0 }}>
        <button
          className={`settings-tab ${activeSubTab === 'titlebar' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('titlebar')}
        >
          {i18n.t('settings:navigation.tabs.titlebar')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'category' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('category')}
        >
          {i18n.t('settings:navigation.tabs.category')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'epg' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('epg')}
        >
          {i18n.t('settings:navigation.tabs.epg')}
        </button>
      </div>

      <div className="settings-tab-content">
        {activeSubTab === 'titlebar' && (
          <div className="settings-section" style={{ paddingBottom: '8px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:navigation.mainNavTabs')}</h3>
            </div>

            <p className="section-description" style={{ marginBottom: '12px' }}>
              {i18n.t('settings:navigation.mainNavDescription')}
            </p>

            {NAV_ITEMS.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.75rem 0',
                  borderBottom: '1px solid var(--surface-border)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                    {t(NAV_ITEM_LABEL_KEYS[item.id])}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={isVisible(item.id)}
                  onChange={(e) => handleToggle(item.id, e.target.checked)}
                  style={{ cursor: 'pointer', marginLeft: '1rem' }}
                />
              </div>
            ))}
          </div>
        )}

        {activeSubTab === 'category' && (
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:navigation.liveTvCategories')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:navigation.liveTvCategoriesDescription')}
            </p>

            <div className="timeshift-settings">
              {/* All Channels Toggle */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:navigation.showAllChannels')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:navigation.showAllChannelsSub')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showAllChannels}
                    onChange={(e) => onShowAllChannelsChange(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Favorites Toggle */}
              <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:navigation.showFavorites')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:navigation.showFavoritesSub')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showFavorites}
                    onChange={(e) => onShowFavoritesChange(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Watchlist Toggle */}
              <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:navigation.showWatchlist')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:navigation.showWatchlistSub')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showWatchlist}
                    onChange={(e) => onShowWatchlistChange(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Recently Viewed Toggle */}
              <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:navigation.showRecentlyViewed')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:navigation.showRecentlyViewedSub')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showRecentlyViewed}
                    onChange={(e) => onShowRecentlyViewedChange(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          </div>
        )}

        {activeSubTab === 'epg' && (
          <div className="settings-section" style={{ paddingBottom: '8px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:navigation.epgButtons')}</h3>
            </div>

            <p className="section-description" style={{ marginBottom: '12px' }}>
              {i18n.t('settings:navigation.epgButtonsDescription')}
            </p>

            {EPG_BUTTONS.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.75rem 0',
                  borderBottom: '1px solid var(--surface-border)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                    {t(EPG_BUTTON_LABEL_KEYS[item.id])}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={isEpgButtonVisible(item.id)}
                  onChange={(e) => handleEpgToggle(item.id, e.target.checked)}
                  style={{ cursor: 'pointer', marginLeft: '1rem' }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
