import { useState, useEffect } from 'react';
import type { Source } from '@ynotv/core';
import './Sidebar.css';

// Tabler Icons (from tabler.io/icons)
const Icons = {
  // device-remote for Guide
  guide: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 10a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M7 5a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2l0 -14" />
      <path d="M12 3v2" />
      <path d="M10 15v.01" />
      <path d="M10 18v.01" />
      <path d="M14 18v.01" />
      <path d="M14 15v.01" />
    </svg>
  ),
  // Grid for categories
  categories: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    </svg>
  ),
  // movie for Movies
  movies: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" />
      <path d="M8 4l0 16" />
      <path d="M16 4l0 16" />
      <path d="M4 8l4 0" />
      <path d="M4 16l4 0" />
      <path d="M4 12l16 0" />
      <path d="M16 8l4 0" />
      <path d="M16 16l4 0" />
    </svg>
  ),
  // device-tv for Series
  series: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9" />
      <path d="M16 3l-4 4l-4 -4" />
    </svg>
  ),
  // Gear for settings
  settings: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  // Chevrons for expand/collapse
  chevronRight: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  chevronLeft: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  ),
  // Video camera for DVR
  dvr: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z" />
    </svg>
  ),
};

type View = 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'settings';

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  visible: boolean; // Controlled by parent (same as control bar visibility)
  categoriesOpen: boolean;
  onCategoriesToggle: () => void;
  onCategoriesClose: () => void;
  expanded: boolean;
  onExpandedToggle: () => void;
}

export function Sidebar({ activeView, onViewChange, visible, categoriesOpen, onCategoriesToggle, onCategoriesClose, expanded, onExpandedToggle }: SidebarProps) {
  const [hasVodSource, setHasVodSource] = useState(false);

  // Check if user has VOD sources (Xtream or Stalker) for showing Movies/Series
  useEffect(() => {
    async function checkSources() {
      if (!window.storage) return;
      const result = await window.storage.getSources();
      if (result.data) {
        setHasVodSource(result.data.some((s: Source) => s.type === 'xtream' || s.type === 'stalker'));
      }
    }
    checkSources();
  }, [activeView]); // Re-check when view changes (in case settings added a source)

  const handleClick = (view: View) => {
    if (activeView === view) {
      onViewChange('none'); // Toggle off if clicking active
    } else {
      onViewChange(view);
    }
  };

  // Movies/Series close guide and categories
  const handleVodClick = (view: View) => {
    onCategoriesClose();
    if (activeView === view) {
      onViewChange('none');
    } else {
      onViewChange(view);
    }
  };

  return (
    <div
      className={`sidebar ${expanded ? 'expanded' : ''} ${visible ? 'visible' : 'hidden'}`}
    >
      <nav className="sidebar-nav">
        <button
          className={`nav-item ${activeView === 'guide' ? 'active' : ''}`}
          onClick={() => handleClick('guide')}
          title="Guide"
        >
          <span className="nav-icon">{Icons.guide}</span>
          <span className="nav-label">Guide</span>
        </button>

        <button
          className={`nav-item ${categoriesOpen ? 'active' : ''}`}
          onClick={onCategoriesToggle}
          title="Categories"
        >
          <span className="nav-icon">{Icons.categories}</span>
          <span className="nav-label">Categories</span>
        </button>

        <button
          className={`nav-item ${activeView === 'dvr' ? 'active' : ''}`}
          onClick={() => handleVodClick('dvr')}
          title="DVR"
        >
          <span className="nav-icon">{Icons.dvr}</span>
          <span className="nav-label">DVR</span>
        </button>

        {hasVodSource && (
          <>
            <button
              className={`nav-item ${activeView === 'movies' ? 'active' : ''}`}
              onClick={() => handleVodClick('movies')}
              title="Movies"
            >
              <span className="nav-icon">{Icons.movies}</span>
              <span className="nav-label">Movies</span>
            </button>

            <button
              className={`nav-item ${activeView === 'series' ? 'active' : ''}`}
              onClick={() => handleVodClick('series')}
              title="Series"
            >
              <span className="nav-icon">{Icons.series}</span>
              <span className="nav-label">Series</span>
            </button>
          </>
        )}

        <div className="nav-spacer" />

        <button
          className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => handleClick('settings')}
          title="Settings"
        >
          <span className="nav-icon">{Icons.settings}</span>
          <span className="nav-label">Settings</span>
        </button>

        {/* Expand/collapse toggle */}
        <button
          className="nav-item nav-toggle"
          onClick={onExpandedToggle}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <span className="nav-icon">
            {expanded ? Icons.chevronLeft : Icons.chevronRight}
          </span>
        </button>
      </nav>
    </div >
  );
}

export type { View };
