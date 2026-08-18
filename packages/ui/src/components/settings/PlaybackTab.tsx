import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import '../Modal.css';
import './PlaybackTab.css';
import { PopoutTab } from './PopoutTab';
import { SkipIntroTab } from './SkipIntroTab';
import { CatchupTab } from './CatchupTab';
import { VodTab } from './VodTab';
import { useToastStore } from '../../stores/toastStore';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';

export type PlaybackSubTabId = 'mpv' | 'reconnect' | 'cast' | 'popout' | 'skipintro' | 'catchup' | 'vod';

interface PlaybackTabProps {
  initialSubTab?: PlaybackSubTabId;
  mpvParams: string;
  onMpvParamsChange: (params: string) => Promise<void>;
  streamWatchdogSeconds: number;
  streamMaxRetries: number;
  onStreamWatchdogSecondsChange: (seconds: number) => Promise<void>;
  onStreamMaxRetriesChange: (retries: number) => Promise<void>;
  castEnabled?: boolean;
  onCastEnabledChange?: (enabled: boolean) => Promise<void>;
  mpvHwdecEnabled?: boolean;
  onMpvHwdecEnabledChange?: (enabled: boolean) => Promise<void> | void;
  castRewriteTs?: boolean;
  onCastRewriteTsChange?: (enabled: boolean) => Promise<void>;
  useEventBasedReconnect: boolean;
  onUseEventBasedReconnectChange: (enabled: boolean) => Promise<void>;
  stallDetectionEnabled: boolean;
  onStallDetectionEnabledChange: (enabled: boolean) => Promise<void>;
  showLoadingScreen: boolean;
  onShowLoadingScreenChange: (enabled: boolean) => void;
  // Popout Player props
  popoutStopMain: boolean;
  onPopoutStopMainChange: (stop: boolean) => void;
  popoutAlwaysOnTop: boolean;
  onPopoutAlwaysOnTopChange: (onTop: boolean) => void;
  popoutHwdecEnabled?: boolean;
  onPopoutHwdecEnabledChange?: (enabled: boolean) => void;
  popoutMpvParamsEnabled: boolean;
  onPopoutMpvParamsEnabledChange: (enabled: boolean) => void;
  popoutMpvParams: string;
  onPopoutMpvParamsChange: (params: string) => void;
  // External Player props
  externalPlayerPath: string;
  onExternalPlayerPathChange: (path: string) => void;
  externalPlayerReuse: boolean;
  onExternalPlayerReuseChange: (reuse: boolean) => void;
  // Skip Intro props
  skipIntroTimerSeconds: number;
  onSkipIntroTimerSecondsChange: (seconds: number) => void;
  skipIntroAutoSkip: boolean;
  onSkipIntroAutoSkipChange: (auto: boolean) => void;
  // Catch-up props
  catchupStartPadding: number;
  onCatchupStartPaddingChange: (padding: number) => void;
  catchupEndPadding: number;
  onCatchupEndPaddingChange: (padding: number) => void;
  catchupContinuePlaying: boolean;
  onCatchupContinuePlayingChange: (enabled: boolean) => void;
  vodAutoPlayNextEpisode: boolean;
  onVodAutoPlayNextEpisodeChange: (enabled: boolean) => void;
  vodShowSourceBadge: boolean;
  onVodShowSourceBadgeChange: (enabled: boolean) => void;
}

const DEFAULT_MPV_PARAMS = `--hwdec=auto
--vo=gpu
--cache=yes
--demuxer-max-bytes=50MiB
--network-timeout=10
--video-sync=display-resample
--audio-stream-silence=yes
--stream-lavf-o=reconnect=1
--stream-lavf-o=reconnect_streamed=1
--stream-lavf-o=reconnect_delay_max=5`;

