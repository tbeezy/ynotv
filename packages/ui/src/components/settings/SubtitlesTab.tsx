import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import { validateSubSourceApiKey } from '../../services/subsource';
import { loginOpenSubtitles, logoutOpenSubtitles, OpenSubtitlesUser } from '../../services/opensubtitles';
import { Bridge } from '../../services/tauri-bridge';
import { useToastStore } from '../../stores/toastStore';
import { DEFAULT_SUBTITLE_SETTINGS } from '../../stores/settingsStore';
import './PlaybackTab.css'; // Reuse existing tab styles

export type SubtitlesSubTabId = 'subtitles' | 'audio';

export interface SubtitleSettings {
  subsourceApiKey: string;
  openSubtitlesToken?: string;
  openSubtitlesUser?: OpenSubtitlesUser;
  openSubtitlesUsername?: string;
  openSubtitlesPassword?: string;
  preferredProvider?: 'subsource' | 'opensubtitles';
  defaultLanguage: string;
  defaultAudioLanguage: string;
  defaultSize: number;
  subColor: string;
  subBackgroundColor: string;
  subBackgroundEnabled: boolean;
  subBackgroundOpacity: number;
  subOutlineColor: string;
  subDelay: number;
  subVerticalOffset: number;
  subAssOverride?: 'yes' | 'force' | 'scale' | 'no';
  subAlign?: 'center' | 'left' | 'right';
  audioDevice?: string;
}


const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'cs', label: 'Czech' },
  { code: 'el', label: 'Greek' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'he', label: 'Hebrew' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
];

interface SubtitlesTabProps {
  initialSubTab?: SubtitlesSubTabId;
  settings: SubtitleSettings;
  onSettingsChange: (settings: Partial<SubtitleSettings>) => void;
}

