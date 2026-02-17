import { useState } from 'react';
import { validateAccessToken } from '../../services/tmdb';
import { clearExportCache } from '../../services/tmdb-exports';
import { enrichSourceMetadata } from '../../db/sync';

interface TmdbTabProps {
  tmdbApiKey: string;
  tmdbKeyValid: boolean | null;
  onApiKeyChange: (key: string) => void;
  onApiKeyValidChange: (valid: boolean | null) => void;
  tmdbMatchingEnabled: boolean;
  onTmdbMatchingEnabledChange: (enabled: boolean) => void;
}

export function TmdbTab({
  tmdbApiKey,
  tmdbKeyValid,
  onApiKeyChange,
  onApiKeyValidChange,
  tmdbMatchingEnabled,
  onTmdbMatchingEnabledChange,
}: TmdbTabProps) {
  const [tmdbValidating, setTmdbValidating] = useState(false);
  const [matchingStatus, setMatchingStatus] = useState<'idle' | 'matching' | 'done'>('idle');
  const [matchCount, setMatchCount] = useState<{movies: number, series: number}>({movies: 0, series: 0});

  async function handleToggleMatching(enabled: boolean) {
    onTmdbMatchingEnabledChange(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ tmdbMatchingEnabled: enabled });
    }
  }

  async function forceTmdbMatching() {
    setMatchingStatus('matching');
    setMatchCount({movies: 0, series: 0});
    
    try {
      // Get all enabled sources
      if (!window.storage) return;
      const sourcesResult = await window.storage.getSources();
      const enabledSources = sourcesResult.data?.filter(s => s.enabled) || [];
      
      let totalMovies = 0;
      let totalSeries = 0;
      
      // Match each source
      for (const source of enabledSources) {
        console.log(`[TMDB Force Match] Starting match for ${source.name}...`);
        enrichSourceMetadata(source, true); // Force = true
      }
      
      // Note: We can't easily get the exact counts since matching is async,
      // but we can show that matching has been triggered
      setMatchingStatus('done');
      
      // Reset status after 5 seconds
      setTimeout(() => {
        setMatchingStatus('idle');
      }, 5000);
      
    } catch (error) {
      console.error('[TMDB Force Match] Error:', error);
      setMatchingStatus('idle');
    }
  }

  async function saveTmdbApiKey() {
    if (!window.storage) return;
    setTmdbValidating(true);
    onApiKeyValidChange(null);

    // Validate the key first
    const isValid = tmdbApiKey ? await validateAccessToken(tmdbApiKey) : true;
    onApiKeyValidChange(isValid);

    if (isValid) {
      await window.storage.updateSettings({ tmdbApiKey });
    }

    setTmdbValidating(false);
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>TMDB Integration</h3>
        </div>

        <p className="section-description">
          Basic TMDB integration is automatic. An Access Token enables enhancements like
          filling in missing metadata from your provider and higher quality backdrop images.
          Use the token labeled "API Read Access Token"{' '}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" className="tmdb-link">
            from here
          </a>.
        </p>

        <div className="tmdb-form">
          <div className="form-group inline">
            <label>Access Token</label>
            <input
              type="password"
              value={tmdbApiKey}
              onChange={(e) => {
                onApiKeyChange(e.target.value);
                onApiKeyValidChange(null);
              }}
              placeholder="API Read Access Token"
            />
            <button
              type="button"
              onClick={saveTmdbApiKey}
              disabled={tmdbValidating}
              className={tmdbKeyValid === true ? 'success' : tmdbKeyValid === false ? 'error' : ''}
            >
              {tmdbValidating ? 'Validating...' : tmdbKeyValid === true ? 'Valid' : tmdbKeyValid === false ? 'Invalid' : 'Save'}
            </button>
          </div>
          <p className="form-hint">
            Get a free account at{' '}
            <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener noreferrer">
              themoviedb.org
            </a>
          </p>
        </div>

        <div className="settings-section-divider"></div>

        <div className="section-header">
          <h3>Advanced Features</h3>
        </div>

        <div className="form-group inline-checkbox">
          <label className="checkbox-container">
            <input
              type="checkbox"
              checked={tmdbMatchingEnabled}
              onChange={(e) => handleToggleMatching(e.target.checked)}
            />
            <span className="checkmark"></span>
            <div className="checkbox-label">
              <span>Enable Automatic Metadata Matching</span>
              <p className="checkbox-description">
                Automatically download enriched metadata and match unmatched content on startup.
                Disable this if you want faster startup times or lower bandwidth usage.
              </p>
            </div>
          </label>
        </div>

        <div className="settings-section-divider"></div>

        <div className="section-header">
          <h3>Manual Matching</h3>
        </div>

        <div className="form-group">
          <button
            type="button"
            onClick={forceTmdbMatching}
            disabled={matchingStatus === 'matching'}
            className="sync-btn"
          >
            {matchingStatus === 'matching' ? 'Matching in Progress...' : 
             matchingStatus === 'done' ? 'Matching Triggered! Check Console' : 
             'Force TMDB Matching Now'}
          </button>
          <p className="form-hint">
            Manually trigger TMDB matching for all enabled sources. This will match your VOD content 
            with TMDB data to enable Trending/Popular lists. Check the browser console for progress.
          </p>
        </div>

        <div className="form-group">
          <button
            type="button"
            onClick={() => {
              clearExportCache();
              alert('TMDB export cache cleared! Next sync will download fresh data.');
            }}
            className="sync-btn"
          >
            Clear TMDB Export Cache
          </button>
          <p className="form-hint">
            Clear cached TMDB export data and force a fresh download. Use this if matching rates are 
            unexpectedly low or if you suspect the cached data is outdated.
          </p>
        </div>

      </div>

      <p className="settings-disclaimer">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>
    </div>
  );
}
