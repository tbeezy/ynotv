import { useState } from 'react';
import { validateRpdbApiKey, getRpdbTier, rpdbSupportsBackdrops } from '../../services/rpdb';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';

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
  useTranslation();
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
      useSettingsStore.getState().setPosterDbApiKey(apiKey);
    }

    setValidating(false);
  }

  async function handleBackdropsToggle(enabled: boolean) {
    if (!window.storage) return;
    onBackdropsEnabledChange(enabled);
    useSettingsStore.getState().setRpdbBackdropsEnabled(enabled);
  }

  return (
    <div>
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:posterdb.integration')}</h3>
          {tier != null && apiKeyValid === true && (
            <span className="tier-badge">{i18n.t('settings:posterdb.tier', { tier })}</span>
          )}
        </div>

        <p className="section-description">
          {i18n.t('settings:posterdb.integrationSub')}{' '}
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
            <label>{i18n.t('settings:posterdb.apiKey')}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                onApiKeyChange(e.target.value);
                onApiKeyValidChange(null);
              }}
              placeholder={i18n.t('settings:posterdb.apiKeyPlaceholder')}
            />
            <button
              type="button"
              onClick={saveApiKey}
              disabled={validating}
              className={apiKeyValid === true ? 'success' : apiKeyValid === false ? 'error' : ''}
            >
              {validating ? i18n.t('settings:posterdb.validating') : apiKeyValid === true ? i18n.t('settings:posterdb.valid') : apiKeyValid === false ? i18n.t('settings:posterdb.invalid') : i18n.t('common:save')}
            </button>
          </div>
          <p className="form-hint">
            {i18n.t('settings:posterdb.getApiKeyHint')}{' '}
            <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer">
              ratingposterdb.com
            </a>
          </p>
        </div>

        {/* Backdrops option - only show if key is valid */}
        {apiKeyValid === true && (
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
              <span className="genre-name">{i18n.t('settings:posterdb.useBackdrops')}</span>
            </label>
            {!supportsBackdrops && (
              <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                {i18n.t('settings:posterdb.backdropsTierHint')}
              </p>
            )}
          </div>
        )}
      </div>

      <p className="settings-disclaimer">
        {i18n.t('settings:posterdb.disclaimer')}{' '}
        <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer" className="tmdb-link">
          ratingposterdb.com
        </a>{' '}
        {i18n.t('settings:posterdb.disclaimerSub')}
      </p>
    </div>
  );
}