export function SubtitlesTab({ initialSubTab, settings, onSettingsChange }: SubtitlesTabProps) {
  useTranslation();
  const merged = { ...DEFAULT_SUBTITLE_SETTINGS, ...settings };
  const [localKey, setLocalKey] = useState(merged.subsourceApiKey);
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    setLocalKey(merged.subsourceApiKey);
    if (merged.subsourceApiKey) {
      setKeyValid(true); // assume valid if previously saved
    } else {
      setKeyValid(null);
    }
  }, [merged.subsourceApiKey]);

  const handleSaveKey = useCallback(async () => {
    if (!window.storage) return;
    setValidating(true);
    setKeyValid(null);

    const trimmed = localKey.trim();
    if (!trimmed) {
      // Empty key: just clear it (valid)
      setKeyValid(true);
      await window.storage.updateSettings({ subtitleSettings: { ...merged, subsourceApiKey: '' } });
      onSettingsChange({ subsourceApiKey: '' });
      setValidating(false);
      return;
    }

    const isValid = await validateSubSourceApiKey(trimmed);
    setKeyValid(isValid);

    if (isValid) {
      await window.storage.updateSettings({ subtitleSettings: { ...merged, subsourceApiKey: trimmed } });
      onSettingsChange({ subsourceApiKey: trimmed });
    }

    setValidating(false);
  }, [localKey, merged, onSettingsChange]);

  const update = useCallback(
    (partial: Partial<SubtitleSettings>) => {
      onSettingsChange(partial);
    },
    [onSettingsChange]
  );

  const [activeSubTab, setActiveSubTab] = useState<'subtitles' | 'audio'>('subtitles');
  const [devices, setDevices] = useState<{ name: string; description: string }[]>([]);

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const list = await Bridge.getProperty('audio-device-list');
        const data = list && typeof list === 'object' && 'data' in list ? list.data : list;
        const parsed = Array.isArray(data) ? data : [];
        const filtered = parsed.filter((d: any) => d && d.name && d.name !== 'auto');
        setDevices(filtered);
      } catch (e) {
        console.warn('[SubtitlesTab] Failed to fetch audio devices:', e);
      }
    };
    fetchDevices();
  }, []);

  const handleAudioDeviceChange = async (deviceName: string) => {
    update({ audioDevice: deviceName });
    try {
      await Bridge.setProperty('audio-device', deviceName);
    } catch (e) {
      console.error('Failed to set audio device on player:', e);
    }
  };

  const [osUsername, setOsUsername] = useState('');
  const [osPassword, setOsPassword] = useState('');
  const [osLoggingIn, setOsLoggingIn] = useState(false);
  const [osError, setOsError] = useState('');

  const handleOsLogin = useCallback(async () => {
    if (!osUsername.trim() || !osPassword) return;
    setOsLoggingIn(true);
    setOsError('');
    try {
      const res = await loginOpenSubtitles(osUsername, osPassword);
      if (res.success && res.token && res.user) {
        // Store password in OS Native Credential Store (Windows Credential Manager / Keychain)
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('save_opensubtitles_credentials', { username: osUsername.trim(), password: osPassword });
        } catch (err) {
          console.warn('[SubtitlesTab] Failed to save credentials to OS vault:', err);
        }

        const updated = {
          ...merged,
          openSubtitlesToken: res.token,
          openSubtitlesUser: res.user,
          openSubtitlesUsername: osUsername.trim(),
        };
        delete (updated as any).openSubtitlesPassword;

        if (window.storage) {
          await window.storage.updateSettings({ subtitleSettings: updated });
        }
        onSettingsChange({
          openSubtitlesToken: res.token,
          openSubtitlesUser: res.user,
          openSubtitlesUsername: osUsername.trim(),
        });
        setOsPassword('');
        useToastStore.getState().addToast(i18n.t('settings:subtitles.loggedInToast', { username: res.user.username }), 'success');
      } else {
        const err = translateNativeError(res.error) || i18n.t('common:loginFailed');
        setOsError(err);
        useToastStore.getState().addToast(err, 'error');
      }
    } catch (e: any) {
      const err = translateNativeError(e?.message) || i18n.t('common:loginFailed');
      setOsError(err);
      useToastStore.getState().addToast(err, 'error');
    } finally {
      setOsLoggingIn(false);
    }
  }, [osUsername, osPassword, merged, onSettingsChange]);

  const handleOsLogout = useCallback(async () => {
    if (merged.openSubtitlesToken) {
      logoutOpenSubtitles(merged.openSubtitlesToken).catch(console.error);
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_opensubtitles_credentials');
    } catch (err) {
      console.warn('[SubtitlesTab] Failed to delete credentials from OS vault:', err);
    }

    const updated = {
      ...merged,
      openSubtitlesToken: '',
      openSubtitlesUser: undefined,
      openSubtitlesUsername: '',
      preferredProvider: 'subsource' as const,
    };
    delete (updated as any).openSubtitlesPassword;

    if (window.storage) {
      await window.storage.updateSettings({ subtitleSettings: updated });
    }
    onSettingsChange({
      openSubtitlesToken: '',
      openSubtitlesUser: undefined,
      openSubtitlesUsername: '',
      preferredProvider: 'subsource',
    });
    setOsUsername('');
    setOsPassword('');
    setOsError('');
  }, [merged, onSettingsChange]);

  return (
    <div className="playback-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="settings-tabs" style={{ padding: '0 20px', flexShrink: 0 }}>
        <button
          className={`settings-tab ${activeSubTab === 'subtitles' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('subtitles')}
        >
          {i18n.t('settings:subtitles.tabs.subtitles')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'audio' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('audio')}
        >
          {i18n.t('settings:subtitles.tabs.audio')}
        </button>
      </div>

      <div className="settings-tab-content">

      {activeSubTab === 'subtitles' ? (
        <>
          {/* SubSource API Section */}
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:subtitles.subsourceIntegration')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.subsourceIntegrationSub')}
              <br />
              <a
                href="https://subsource.net/dashboard/profile"
                target="_blank"
                rel="noopener noreferrer"
                className="tmdb-link"
              >
                {i18n.t('settings:subtitles.getApiKey')}
              </a>
            </p>

            <div className="tmdb-form">
              <div className="form-group inline">
                <label>{i18n.t('settings:subtitles.apiKey')}</label>
                <input
                  type="password"
                  value={localKey}
                  onChange={(e) => {
                    setLocalKey(e.target.value);
                    setKeyValid(null);
                  }}
                  placeholder={i18n.t('settings:subtitles.apiKeyPlaceholder')}
                />
                <button
                  type="button"
                  onClick={handleSaveKey}
                  disabled={validating}
                  className={keyValid === true ? 'success' : keyValid === false ? 'error' : ''}
                >
                  {validating ? i18n.t('settings:subtitles.validating') : keyValid === true ? i18n.t('settings:subtitles.valid') : keyValid === false ? i18n.t('settings:subtitles.invalid') : i18n.t('common:save')}
                </button>
              </div>
            </div>
          </div>

          {/* OpenSubtitles Integration Section */}
          <div className="settings-section" style={{ marginTop: '2rem' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:subtitles.openSubtitlesIntegration')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.osIntegrationSub')}
              <br />
              <a
                href="https://www.opensubtitles.com/en/users/sign_up"
                target="_blank"
                rel="noopener noreferrer"
                className="tmdb-link"
              >
                {i18n.t('settings:subtitles.createOsAccount')}
              </a>
            </p>

            {merged.openSubtitlesToken && merged.openSubtitlesUser ? (
              <div className="tmdb-form">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface-color)', padding: '12px 16px', borderRadius: '8px' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                      {i18n.t('settings:subtitles.loggedInAs', { username: merged.openSubtitlesUser.username })}
                      {merged.openSubtitlesUser.vip && <span style={{ marginLeft: '8px', background: 'var(--accent-color, #e50914)', color: 'var(--text-primary)', fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase' }}>VIP</span>}
                      {merged.openSubtitlesUser.level && <span style={{ marginLeft: '8px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>({merged.openSubtitlesUser.level})</span>}
                    </div>
                    {merged.openSubtitlesUser.allowed_downloads !== undefined && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                        {i18n.t('settings:subtitles.allowedDownloads', { count: merged.openSubtitlesUser.allowed_downloads })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleOsLogout}
                    style={{ background: '#e53e3e', color: 'var(--text-primary)', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                  >
                    {i18n.t('common:logout')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="tmdb-form" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="form-group inline">
                  <label>{i18n.t('settings:subtitles.username')}</label>
                  <input
                    type="text"
                    value={osUsername}
                    onChange={(e) => { setOsUsername(e.target.value); setOsError(''); }}
                    placeholder={i18n.t('settings:subtitles.osUsernamePlaceholder')}
                  />
                </div>
                <div className="form-group inline">
                  <label>{i18n.t('settings:subtitles.password')}</label>
                  <input
                    type="password"
                    value={osPassword}
                    onChange={(e) => { setOsPassword(e.target.value); setOsError(''); }}
                    placeholder={i18n.t('settings:subtitles.osPasswordPlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={handleOsLogin}
                    disabled={osLoggingIn || !osUsername.trim() || !osPassword}
                    className="success"
                  >
                    {osLoggingIn ? i18n.t('settings:subtitles.loggingIn') : i18n.t('common:login')}
                  </button>
                </div>
                {osError && (
                  <div style={{ color: '#e53e3e', fontSize: '0.85rem', marginTop: '4px' }}>
                    {osError}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Default Subtitle Provider Section */}
          <div className="settings-section" style={{ marginTop: '2rem' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:subtitles.defaultProvider')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.defaultProviderSub')}
            </p>

            <div className="timeshift-settings">
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.preferredProvider')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:subtitles.preferredProviderSub')}
                  </span>
                </div>
                <div className="timeshift-retention-select">
                  <select
                    value={merged.preferredProvider || 'subsource'}
                    onChange={async (e) => {
                      const val = e.target.value as 'subsource' | 'opensubtitles';
                      const updated = { ...merged, preferredProvider: val };
                      if (window.storage) {
                        await window.storage.updateSettings({ subtitleSettings: updated });
                      }
                      onSettingsChange({ preferredProvider: val });
                      useToastStore.getState().addToast(i18n.t('settings:subtitles.providerSetToast', { provider: val === 'opensubtitles' ? 'OpenSubtitles' : 'SubSource' }), 'success');
                    }}
                    style={{
                      background: 'var(--surface-color)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--surface-border)',
                      borderRadius: '6px',
                      padding: '6px 12px',
                      fontSize: '0.9rem',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="subsource" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>
                      SubSource {!merged.subsourceApiKey ? i18n.t('settings:subtitles.notConfigured') : ''}
                    </option>
                    <option
                      value="opensubtitles"
                      disabled={!merged.openSubtitlesToken}
                      style={{ background: 'var(--surface-color)', color: !merged.openSubtitlesToken ? '#888' : 'var(--text-primary)' }}
                    >
                      OpenSubtitles {!merged.openSubtitlesToken ? i18n.t('settings:subtitles.requiresLogin') : ''}
                    </option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Default Appearance Section */}
          <div className="settings-section" style={{ marginTop: '2rem' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:subtitles.defaultAppearance')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.defaultAppearanceSub')}
            </p>

            <div className="timeshift-settings">
              {/* Default Language */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.defaultLanguage')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.defaultLanguageSub')}</span>
                </div>
                <select
                  value={merged.defaultLanguage}
                  onChange={(e) => update({ defaultLanguage: e.target.value })}
                >
                  <option value="off">{i18n.t('common:off')}</option>
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Default Size */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.defaultSize')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.defaultSizeSub')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: '200px', justifyContent: 'flex-end' }}>
                  <input
                    type="range"
                    min="10"
                    max="80"
                    value={merged.defaultSize}
                    onChange={(e) => update({ defaultSize: parseInt(e.target.value) })}
                    style={{ width: '140px' }}
                  />
                  <span style={{ minWidth: '32px', textAlign: 'right', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {merged.defaultSize}
                  </span>
                </div>
              </div>

              {/* Vertical Position */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.verticalPosition')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.verticalPositionSub')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: '200px', justifyContent: 'flex-end' }}>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={merged.subVerticalOffset ?? 90}
                    onChange={(e) => update({ subVerticalOffset: parseInt(e.target.value) })}
                    style={{ width: '140px' }}
                  />
                  <span style={{ minWidth: '32px', textAlign: 'right', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {merged.subVerticalOffset ?? 90}%
                  </span>
                </div>
              </div>

              {/* Override Embedded Styles */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.overrideEmbedded')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.overrideEmbeddedSub')}</span>
                </div>
                <select
                  value={merged.subAssOverride || 'yes'}
                  onChange={(e) => update({ subAssOverride: e.target.value as any })}
                >
                  <option value="yes">{i18n.t('settings:subtitles.yesApply')}</option>
                  <option value="force">{i18n.t('settings:subtitles.forceAll')}</option>
                  <option value="scale">{i18n.t('settings:subtitles.scaleOnly')}</option>
                  <option value="no">{i18n.t('settings:subtitles.noKeep')}</option>
                </select>
              </div>

              {/* Subtitle Color */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.textColor')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.textColorSub')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="color"
                    value={merged.subColor}
                    onChange={(e) => update({ subColor: e.target.value })}
                    style={{ width: '40px', height: '32px', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {merged.subColor}
                  </span>
                </div>
              </div>

              {/* Background Color */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.background')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.backgroundSub')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={merged.subBackgroundEnabled}
                      onChange={(e) => update({ subBackgroundEnabled: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>

              {merged.subBackgroundEnabled && (
                <>
                  <div className="timeshift-toggle-row">
                    <div className="timeshift-toggle-info">
                      <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.backgroundColor')}</span>
                      <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.backgroundColorSub')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="color"
                        value={merged.subBackgroundColor}
                        onChange={(e) => update({ subBackgroundColor: e.target.value })}
                        style={{ width: '40px', height: '32px', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                      />
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                        {merged.subBackgroundColor}
                      </span>
                    </div>
                  </div>
                  <div className="timeshift-toggle-row">
                    <div className="timeshift-toggle-info">
                      <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.bgOpacity')}</span>
                      <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.bgOpacitySub')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: '200px', justifyContent: 'flex-end' }}>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={merged.subBackgroundOpacity ?? 80}
                        onChange={(e) => update({ subBackgroundOpacity: parseInt(e.target.value) })}
                        style={{ width: '140px' }}
                      />
                      <span style={{ minWidth: '32px', textAlign: 'right', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        {merged.subBackgroundOpacity ?? 80}%
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* Outline Color */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.outlineColor')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.outlineColorSub')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="color"
                    value={merged.subOutlineColor}
                    onChange={(e) => update({ subOutlineColor: e.target.value })}
                    style={{ width: '40px', height: '32px', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {merged.subOutlineColor}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Preview Section */}
          <div className="settings-section" style={{ marginTop: '2rem' }}>
            <div className="section-header">
              <h3>{i18n.t('common:preview')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.previewSub')}
            </p>

            <div
              style={{
                marginTop: '16px',
                padding: '40px 24px',
                background: '#1a1a1a',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
                minHeight: '160px',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {/* Fake video background */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%)',
                  opacity: 0.6,
                }}
              />
              <div
                style={{
                  position: 'relative',
                  zIndex: 1,
                  textAlign: 'center',
                }}
              >
                <span
                  style={{
                    fontSize: `${merged.defaultSize}px`,
                    color: merged.subColor,
                    backgroundColor: merged.subBackgroundEnabled 
                      ? merged.subBackgroundColor + Math.round((merged.subBackgroundOpacity ?? 80) / 100 * 255).toString(16).padStart(2, '0').toUpperCase()
                      : 'transparent',
                    padding: '4px 12px',
                    borderRadius: '4px',
                    fontFamily: "'Arial', sans-serif",
                    fontWeight: 500,
                    lineHeight: 1.4,
                    textShadow: `0 0 2px ${merged.subOutlineColor}, 0 0 4px ${merged.subOutlineColor}`,
                    display: 'inline-block',
                  }}
                >
                  {i18n.t('settings:subtitles.previewSample')}
                </span>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Default Audio Language */}
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:subtitles.audioLanguageSettings')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.audioLanguageSettingsSub')}
            </p>

            <div className="timeshift-settings">
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.defaultAudioLanguage')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.defaultAudioLanguageSub')}</span>
                </div>
                <select
                  value={merged.defaultAudioLanguage || 'default'}
                  onChange={(e) => update({ defaultAudioLanguage: e.target.value })}
                >
                  <option value="default">{i18n.t('common:default')}</option>
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Audio Output Device */}
          <div className="settings-section" style={{ marginTop: '2rem' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:subtitles.audioOutputDevice')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:subtitles.audioOutputDeviceSub')}
            </p>

            <div className="timeshift-settings">
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:subtitles.audioDevice')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:subtitles.audioDeviceSub')}</span>
                </div>
                <select
                  value={merged.audioDevice || 'auto'}
                  onChange={(e) => handleAudioDeviceChange(e.target.value)}
                >
                  <option value="auto">{i18n.t('settings:subtitles.defaultAutoselect')}</option>
                  {devices.map((dev) => (
                    <option key={dev.name} value={dev.name}>
                      {dev.description || dev.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
