import './SettingsSidebar.css';

export type SettingsTabId =
  | 'sources'
  | 'tmdb'
  | 'refresh'
  | 'channels'
  | 'movies'
  | 'series'
  | 'posterdb'
  | 'security'
  | 'debug'
  | 'shortcuts'
  | 'export-import'
  | 'ui'
  | 'theme'
  | 'dvr'
  | 'startup';

interface SettingsCategory {
  label: string;
  tabs: {
    id: SettingsTabId;
    label: string;
    icon?: string;
    hidden?: boolean;
  }[];
}

const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    label: 'Content',
    tabs: [
      { id: 'sources', label: 'Sources' },
      { id: 'refresh', label: 'Data Refresh' },
      { id: 'tmdb', label: 'TMDB' },
      { id: 'posterdb', label: 'Poster DB' },
    ],
  },
  {
    label: 'Library',
    tabs: [
      { id: 'channels', label: 'Channels' },
      { id: 'movies', label: 'Movies' },
      { id: 'series', label: 'Series' },
    ],
  },
  {
    label: 'System',
    tabs: [
      { id: 'theme', label: 'Theme' },
      { id: 'ui', label: 'UI' },
      { id: 'startup', label: 'Startup' },
      { id: 'security', label: 'Security' },
      { id: 'debug', label: 'Debug' },
      { id: 'shortcuts', label: 'Shortcuts' },
      { id: 'export-import', label: 'Export / Import' },
      { id: 'dvr', label: 'DVR' },
    ],
  },
];

interface SettingsSidebarProps {
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  hasVodSource: boolean;
}

export function SettingsSidebar({
  activeTab,
  onTabChange,
  hasVodSource,
}: SettingsSidebarProps) {
  return (
    <nav className="settings-sidebar">
      {SETTINGS_CATEGORIES.map((category, categoryIndex) => (
        <div key={categoryIndex} className="settings-category">
          {category.label && (
            <div className="settings-category-header">{category.label}</div>
          )}
          {category.tabs.map((tab) => {
            // Hide Movies/Series tabs if no VOD source (Xtream or Stalker)
            const isLibraryTab = tab.id === 'movies' || tab.id === 'series';
            if (isLibraryTab && !hasVodSource) {
              return null;
            }

            return (
              <button
                key={tab.id}
                className={`settings-nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.icon && <span className="icon">{tab.icon}</span>}
                {tab.label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
