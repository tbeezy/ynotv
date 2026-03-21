import './SettingsSidebar.css';

export type SettingsTabId =
  | 'sources'
  | 'tmdb'
  | 'refresh'
  | 'channels'
  | 'posterdb'
  | 'security'
  | 'debug'
  | 'shortcuts'
  | 'export-import'
  | 'ui'
  | 'theme'
  | 'dvr'
  | 'startup'
  | 'tv-calendar'
  | 'playback'
  | 'cache'
  | 'livetv'
  | 'about';

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
      { id: 'livetv', label: 'LiveTV' },
    ],
  },
  {
    label: 'System',
    tabs: [
      { id: 'theme', label: 'Theme' },
      { id: 'ui', label: 'UI' },
      { id: 'startup', label: 'Startup' },
      { id: 'tv-calendar', label: 'TV Calendar' },
      { id: 'playback', label: 'Playback' },
      { id: 'cache', label: 'Cache' },
      { id: 'security', label: 'Security' },
      { id: 'debug', label: 'Debug' },
      { id: 'shortcuts', label: 'Shortcuts' },
      { id: 'export-import', label: 'Export / Import' },
      { id: 'dvr', label: 'DVR' },
      { id: 'about', label: 'About' },
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
