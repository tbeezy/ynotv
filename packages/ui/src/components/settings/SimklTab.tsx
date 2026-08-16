import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import { scrobbler } from '../../services/scrobbler';
import { useSettingsStore } from '../../stores/settingsStore';
import '../Modal.css';
import './PlaybackTab.css';

export function SimklTab() {
  useTranslation();
  const simklScrobbleEnabled = useSettingsStore((s) => s.simklScrobbleEnabled);
  const simklAccessToken = useSettingsStore((s) => s.simklAccessToken);
  const setSimklSettings = useSettingsStore((s) => s.setSimklSettings);
  const simklLinked = Boolean(simklAccessToken);

  const [authState, setAuthState] = useState<'idle' | 'polling' | 'success' | 'error'>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUrl, setVerificationUrl] = useState('');
  const [expiresIn, setExpiresIn] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  const pollTimer = useRef<any>(null);
  const countdownTimer = useRef<any>(null);

  const clearTimers = () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    pollTimer.current = null;
    countdownTimer.current = null;
  };

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, []);

  const handleSettingUpdate = (update: any) => {
    // Settings live in the store — the setter persists through the write queue.
    setSimklSettings(update);
  };

  const startSimklPinAuth = async () => {
    clearTimers();
    setErrorMessage('');
    setAuthState('idle');
    try {
      const pinData = await scrobbler.generateSimklPinCode();
      setUserCode(pinData.user_code);
      setVerificationUrl(pinData.verification_uri || pinData.verification_url || 'https://simkl.com/pin');
      setExpiresIn(pinData.expires_in);
      setAuthState('polling');

      let timeLeft = pinData.expires_in;
      countdownTimer.current = setInterval(() => {
        timeLeft -= 1;
        setExpiresIn(timeLeft);
        if (timeLeft <= 0) {
          clearTimers();
          setAuthState('error');
          setErrorMessage(i18n.t('settings:simkl.codeExpired'));
        }
      }, 1000);

      const intervalSec = Math.max(1, pinData.interval || 5);
      const startTime = Date.now();
      pollTimer.current = setInterval(async () => {
        if (Date.now() - startTime > pinData.expires_in * 1000) return;
        try {
          const pollRes = await scrobbler.pollSimklPin(pinData.user_code);
          if (pollRes.success) {
            clearTimers();
            setAuthState('success');
            setTimeout(() => {
              setAuthState('idle');
              setUserCode('');
              setVerificationUrl('');
            }, 2000);
          } else if (pollRes.error) {
            clearTimers();
            setAuthState('error');
            setErrorMessage(translateNativeError(pollRes.error) || pollRes.error);
          }
        } catch (e) {
          console.error('Simkl polling failed:', e);
        }
      }, intervalSec * 1000);
    } catch (e: any) {
      console.error('Failed to initiate Simkl PIN auth:', e);
      setErrorMessage(translateNativeError(e.message) || i18n.t('settings:simkl.authStartFailed'));
      setAuthState('error');
    }
  };

  const cancelSimklAuth = () => {
    clearTimers();
    setAuthState('idle');
    setUserCode('');
    setVerificationUrl('');
    setErrorMessage('');
  };

  const handleSimklUnlink = async () => {
    if (confirm(i18n.t('settings:simkl.disconnectConfirm'))) {
      await scrobbler.logoutSimkl();
      // Store selectors re-render automatically on logout
    }
  };

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const authContainerStyle: CSSProperties = {
    marginTop: '16px',
    padding: '20px',
    background: 'var(--bg-tertiary)',
    borderRadius: '10px',
    border: '1px solid var(--surface-border)',
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:simkl.title')}</h3>
          <span style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '3px 8px',
            borderRadius: '4px',
            color: simklLinked ? '#2ed573' : 'var(--text-muted)',
            background: simklLinked ? 'rgba(46,213,115,0.1)' : 'var(--surface-color)',
          }}>
            {simklLinked ? i18n.t('settings:simkl.connected') : i18n.t('settings:simkl.notConnected')}
          </span>
        </div>

        <p className="section-description">
          {i18n.t('settings:simkl.description')}
        </p>

        {!simklLinked ? (
          <div>
            {authState === 'idle' && (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="sync-btn"
                  onClick={startSimklPinAuth}
                  style={{ padding: '8px 20px', fontSize: '0.9rem' }}
                >
                  {i18n.t('settings:simkl.connectBtn')}
                </button>
                <a
                  href="https://simkl.com"
                  target="_blank"
                  rel="noreferrer"
                  className="sync-btn"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '8px 20px',
                    fontSize: '0.9rem',
                    textDecoration: 'none',
                    background: 'var(--surface-color)',
                  }}
                >
                  {i18n.t('settings:simkl.aboutSimkl')}
                </a>
              </div>
            )}

            {authState === 'polling' && (
              <div style={authContainerStyle}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
                  {i18n.t('settings:simkl.step1')}
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                  {i18n.t('settings:simkl.enterCodeHint')}
                </p>

                <button
                  onClick={() => navigator.clipboard.writeText(userCode)}
                  title={i18n.t('settings:scrobbling.clickToCopy')}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '16px',
                    marginBottom: '12px',
                    background: 'var(--surface-glow)',
                    border: '1px dashed var(--accent-primary)',
                    borderRadius: '8px',
                    color: '#00d4ff',
                    fontWeight: 700,
                    fontSize: '2rem',
                    letterSpacing: '0.4em',
                    textAlign: 'center',
                    fontFamily: 'monospace',
                    cursor: 'pointer',
                  }}
                >
                  {userCode}
                </button>

                <div style={{ marginBottom: '12px' }}>
                  <a
                    href={verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-block',
                      padding: '8px 16px',
                      background: 'var(--surface-glow)',
                      border: '1px solid var(--accent-primary)',
                      borderRadius: '6px',
                      color: '#00d4ff',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      textDecoration: 'none',
                    }}
                  >
                    {i18n.t('settings:simkl.openPin')}
                  </a>
                </div>

                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {expiresIn > 0 ? i18n.t('settings:simkl.codeExpires', { countdown: formatCountdown(expiresIn) }) : i18n.t('settings:simkl.checkingAuth')}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                  {i18n.t('settings:simkl.waitingAuth')}
                </div>

                {errorMessage && (
                  <div style={{ color: '#ff4757', fontSize: '0.82rem', marginBottom: '12px' }}>
                    {errorMessage}
                  </div>
                )}

                <button
                  onClick={cancelSimklAuth}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {i18n.t('settings:simkl.cancelAuth')}
                </button>
              </div>
            )}

            {authState === 'success' && (
              <div style={{
                ...authContainerStyle,
                background: 'rgba(46,213,115,0.1)',
                borderColor: 'rgba(46,213,115,0.25)',
                color: '#2ed573',
                fontWeight: 600,
                textAlign: 'center',
              }}>
                {i18n.t('settings:simkl.authSuccess')}
              </div>
            )}

            {authState === 'error' && (
              <div style={{
                ...authContainerStyle,
                background: 'rgba(255,71,87,0.1)',
                borderColor: 'rgba(255,71,87,0.25)',
                color: '#ff4757',
                textAlign: 'center',
              }}>
                <div style={{ fontWeight: 600, marginBottom: '8px' }}>
                  {errorMessage || i18n.t('common:authenticationFailed')}
                </div>
                <button
                  className="sync-btn"
                  onClick={startSimklPinAuth}
                  style={{ color: '#ff4757', borderColor: 'rgba(255,71,87,0.4)', background: 'rgba(255,71,87,0.15)' }}
                >
                  {i18n.t('settings:simkl.tryAgain')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="timeshift-toggle-row" style={{ marginBottom: '16px', marginTop: '12px' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:simkl.enableScrobble')}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:simkl.enableScrobbleHint')}</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={simklScrobbleEnabled}
                  onChange={(e) => handleSettingUpdate({ simklScrobbleEnabled: e.target.checked })}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginTop: '16px' }}>
              <a
                href="https://simkl.com"
                target="_blank"
                rel="noreferrer"
                className="sync-btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 20px',
                  fontSize: '0.9rem',
                  textDecoration: 'none',
                  background: 'var(--surface-color)',
                }}
              >
                {i18n.t('settings:simkl.aboutSimkl')}
              </a>
              <button className="sync-btn danger" onClick={handleSimklUnlink}>
                {i18n.t('settings:simkl.disconnect')}
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="settings-disclaimer">
        Simkl is a third-party tracking service and is not affiliated with this application. Scrobbling updates your watching status automatically when active.
      </p>
    </div>
  );
}
