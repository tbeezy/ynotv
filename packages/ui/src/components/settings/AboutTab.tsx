import { checkForUpdates } from '../../services/updater';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useState, useEffect } from 'react';
import './PlaybackTab.css'; // Reuse existing tab styles
import './AboutTab.css';
import changelogContent from '@root/CHANGELOG.md?raw';

export function AboutTab() {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(''));
  }, []);

  const handleCheckForUpdates = () => {
    checkForUpdates();
  };

  const openLink = async (url: string) => {
    try {
      await invoke('open_external_url', { url });
    } catch (e) {
      console.error('[About] Failed to open URL:', e);
      // Fallback: open in new tab
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>About ynoTV</h3>
        </div>

        <div className="about-content" style={{ padding: '16px 0' }}>
          <div className="about-row" style={{ marginBottom: '16px' }}>
            <span className="about-label" style={{ fontWeight: 500 }}>Version:</span>
            <span className="about-value">{version || 'Loading...'}</span>
          </div>

          <div className="about-links" style={{ marginBottom: '24px', display: 'flex', gap: '16px' }}>
            <button
              className="sync-btn"
              onClick={() => openLink('https://github.com/tbeezy/ynotv')}
              style={{ maxWidth: '140px' }}
            >
              GitHub
            </button>
            <button
              className="sync-btn"
              onClick={() => openLink('https://tbeezy.github.io/ynotvdoc/')}
              style={{ maxWidth: '140px' }}
            >
              Documentation
            </button>
          </div>

          <div className="about-section" style={{ marginTop: '24px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '24px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>Updates</h4>
            <p style={{ margin: '0 0 16px 0', color: 'rgba(255,255,255,0.7)', fontSize: '0.875rem' }}>
              Check for new versions of ynoTV. Updates include bug fixes, performance improvements, and new features.
            </p>

            <button
              className="sync-btn"
              onClick={handleCheckForUpdates}
              style={{ maxWidth: '200px' }}
            >
              Check for Updates
            </button>
          </div>

          <div className="about-section" style={{ marginTop: '24px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '24px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>Changelog</h4>
            <pre
              className="changelog-content"
              style={{
                margin: '0',
                padding: '12px',
                backgroundColor: 'rgba(0,0,0,0.3)',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.85)',
                fontSize: '0.8125rem',
                lineHeight: '1.5',
                maxHeight: '300px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
                fontFamily: 'inherit'
              }}
            >
              {changelogContent}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
