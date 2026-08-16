import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface SecurityTabProps {
  allowLanSources: boolean;
  onAllowLanSourcesChange: (enabled: boolean) => void;
}

export function SecurityTab({
  allowLanSources,
  onAllowLanSourcesChange,
}: SecurityTabProps) {
  useTranslation();
  function handleAllowLanChange(enabled: boolean) {
    // allowLanSources lives in the settings store — Settings.tsx routes this
    // through the store setter (which persists); this tab only reports the
    // change upward.
    onAllowLanSourcesChange(enabled);
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:security.title')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:security.description')}
        </p>

        <div className="tmdb-form" style={{ marginTop: '1rem' }}>
          <label className="genre-checkbox" style={{ maxWidth: '320px' }}>
            <input
              type="checkbox"
              checked={allowLanSources}
              onChange={(e) => handleAllowLanChange(e.target.checked)}
            />
            <span className="genre-name">{i18n.t('settings:security.allowLan')}</span>
          </label>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            {i18n.t('settings:security.allowLanHint')}
          </p>
        </div>
      </div>

      <p className="settings-disclaimer">
        {i18n.t('settings:security.disclaimer')}
      </p>
    </div>
  );
}
