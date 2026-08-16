import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { getScrobblerCredentialStatus, scrobbler } from '../../services/scrobbler';
import { TraktCatalogsModal } from './TraktCatalogsModal';
import { useSettingsStore } from '../../stores/settingsStore';
import '../Modal.css';
import './PlaybackTab.css';

export function ScrobblingTab() {
  useTranslation();
  const traktScrobbleEnabled = useSettingsStore((s) => s.traktScrobbleEnabled);
  const traktAccessToken = useSettingsStore((s) => s.traktAccessToken);
  const setTraktSettings = useSettingsStore((s) => s.setTraktSettings);
  const traktLinked = !!traktAccessToken;

  const credentialStatus = getScrobblerCredentialStatus();

  const [traktAuthState, setTraktAuthState] = useState<'idle' | 'polling' | 'success' | 'error'>('idle');
  const [traktUserCode, setTraktUserCode] = useState('');
  const [traktVerificationUrl, setTraktVerificationUrl] = useState('');
  const [traktExpiresIn, setTraktExpiresIn] = useState(0);

  const [activeModalType, setActiveModalType] = useState<'strem' | 'nuvio' | null>(null);

  const traktPollTimer = useRef<any>(null);
  const traktCountdownTimer = useRef<any>(null);

  useEffect(() => {
    return () => {
      clearTraktTimers();
    };
  }, []);

  const clearTraktTimers = () => {
    if (traktPollTimer.current) clearInterval(traktPollTimer.current);
    if (traktCountdownTimer.current) clearInterval(traktCountdownTimer.current);
  };

  const handleSettingUpdate = (update: any) => {
    // Settings live in the store — the setter persists through the write queue.
    setTraktSettings(update);
  };

  const startTraktLink = async () => {
    clearTraktTimers();
    setTraktAuthState('idle');
    try {
      const codeData = await scrobbler.generateTraktDeviceCode();
      setTraktUserCode(codeData.user_code);
      setTraktVerificationUrl(codeData.verification_url);
      setTraktExpiresIn(codeData.expires_in);
      setTraktAuthState('polling');

      let timeLeft = codeData.expires_in;
      traktCountdownTimer.current = setInterval(() => {
        timeLeft -= 1;
        setTraktExpiresIn(timeLeft);
        if (timeLeft <= 0) {
          clearTraktTimers();
          setTraktAuthState('error');
        }
      }, 1000);

      const intervalSec = codeData.interval || 5;
      traktPollTimer.current = setInterval(async () => {
        try {
          const pollRes = await scrobbler.pollTraktToken(codeData.device_code);
          if (pollRes.success) {
            clearTraktTimers();
            setTraktAuthState('success');
            setTimeout(() => {
              setTraktAuthState('idle');
            }, 2000);
          } else if (pollRes.error) {
            clearTraktTimers();
            setTraktAuthState('error');
          }
        } catch (e) {
          console.error('Trakt polling failed:', e);
        }
      }, intervalSec * 1000);

    } catch (e) {
      console.error('Failed to link Trakt:', e);
      setTraktAuthState('error');
    }
  };

  const cancelTraktLink = () => {
    clearTraktTimers();
    setTraktAuthState('idle');
  };

  const handleTraktUnlink = async () => {
    if (confirm(i18n.t('settings:scrobbling.disconnectConfirm'))) {
      await scrobbler.logoutTrakt();
      // Store selectors re-render automatically on logout
    }
  };

  const handleCopyCode = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const openCatalogModal = () => {
    setActiveModalType('strem');
  };

  const openNuvioCatalogModal = () => {
    setActiveModalType('nuvio');
  };

  const authContainerStyle: CSSProperties = {
    marginTop: '16px',
    padding: '16px',
    background: 'var(--bg-tertiary)',
    borderRadius: '8px',
    border: '1px solid var(--surface-border)',
  };

  const pinCodeStyle: React.CSSProperties = {
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: '2.2rem',
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: 'var(--text-primary)',
    textAlign: 'center',
    padding: '12px 24px',
    background: 'var(--surface-color)',
    border: '1px dashed var(--surface-border)',
    borderRadius: '8px',
    cursor: 'pointer',
    marginBottom: '12px',
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:scrobbling.title')}</h3>
          <span style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '3px 8px',
            borderRadius: '4px',
            color: traktLinked ? '#2ed573' : 'var(--text-muted)',
            background: traktLinked ? 'rgba(46,213,115,0.1)' : 'var(--surface-color)',
          }}>
            {traktLinked ? i18n.t('settings:scrobbling.connected') : i18n.t('settings:scrobbling.notConnected')}
          </span>
        </div>

        <p className="section-description">
          {i18n.t('settings:scrobbling.description')}
        </p>

        {!traktLinked ? (
          <div>
            {traktAuthState === 'idle' && (
              <button
                className="sync-btn"
                onClick={startTraktLink}
                disabled={!credentialStatus.traktConfigured}
                style={{ padding: '8px 20px', fontSize: '0.9rem' }}
              >
                {i18n.t('settings:scrobbling.connectBtn')}
              </button>
            )}

            {traktAuthState === 'polling' && (
              <div style={authContainerStyle}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    {i18n.t('settings:scrobbling.enterPin')}
                  </div>
                  <div style={pinCodeStyle} onClick={() => handleCopyCode(traktUserCode)} title={i18n.t('settings:scrobbling.clickToCopy')}>
                    {traktUserCode}
                  </div>
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '0 0 12px 0' }}>
                    {i18n.t('settings:scrobbling.goToUrlPrefix')}{' '}
                    <a href={traktVerificationUrl} target="_blank" rel="noreferrer" style={{ color: '#00d4ff' }}>
                      {traktVerificationUrl}
                    </a>
                    {' '}{i18n.t('settings:scrobbling.goToUrlSuffix')}
                  </p>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '14px' }}>
                    {i18n.t('settings:scrobbling.waitingVerification', { minutes: Math.floor(traktExpiresIn / 60), seconds: traktExpiresIn % 60 })}
                  </div>
                  <button
                    onClick={cancelTraktLink}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    {i18n.t('settings:scrobbling.cancelCode')}
                  </button>
                </div>
              </div>
            )}

            {traktAuthState === 'success' && (
              <div style={{
                ...authContainerStyle,
                background: 'rgba(46,213,115,0.1)',
                borderColor: 'rgba(46,213,115,0.25)',
                color: '#2ed573',
                fontWeight: 600,
                textAlign: 'center',
              }}>
                ✓ {i18n.t('settings:scrobbling.authSuccess')}
              </div>
            )}

            {traktAuthState === 'error' && (
              <div style={{
                ...authContainerStyle,
                background: 'rgba(255,71,87,0.1)',
                borderColor: 'rgba(255,71,87,0.25)',
                color: '#ff4757',
                textAlign: 'center',
              }}>
                <div style={{ fontWeight: 600, marginBottom: '8px' }}>
                  {credentialStatus.traktConfigured ? i18n.t('settings:scrobbling.codeExpired') : i18n.t('settings:scrobbling.noCredentials')}
                </div>
                <button className="sync-btn" onClick={startTraktLink} style={{ color: '#ff4757', borderColor: 'rgba(255,71,87,0.4)', background: 'rgba(255,71,87,0.15)' }}>
                  {i18n.t('settings:scrobbling.tryAgain')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="timeshift-toggle-row" style={{ marginBottom: '12px', marginTop: '12px' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:scrobbling.enableScrobble')}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:scrobbling.enableScrobbleHint')}</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={traktScrobbleEnabled}
                  onChange={(e) => handleSettingUpdate({ traktScrobbleEnabled: e.target.checked })}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button
                className="sync-btn"
                onClick={openCatalogModal}
                style={{ padding: '8px 20px', fontSize: '0.9rem' }}
              >
                {i18n.t('settings:scrobbling.configureStremCatalogs')}
              </button>
              <button
                className="sync-btn"
                onClick={openNuvioCatalogModal}
                style={{ padding: '8px 20px', fontSize: '0.9rem' }}
              >
                {i18n.t('settings:scrobbling.configureNuvioCatalogs')}
              </button>
            </div>

            <button
              className="sync-btn danger"
              onClick={handleTraktUnlink}
              style={{ padding: '8px 20px', fontSize: '0.9rem', borderColor: 'rgba(255,71,87,0.4)', color: '#ff4757' }}
            >
              {i18n.t('settings:scrobbling.disconnect')}
            </button>
          </div>
        )}

        {activeModalType !== null && (
          <TraktCatalogsModal
            type={activeModalType}
            onClose={() => setActiveModalType(null)}
          />
        )}
      </div>

      <p className="settings-disclaimer">
        Scrobbling automatically syncs your watch progress to Trakt. Trakt is a third-party service and is not affiliated with this application.
      </p>
    </div>
  );
}
