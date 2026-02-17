import { useState, useEffect } from 'react';

interface UITabProps {
  settings: {
    channelFontSize?: number;
    categoryFontSize?: number;
    showSidebar?: boolean;
    startupWidth?: number;
    startupHeight?: number;
  };
  onSettingsChange: (settings: {
    channelFontSize?: number;
    categoryFontSize?: number;
    showSidebar?: boolean;
    startupWidth?: number;
    startupHeight?: number;
  }) => void;
}

function WindowSizeSettings({ width, height, onChange }: { width: number; height: number; onChange: (w: number, h: number) => void }) {
  const [localWidth, setLocalWidth] = useState(width);
  const [localHeight, setLocalHeight] = useState(height);
  const [status, setStatus] = useState<'' | 'saved'>('');

  // Update local state when props change (e.g. initial load)
  useEffect(() => {
    setLocalWidth(width);
    setLocalHeight(height);
  }, [width, height]);

  const handleApply = () => {
    onChange(localWidth, localHeight);
    setStatus('saved');
    setTimeout(() => setStatus(''), 2000);
  };

  const handleReset = () => {
    const defW = 1920;
    const defH = 1080;
    setLocalWidth(defW);
    setLocalHeight(defH);
    onChange(defW, defH);
    setStatus('saved');
    setTimeout(() => setStatus(''), 2000);
  };

  return (
    <div className="form-group" style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.9)' }}>Width (px)</label>
          <input
            type="number"
            min="800"
            max="7680"
            value={localWidth}
            onChange={(e) => setLocalWidth(parseInt(e.target.value) || 1920)}
            className="query-input"
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.9)' }}>Height (px)</label>
          <input
            type="number"
            min="600"
            max="4320"
            value={localHeight}
            onChange={(e) => setLocalHeight(parseInt(e.target.value) || 1080)}
            className="query-input"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem' }}>
        <button
          className="sync-btn"
          onClick={handleApply}
          style={{ padding: '0.5rem 1.5rem', background: '#00d4ff', color: 'black', fontWeight: 600 }}
        >
          {status === 'saved' ? 'Saved!' : 'Apply'}
        </button>

        <button
          className="sync-btn secondary"
          onClick={handleReset}
          style={{ background: 'rgba(255,255,255,0.1)' }}
        >
          Reset to Default
        </button>
      </div>

      <p className="form-hint" style={{ marginTop: '0.75rem' }}>
        Default: 1920 x 1080. Changes apply on next restart.
      </p>
    </div>
  );
}

export function UITab({ settings, onSettingsChange }: UITabProps) {
  const [channelFontSize, setChannelFontSize] = useState(settings.channelFontSize || 14);
  const [categoryFontSize, setCategoryFontSize] = useState(settings.categoryFontSize || 14);
  const [showSidebar, setShowSidebar] = useState(settings.showSidebar ?? false);

  useEffect(() => {
    setChannelFontSize(settings.channelFontSize || 14);
    setCategoryFontSize(settings.categoryFontSize || 14);
    setShowSidebar(settings.showSidebar ?? false);
  }, [settings]);

  const handleChannelFontSizeChange = (size: number) => {
    setChannelFontSize(size);
    onSettingsChange({ ...settings, channelFontSize: size });

    // Apply immediately
    document.documentElement.style.setProperty('--channel-font-size', `${size}px`);
  };

  const handleCategoryFontSizeChange = (size: number) => {
    setCategoryFontSize(size);
    onSettingsChange({ ...settings, categoryFontSize: size });

    // Apply immediately
    document.documentElement.style.setProperty('--category-font-size', `${size}px`);
  };

  const handleShowSidebarChange = (show: boolean) => {
    setShowSidebar(show);
    onSettingsChange({ ...settings, showSidebar: show });
  };

  return (
    <div className="settings-tab-content">
      {/* Sidebar Visibility Section */}
      <div className="settings-section" style={{ paddingBottom: '8px' }}>
        <div className="section-header">
          <h3>Sidebar</h3>
        </div>

        {/* Table-style layout for toggles */}
        <div style={{ marginTop: '1rem' }}>
          {/* Show Sidebar Toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 0',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.95rem' }}>
                Show Left Sidebar Navigation
              </div>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                Display the sidebar with Guide, Movies, Series, and Settings buttons
              </div>
            </div>
            <input
              type="checkbox"
              checked={showSidebar}
              onChange={(e) => handleShowSidebarChange(e.target.checked)}
              style={{ cursor: 'pointer', marginLeft: '1rem' }}
            />
          </div>
        </div>
      </div>

      {/* Window Settings Section */}
      <div className="settings-section" style={{ paddingTop: '8px' }}>
        <div className="section-header">
          <h3>Window Settings</h3>
        </div>

        <p className="section-description" style={{ marginBottom: '12px' }}>
          Set the default window size when the application starts.
        </p>

        <WindowSizeSettings
          width={settings.startupWidth || 1920}
          height={settings.startupHeight || 1080}
          onChange={(w, h) => onSettingsChange({ ...settings, startupWidth: w, startupHeight: h })}
        />
      </div>

      {/* Font Size Section */}
      <div className="settings-section" style={{ paddingTop: '8px' }}>
        <div className="section-header">
          <h3>Font Size</h3>
        </div>

        <p className="section-description" style={{ marginBottom: '12px' }}>
          Adjust the font size for channel names and category labels to improve readability.
        </p>

        {/* Channel Font Size */}
        <div className="form-group" style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.9)' }}>Channel Font Size</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <input
              type="range"
              min="10"
              max="24"
              value={channelFontSize}
              onChange={(e) => handleChannelFontSizeChange(parseInt(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: '3rem', textAlign: 'right', color: 'rgba(255,255,255,0.8)' }}>
              {channelFontSize}px
            </span>
          </div>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            Preview: <span style={{ fontSize: `${channelFontSize}px`, color: '#00d4ff' }}>Channel Name Example</span>
          </p>
        </div>

        {/* Category Font Size */}
        <div className="form-group" style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.9)' }}>Category Font Size</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <input
              type="range"
              min="10"
              max="24"
              value={categoryFontSize}
              onChange={(e) => handleCategoryFontSizeChange(parseInt(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: '3rem', textAlign: 'right', color: 'rgba(255,255,255,0.8)' }}>
              {categoryFontSize}px
            </span>
          </div>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            Preview: <span style={{ fontSize: `${categoryFontSize}px`, color: '#00d4ff' }}>Category Name Example</span>
          </p>
        </div>

        {/* Reset Button */}
        <div style={{ marginTop: '16px' }}>
          <button
            className="sync-btn"
            onClick={() => {
              handleChannelFontSizeChange(14);
              handleCategoryFontSizeChange(14);
            }}
            style={{ maxWidth: '200px' }}
          >
            Reset to Default
          </button>
        </div>
      </div>
    </div>
  );
}