export function PlaybackTab({
  initialSubTab,
  mpvParams,
  mpvHwdecEnabled,
  onMpvHwdecEnabledChange,
  onMpvParamsChange,
  streamWatchdogSeconds,
  streamMaxRetries,
  onStreamWatchdogSecondsChange,
  onStreamMaxRetriesChange,
  castEnabled,
  onCastEnabledChange,
  castRewriteTs,
  onCastRewriteTsChange,
  useEventBasedReconnect,
  onUseEventBasedReconnectChange,
  stallDetectionEnabled,
  onStallDetectionEnabledChange,
  showLoadingScreen,
  onShowLoadingScreenChange,
  popoutStopMain,
  onPopoutStopMainChange,
  popoutAlwaysOnTop,
  onPopoutAlwaysOnTopChange,
  popoutHwdecEnabled,
  onPopoutHwdecEnabledChange,
  popoutMpvParamsEnabled,
  onPopoutMpvParamsEnabledChange,
  popoutMpvParams,
  onPopoutMpvParamsChange,
  externalPlayerPath,
  onExternalPlayerPathChange,
  externalPlayerReuse,
  onExternalPlayerReuseChange,
  skipIntroTimerSeconds,
  onSkipIntroTimerSecondsChange,
  skipIntroAutoSkip,
  onSkipIntroAutoSkipChange,
  catchupStartPadding,
  onCatchupStartPaddingChange,
  catchupEndPadding,
  onCatchupEndPaddingChange,
  catchupContinuePlaying,
  onCatchupContinuePlayingChange,
  vodAutoPlayNextEpisode,
  onVodAutoPlayNextEpisodeChange,
  vodShowSourceBadge,
  onVodShowSourceBadgeChange,
}: PlaybackTabProps) {
  useTranslation();
  const [activeSubTab, setActiveSubTab] = useState<PlaybackSubTabId>('mpv');

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  const [localParams, setLocalParams] = useState(mpvParams);
  const [hasChanges, setHasChanges] = useState(false);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const [showRestartModal, setShowRestartModal] = useState(false);

  const isHwdecOverridden = /--?hwdec[=\s]/i.test(localParams);

  // Local state for retry settings (committed on blur / enter)
  const [localWatchdog, setLocalWatchdog] = useState(String(streamWatchdogSeconds));
  const [localMaxRetries, setLocalMaxRetries] = useState(String(streamMaxRetries));
  const [localUseEventBased, setLocalUseEventBased] = useState(useEventBasedReconnect);
  const [localStallDetection, setLocalStallDetection] = useState(stallDetectionEnabled);

  // Sync if parent value changes (e.g. loaded from storage after mount)
  useEffect(() => { setLocalWatchdog(String(streamWatchdogSeconds)); }, [streamWatchdogSeconds]);
  useEffect(() => { setLocalMaxRetries(String(streamMaxRetries)); }, [streamMaxRetries]);
  useEffect(() => { setLocalUseEventBased(useEventBasedReconnect); }, [useEventBasedReconnect]);
  useEffect(() => { setLocalStallDetection(stallDetectionEnabled); }, [stallDetectionEnabled]);

  useEffect(() => {
    setLocalParams(mpvParams);
  }, [mpvParams]);

  const handleChange = (value: string) => {
    setLocalParams(value);
    setHasChanges(value !== mpvParams);
  };

  // Reverse guard for sports team autoswap: if the user tries to turn off the
  // LAST remaining detection method (Event-based reconnect / Stall detection)
  // while "Autoswap dead streams" is enabled, team failover would silently
  // stop working. Block the change and point them at the autoswap toggle —
  // symmetric with the forward guard in TeamChannelSettings.
  const warnIfAutoswapLosesDetection = (turningOff: boolean, otherStillOn: boolean): boolean => {
    if (turningOff && !otherStillOn && useSportsSettingsStore.getState().autoSwapDeadStreams) {
      useToastStore.getState().addToast(
        i18n.t(
          'settings:playback.detectionRequiredForAutoSwap',
          'Cannot disable the last detection method while "Autoswap dead streams" is enabled. Disable it in Sports → Team Channels first, or keep a detection method on.'
        ),
        'error'
      );
      return false;
    }
    return true;
  };

  const [pendingHwdec, setPendingHwdec] = useState<boolean | null>(null);

  const handleHwdecToggle = (newValue: boolean) => {
    setPendingHwdec(newValue);
    setShowRestartModal(true);
  };

  const handleSave = () => {
    setShowRestartModal(true);
  };

  const confirmSaveWithRestart = async () => {
    if (pendingHwdec !== null) {
      await onMpvHwdecEnabledChange?.(pendingHwdec);
      setPendingHwdec(null);
    }
    if (hasChanges) {
      await onMpvParamsChange(localParams.trim());
      setHasChanges(false);
    }
    setShowRestartModal(false);
    try {
      await relaunch();
    } catch (e) {
      console.error('[PlaybackTab] Failed to relaunch:', e);
    }
  };

  const confirmSaveWithoutRestart = async () => {
    if (pendingHwdec !== null) {
      await onMpvHwdecEnabledChange?.(pendingHwdec);
      setPendingHwdec(null);
    }
    if (hasChanges) {
      await onMpvParamsChange(localParams.trim());
      setHasChanges(false);
    }
    setShowRestartModal(false);
  };

  const handleReset = async () => {
    if (confirm(i18n.t('settings:playback.resetConfirm'))) {
      setLocalParams(DEFAULT_MPV_PARAMS);
      await onMpvParamsChange(DEFAULT_MPV_PARAMS);
      setHasChanges(false);
    }
  };

  const handleClear = async () => {
    if (confirm(i18n.t('settings:playback.clearConfirm'))) {
      setLocalParams('');
      await onMpvParamsChange('');
      setHasChanges(false);
    }
  };

  const checkMpvParams = async () => {
    try {
      const result = await invoke('mpv_get_params_debug') as Record<string, unknown>;
      setDebugInfo(JSON.stringify(result, null, 2));
    } catch (e) {
      setDebugInfo(`Error: ${e}`);
    }
  };

  return (
    <div className="playback-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="settings-tabs" style={{ padding: '0 20px', flexShrink: 0 }}>
        <button
          className={`settings-tab ${activeSubTab === 'mpv' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('mpv')}
        >
          {i18n.t('settings:playback.tabs.mpv')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'reconnect' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('reconnect')}
        >
          {i18n.t('settings:playback.tabs.reconnect')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'cast' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('cast')}
        >
          {i18n.t('settings:playback.tabs.cast')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'popout' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('popout')}
        >
          {i18n.t('settings:playback.tabs.popout')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'skipintro' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('skipintro')}
        >
          {i18n.t('settings:playback.tabs.skipintro')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'catchup' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('catchup')}
        >
          {i18n.t('settings:playback.tabs.catchup')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'vod' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('vod')}
        >
          {i18n.t('settings:playback.tabs.vod')}
        </button>
      </div>

      <div className="settings-tab-content">
        {activeSubTab === 'mpv' && (
          <div className="settings-section">
              <div style={{ marginBottom: '1.25rem', background: 'var(--card-bg, var(--surface-color))', padding: '14px 16px', borderRadius: '8px', border: '1px solid var(--border-color, var(--surface-border))', opacity: isHwdecOverridden ? 0.75 : 1 }}>
                <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: isHwdecOverridden ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={mpvHwdecEnabled ?? true}
                    disabled={isHwdecOverridden}
                    onChange={(e) => handleHwdecToggle(e.target.checked)}
                  />
                  <span style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {i18n.t('settings:playback.hwdecLabel')}
                    {isHwdecOverridden && (
                      <span style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', background: 'rgba(255, 193, 7, 0.15)', color: '#ffc107', border: '1px solid rgba(255, 193, 7, 0.3)', fontWeight: 500 }}>
                        {i18n.t('settings:playback.hwdecManaged')}
                      </span>
                    )}
                  </span>
                </label>
                <p style={{ marginTop: '0.4rem', marginLeft: '26px', opacity: 0.8, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4', margin: '6px 0 0 26px' }}>
                  {isHwdecOverridden
                    ? i18n.t('settings:playback.hwdecOverriddenHint')
                    : <>{i18n.t('settings:playback.hwdecHintPrefix')} <code style={{ color: 'var(--accent-color, #00d4ff)' }}>--hwdec=auto</code> {i18n.t('settings:playback.hwdecHintMid')} <code style={{ color: 'var(--accent-color, #00d4ff)' }}>--vo=gpu</code> {i18n.t('settings:playback.hwdecHintSuffix')}</>}
                </p>
              </div>

            <div className="playback-section" style={{ marginTop: 0 }}>
              <div className="playback-label">
                <span>{i18n.t('settings:playback.mpvParamsLabel')}</span>
                <small>
                  {i18n.t('settings:playback.mpvParamsHint')}
                  <br />
                  {i18n.t('settings:playback.mpvParamsExample')}
                </small>
              </div>

              <textarea
                className="mpv-params-input"
                value={localParams}
                onChange={(e) => handleChange(e.target.value)}
                placeholder="--hwdec=auto&#10;--cache=yes&#10;--network-timeout=10"
                rows={12}
                spellCheck={false}
              />

              <div className="playback-actions">
                <button
                  className="save-btn"
                  onClick={handleSave}
                  disabled={!hasChanges}
                >
                  {hasChanges ? i18n.t('settings:playback.saveChanges') : i18n.t('settings:playback.saved')}
                </button>
                <button className="reset-btn" onClick={handleReset}>
                  {i18n.t('settings:playback.resetDefaults')}
                </button>
                <button className="clear-btn" onClick={handleClear}>
                  {i18n.t('common:clearAll')}
                </button>
              </div>

              <div className="playback-help">
                <h4>{i18n.t('settings:playback.commonParams')}</h4>
                <div className="help-grid">
                  <div className="help-item">
                    <code>--hwdec=auto</code>
                    <span>{i18n.t('settings:playback.helpHwdec')}</span>
                  </div>
                  <div className="help-item">
                    <code>--cache=yes</code>
                    <span>{i18n.t('settings:playback.helpCache')}</span>
                  </div>
                  <div className="help-item">
                    <code>--network-timeout=10</code>
                    <span>{i18n.t('settings:playback.helpTimeout')}</span>
                  </div>
                  <div className="help-item">
                    <code>--video-sync=display-resample</code>
                    <span>{i18n.t('settings:playback.helpVsync')}</span>
                  </div>
                  <div className="help-item">
                    <code>--demuxer-max-bytes=50MiB</code>
                    <span>{i18n.t('settings:playback.helpDemuxer')}</span>
                  </div>
                  <div className="help-item">
                    <code>--stream-lavf-o=reconnect=1</code>
                    <span>{i18n.t('settings:playback.helpReconnect')}</span>
                  </div>
                </div>
              </div>



              <div style={{ marginTop: '20px', borderTop: '1px solid var(--surface-border)', paddingTop: '16px' }}>
                <button
                  className="sync-btn"
                  onClick={checkMpvParams}
                  style={{ maxWidth: '220px' }}
                >
                  {i18n.t('settings:playback.checkLoadedParams')}
                </button>
                {debugInfo && (
                  <pre style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    overflow: 'auto',
                    maxHeight: '300px',
                    color: 'var(--text-primary)'
                  }}>
                    {debugInfo}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}

        {activeSubTab === 'reconnect' && (
          <div className="settings-section">
            <div className="playback-section" style={{ marginTop: 0 }}>

              {/* Show Channel Loading Screen */}
              <div className="timeshift-toggle-row" style={{ marginBottom: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.loadingScreen')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.loadingScreenSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showLoadingScreen}
                    onChange={(e) => onShowLoadingScreenChange(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Event-based reconnect toggle */}
              <div className="timeshift-toggle-row" style={{ marginBottom: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.eventReconnect')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.eventReconnectSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={localUseEventBased}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!warnIfAutoswapLosesDetection(!next, localStallDetection)) return;
                      setLocalUseEventBased(next);
                      onUseEventBasedReconnectChange(next);
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Stall detection toggle */}
              <div className="timeshift-toggle-row" style={{ marginBottom: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.stallDetection')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.stallDetectionSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={localStallDetection}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!warnIfAutoswapLosesDetection(!next, localUseEventBased)) return;
                      setLocalStallDetection(next);
                      onStallDetectionEnabledChange(next);
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Watchdog timeout */}
              <div className="retry-setting-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.stallTimeout')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.stallTimeoutSub')}
                  </span>
                </div>
                <div className="retry-input-wrapper">
                  <input
                    id="stream-watchdog-seconds"
                    type="number"
                    min={3}
                    max={60}
                    step={1}
                    className="retry-number-input"
                    value={localWatchdog}
                    onChange={(e) => setLocalWatchdog(e.target.value)}
                    onBlur={() => {
                      const n = Math.max(3, Math.min(60, parseInt(localWatchdog, 10) || 10));
                      setLocalWatchdog(String(n));
                      onStreamWatchdogSecondsChange(n);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <span className="retry-input-unit">{i18n.t('settings:playback.secUnit')}</span>
                </div>
              </div>

              {/* Warning for low values */}
              {parseInt(localWatchdog, 10) < 8 && (
                <div className="retry-warning">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span>
                    {i18n.t('settings:playback.stallWarning')}
                  </span>
                </div>
              )}

              {/* Max retries */}
              <div className="retry-setting-row" style={{ marginTop: '16px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.maxRetries')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.maxRetriesSub')}
                  </span>
                </div>
                <div className="retry-input-wrapper">
                  <input
                    id="stream-max-retries"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    className="retry-number-input"
                    value={localMaxRetries}
                    onChange={(e) => setLocalMaxRetries(e.target.value)}
                    onBlur={() => {
                      const n = Math.max(1, Math.min(100, parseInt(localMaxRetries, 10) || 20));
                      setLocalMaxRetries(String(n));
                      onStreamMaxRetriesChange(n);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <span className="retry-input-unit">{i18n.t('settings:playback.retriesUnit')}</span>
                </div>
              </div>

            </div>
          </div>
        )}

        {activeSubTab === 'cast' && (
          <div className="settings-section">
            <div className="playback-section" style={{ marginTop: 0 }}>
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.castSupport')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.castSupportSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={castEnabled || false}
                    onChange={(e) => onCastEnabledChange?.(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              <div className="timeshift-toggle-row" style={{ borderBottom: 'none', marginTop: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:playback.rewriteTs')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:playback.rewriteTsSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={castRewriteTs || false}
                    onChange={(e) => onCastRewriteTsChange?.(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {castEnabled && (
                <div className="retry-warning" style={{ marginTop: '20px' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span>
                    {i18n.t('settings:playback.castActiveWarning')}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {activeSubTab === 'popout' && (
          <PopoutTab
            popoutStopMain={popoutStopMain}
            onPopoutStopMainChange={onPopoutStopMainChange}
            popoutAlwaysOnTop={popoutAlwaysOnTop}
            onPopoutAlwaysOnTopChange={onPopoutAlwaysOnTopChange}
            popoutHwdecEnabled={popoutHwdecEnabled}
            onPopoutHwdecEnabledChange={onPopoutHwdecEnabledChange}
            popoutMpvParamsEnabled={popoutMpvParamsEnabled}
            onPopoutMpvParamsEnabledChange={onPopoutMpvParamsEnabledChange}
            popoutMpvParams={popoutMpvParams}
            onPopoutMpvParamsChange={onPopoutMpvParamsChange}
            externalPlayerPath={externalPlayerPath}
            onExternalPlayerPathChange={onExternalPlayerPathChange}
            externalPlayerReuse={externalPlayerReuse}
            onExternalPlayerReuseChange={onExternalPlayerReuseChange}
          />
        )}

        {activeSubTab === 'skipintro' && (
          <SkipIntroTab
            skipIntroTimerSeconds={skipIntroTimerSeconds}
            onSkipIntroTimerSecondsChange={onSkipIntroTimerSecondsChange}
            skipIntroAutoSkip={skipIntroAutoSkip}
            onSkipIntroAutoSkipChange={onSkipIntroAutoSkipChange}
          />
        )}

        {activeSubTab === 'catchup' && (
          <CatchupTab
            catchupStartPadding={catchupStartPadding}
            onCatchupStartPaddingChange={onCatchupStartPaddingChange}
            catchupEndPadding={catchupEndPadding}
            onCatchupEndPaddingChange={onCatchupEndPaddingChange}
            catchupContinuePlaying={catchupContinuePlaying}
            onCatchupContinuePlayingChange={onCatchupContinuePlayingChange}
          />
        )}
        {activeSubTab === 'vod' && (
          <VodTab
            vodAutoPlayNextEpisode={vodAutoPlayNextEpisode}
            onVodAutoPlayNextEpisodeChange={onVodAutoPlayNextEpisodeChange}
            vodShowSourceBadge={vodShowSourceBadge}
            onVodShowSourceBadgeChange={onVodShowSourceBadgeChange}
          />
        )}
      </div>

      {showRestartModal && (
        <div className="modal-overlay" onClick={() => setShowRestartModal(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{i18n.t('settings:playback.restartRequired')}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-message">
                {i18n.t('settings:playback.restartMessage')}<br /><br />
                {i18n.t('settings:playback.restartQuestion')}
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn modal-btn-secondary" onClick={confirmSaveWithoutRestart}>
                {i18n.t('settings:playback.saveOnly')}
              </button>
              <button className="modal-btn modal-btn-primary" onClick={confirmSaveWithRestart}>
                {i18n.t('settings:playback.restartNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
