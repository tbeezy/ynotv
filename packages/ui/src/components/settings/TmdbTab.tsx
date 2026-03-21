import { useState } from 'react';
import { validateAccessToken } from '../../services/tmdb';
import { enrichSourceMetadata } from '../../db/sync';

interface TmdbTabProps {
  tmdbApiKey: string;
  tmdbKeyValid: boolean | null;
  onApiKeyChange: (key: string) => void;
  onApiKeyValidChange: (valid: boolean | null) => void;
}

export function TmdbTab({
  tmdbApiKey,
  tmdbKeyValid,
  onApiKeyChange,
  onApiKeyValidChange,
}: TmdbTabProps) {
  const [tmdbValidating, setTmdbValidating] = useState(false);

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

      </div>

      <p className="settings-disclaimer">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>
    </div>
  );
}
