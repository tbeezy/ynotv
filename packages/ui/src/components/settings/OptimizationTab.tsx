import { useState } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

export function OptimizationTab() {
  useTranslation();
  const hardwareAcceleration = useSettingsStore((s) => s.hardwareAcceleration);
  const setHardwareAcceleration = useSettingsStore((s) => s.setHardwareAcceleration);
  const disableThemeBackdropBlur = useSettingsStore((s) => s.disableThemeBackdropBlur);
  const setDisableThemeBackdropBlur = useSettingsStore((s) => s.setDisableThemeBackdropBlur);
  const epgLazyLoadingEnabled = useSettingsStore((s) => s.epgLazyLoadingEnabled);
  const setEpgLazyLoadingEnabled = useSettingsStore((s) => s.setEpgLazyLoadingEnabled);
  const disableEpgTransitions = useSettingsStore((s) => s.disableEpgTransitions);
  const setDisableEpgTransitions = useSettingsStore((s) => s.setDisableEpgTransitions);
  const epgReduceGpuLayers = useSettingsStore((s) => s.epgReduceGpuLayers);
  const setEpgReduceGpuLayers = useSettingsStore((s) => s.setEpgReduceGpuLayers);
  const epgDisableChannelFade = useSettingsStore((s) => s.epgDisableChannelFade);
  const setEpgDisableChannelFade = useSettingsStore((s) => s.setEpgDisableChannelFade);

  const [showRestartModal, setShowRestartModal] = useState(false);
  const [pendingHwAccel, setPendingHwAccel] = useState<boolean | null>(null);

  const handleHwAccelToggle = (newValue: boolean) => {
    setPendingHwAccel(newValue);
    setShowRestartModal(true);
  };

  const confirmRestart = async () => {
    if (pendingHwAccel !== null) {
      await setHardwareAcceleration(pendingHwAccel);
    }
    setShowRestartModal(false);
    try {
      await relaunch();
    } catch (e) {
      console.error('[OptimizationTab] Failed to relaunch app:', e);
    }
  };

  const confirmSaveWithoutRestart = async () => {
    if (pendingHwAccel !== null) {
      await setHardwareAcceleration(pendingHwAccel);
    }
    setShowRestartModal(false);
  };

  return (
    <div className="settings-tab-content">
      {/* Hardware Acceleration Section */}
      <div className="settings-section" style={{ paddingTop: '8px' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:optimization.title')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:optimization.description')}
        </p>

        <div className="tmdb-form" style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', maxWidth: '450px' }}>
              <input
                type="checkbox"
                checked={hardwareAcceleration}
                onChange={(e) => handleHwAccelToggle(e.target.checked)}
              />
              <span className="genre-name" style={{ fontWeight: 600, fontSize: '0.95rem' }}>{i18n.t('settings:optimization.enableGpu')}</span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:optimization.enableGpuHint')} <em style={{ color: 'var(--accent-color, #00d4ff)' }}>{i18n.t('settings:optimization.requiresRestart')}</em>
            </p>
          </div>
        </div>
      </div>

      {/* Theme Optimization Section */}
      <div className="settings-section" style={{ marginTop: '2rem' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:optimization.themeTitle')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:optimization.themeDescription')}
        </p>

        <div className="tmdb-form" style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', maxWidth: '450px' }}>
              <input
                type="checkbox"
                checked={disableThemeBackdropBlur}
                onChange={(e) => setDisableThemeBackdropBlur(e.target.checked)}
              />
              <span className="genre-name" style={{ fontWeight: 600, fontSize: '0.95rem' }}>{i18n.t('settings:optimization.disableBlur')}</span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:optimization.disableBlurHint')}
            </p>
          </div>
        </div>
      </div>

      {/* EPG Optimization Section */}
      <div className="settings-section" style={{ marginTop: '2rem' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:optimization.epgTitle')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:optimization.epgDescription')}
        </p>

        <div className="tmdb-form" style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', maxWidth: '450px' }}>
              <input
                type="checkbox"
                checked={epgLazyLoadingEnabled}
                onChange={(e) => setEpgLazyLoadingEnabled(e.target.checked)}
              />
              <span className="genre-name" style={{ fontWeight: 600, fontSize: '0.95rem' }}>{i18n.t('settings:optimization.enableLazy')}</span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:optimization.enableLazyHint')}
            </p>
          </div>

          <div>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', maxWidth: '450px' }}>
              <input
                type="checkbox"
                checked={disableEpgTransitions}
                onChange={(e) => setDisableEpgTransitions(e.target.checked)}
              />
              <span className="genre-name" style={{ fontWeight: 600, fontSize: '0.95rem' }}>{i18n.t('settings:optimization.disableTransitions')}</span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:optimization.disableTransitionsHint')}
            </p>
          </div>

          <div>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', maxWidth: '450px' }}>
              <input
                type="checkbox"
                checked={epgReduceGpuLayers}
                onChange={(e) => setEpgReduceGpuLayers(e.target.checked)}
              />
              <span className="genre-name" style={{ fontWeight: 600, fontSize: '0.95rem' }}>{i18n.t('settings:optimization.reduceGpuLayers')}</span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:optimization.reduceGpuLayersHint')}
            </p>
          </div>

          <div>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', maxWidth: '450px' }}>
              <input
                type="checkbox"
                checked={epgDisableChannelFade}
                onChange={(e) => setEpgDisableChannelFade(e.target.checked)}
              />
              <span className="genre-name" style={{ fontWeight: 600, fontSize: '0.95rem' }}>{i18n.t('settings:optimization.disableChannelFade')}</span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:optimization.disableChannelFadeHint')}
            </p>
          </div>
        </div>
      </div>

      {showRestartModal && (
        <div className="modal-overlay" onClick={() => setShowRestartModal(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{i18n.t('settings:optimization.restartTitle')}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-message">
                {i18n.t('settings:optimization.restartMessage')}
                <br /><br />
                {i18n.t('settings:optimization.restartQuestion')}
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn modal-btn-secondary" onClick={confirmSaveWithoutRestart}>
                {i18n.t('settings:optimization.saveOnly')}
              </button>
              <button className="modal-btn modal-btn-primary" onClick={confirmRestart}>
                {i18n.t('settings:optimization.restartNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
