import { useState } from 'react';
import { validateAccessToken } from '../../services/tmdb';
import { validateRpdbApiKey, getRpdbTier, rpdbSupportsBackdrops } from '../../services/rpdb';

interface TmdbTabProps {
  tmdbApiKey: string;
  tmdbKeyValid: boolean | null;
  onApiKeyChange: (key: string) => void;
  onApiKeyValidChange: (valid: boolean | null) => void;
  rpdbApiKey: string;
  rpdbKeyValid: boolean | null;
  onRpdbApiKeyChange: (key: string) => void;
  onRpdbKeyValidChange: (valid: boolean | null) => void;
  rpdbBackdropsEnabled: boolean;
  onRpdbBackdropsEnabledChange: (enabled: boolean) => void;
}

export function TmdbTab({
  tmdbApiKey,
  tmdbKeyValid,
  onApiKeyChange,
  onApiKeyValidChange,
  rpdbApiKey,
  rpdbKeyValid,
  onRpdbApiKeyChange,
  onRpdbKeyValidChange,
  rpdbBackdropsEnabled,
  onRpdbBackdropsEnabledChange,
}: TmdbTabProps) {
  const [tmdbValidating, setTmdbValidating] = useState(false);
  const [rpdbValidating, setRpdbValidating] = useState(false);

  const tier = getRpdbTier(rpdbApiKey);
  const supportsBackdrops = rpdbSupportsBackdrops(rpdbApiKey);

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

  async function saveRpdbApiKey() {
    if (!window.storage) return;
    setRpdbValidating(true);
    onRpdbKeyValidChange(null);

    // Validate the key first
    const isValid = rpdbApiKey ? await validateRpdbApiKey(rpdbApiKey) : true;
    onRpdbKeyValidChange(isValid);

    if (isValid) {
      await window.storage.updateSettings({ posterDbApiKey: rpdbApiKey });
    }

    setRpdbValidating(false);
  }

  async function handleBackdropsToggle(enabled: boolean) {
    if (!window.storage) return;
    onRpdbBackdropsEnabledChange(enabled);
    await window.storage.updateSettings({ rpdbBackdropsEnabled: enabled });
  }

  return (
    <div className="settings-tab-content">
      {/* TMDB Section */}
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
      </div>

      {/* RPDB Section */}
      <div className="settings-section" style={{ marginTop: '2rem' }}>
        <div className="section-header">
          <h3>RatingPosterDB Integration</h3>
          {tier && rpdbKeyValid && (
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
              value={rpdbApiKey}
              onChange={(e) => {
                onRpdbApiKeyChange(e.target.value);
                onRpdbKeyValidChange(null);
              }}
              placeholder="Enter your RPDB API key"
            />
            <button
              type="button"
              onClick={saveRpdbApiKey}
              disabled={rpdbValidating}
              className={rpdbKeyValid === true ? 'success' : rpdbKeyValid === false ? 'error' : ''}
            >
              {rpdbValidating ? 'Validating...' : rpdbKeyValid === true ? 'Valid' : rpdbKeyValid === false ? 'Invalid' : 'Save'}
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
        {rpdbKeyValid && (
          <div className="tmdb-form" style={{ marginTop: '1.5rem' }}>
            <label
              className="genre-checkbox"
              style={{ maxWidth: '280px' }}
            >
              <input
                type="checkbox"
                checked={rpdbBackdropsEnabled && supportsBackdrops}
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
        This product uses the TMDB API but is not endorsed or certified by TMDB.
        <br />
        RPDB is a third-party service. Visit{' '}
        <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer" className="tmdb-link">
          ratingposterdb.com
        </a>{' '}
        for pricing and features.
      </p>
    </div>
  );
}
