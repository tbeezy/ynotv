import { useState } from 'react';
import { validateRpdbApiKey, getRpdbTier, rpdbSupportsBackdrops } from '../../services/rpdb';

interface PosterDbTabProps {
  apiKey: string;
  apiKeyValid: boolean | null;
  onApiKeyChange: (key: string) => void;
  onApiKeyValidChange: (valid: boolean | null) => void;
  backdropsEnabled: boolean;
  onBackdropsEnabledChange: (enabled: boolean) => void;
}

export function PosterDbTab({
  apiKey,
  apiKeyValid,
  onApiKeyChange,
  onApiKeyValidChange,
  backdropsEnabled,
  onBackdropsEnabledChange,
}: PosterDbTabProps) {
  const [validating, setValidating] = useState(false);

  const tier = getRpdbTier(apiKey);
  const supportsBackdrops = rpdbSupportsBackdrops(apiKey);

  async function saveApiKey() {
    if (!window.storage) return;
    setValidating(true);
    onApiKeyValidChange(null);

    // Validate the key first
    const isValid = apiKey ? await validateRpdbApiKey(apiKey) : true;
    onApiKeyValidChange(isValid);

    if (isValid) {
      await window.storage.updateSettings({ posterDbApiKey: apiKey });
    }

    setValidating(false);
  }

  async function handleBackdropsToggle(enabled: boolean) {
    if (!window.storage) return;
    onBackdropsEnabledChange(enabled);
    await window.storage.updateSettings({ rpdbBackdropsEnabled: enabled });
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>RatingPosterDB Integration</h3>
          {tier && apiKeyValid && (
            <span className="tier-badge">Tier {tier}</span>
          )}
        </div>

        <p className="section-description">
          RatingPosterDB overlays rating badges (IMDb, Rotten Tomatoes, etc.) on movie
          and series posters. Configure your badge preferences at{' '}
          <a
            href="https://manager.ratingposterdb.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="tmdb-link"
          >
            manager.ratingposterdb.com
          </a>
          .
        </p>

        <div className="tmdb-form">
          <div className="form-group inline">
            <label>API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                onApiKeyChange(e.target.value);
                onApiKeyValidChange(null);
              }}
              placeholder="Enter your RPDB API key"
            />
            <button
              type="button"
              onClick={saveApiKey}
              disabled={validating}
              className={apiKeyValid === true ? 'success' : apiKeyValid === false ? 'error' : ''}
            >
              {validating ? 'Validating...' : apiKeyValid === true ? 'Valid' : apiKeyValid === false ? 'Invalid' : 'Save'}
            </button>
          </div>
          <p className="form-hint">
            Get an API key by subscribing at{' '}
            <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer">
              ratingposterdb.com
            </a>
          </p>
        </div>

        {/* Backdrops option - only show if key is valid */}
        {apiKeyValid && (
          <div className="tmdb-form" style={{ marginTop: '1.5rem' }}>
            <label
              className="genre-checkbox"
              style={{ maxWidth: '280px' }}
            >
              <input
                type="checkbox"
                checked={backdropsEnabled && supportsBackdrops}
                onChange={(e) => handleBackdropsToggle(e.target.checked)}
                disabled={!supportsBackdrops}
              />
              <span className="genre-name">Use RPDB backdrop images</span>
            </label>
            {!supportsBackdrops && (
              <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                Backdrops require a Tier 2+ subscription
              </p>
            )}
          </div>
        )}
      </div>

      <p className="settings-disclaimer">
        RPDB is a third-party service. Visit{' '}
        <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer" className="tmdb-link">
          ratingposterdb.com
        </a>{' '}
        for pricing and features.
      </p>
    </div>
  );
}
