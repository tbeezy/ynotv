import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StoredChannel } from '../db';
import type { VodPlayInfo } from '../types/media';
import {
  fetchProviderConnectionInfo,
  AutoDismissController,
  type ProviderConnectionStats,
} from '../services/connectionInfo';
import './ConnectionInfoOverlay.css';

export interface ConnectionInfoOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  channel?: StoredChannel | null;
  vodInfo?: VodPlayInfo | null;
  catchupInfo?: {
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number;
    programDesc?: string;
  } | null;
  shortcutKey?: string;
}

function ServerBadgeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'is-spinning' : ''}>
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function ConnectionInfoOverlay({
  isOpen,
  onClose,
  channel,
  vodInfo,
  catchupInfo,
  shortcutKey,
}: ConnectionInfoOverlayProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ProviderConnectionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(5);
  const [isPaused, setIsPaused] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const channelRef = useRef(channel);
  channelRef.current = channel;
  const vodInfoRef = useRef(vodInfo);
  vodInfoRef.current = vodInfo;
  const catchupInfoRef = useRef(catchupInfo);
  catchupInfoRef.current = catchupInfo;

  const controllerRef = useRef<AutoDismissController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new AutoDismissController({
      initialSeconds: 5,
      onClose: () => onCloseRef.current(),
      onTick: (sec) => setSecondsRemaining(sec),
    });
  }
  controllerRef.current.updateOnClose(onClose);

  const activeSourceId = channel?.source_id || vodInfo?.source_id;

  // Monotonic request guard: a slow reply for a stream the user has already
  // zapped away from must never overwrite the stats of the stream playing now.
  const loadSeqRef = useRef(0);

  const loadInfo = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;

    const ch = channelRef.current;
    const vod = vodInfoRef.current;
    const catchup = catchupInfoRef.current;
    const sourceId = ch?.source_id || vod?.source_id;

    if (!sourceId) {
      if (!isCurrent()) return;
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const stats = await fetchProviderConnectionInfo(sourceId, ch, vod, catchup);
      if (!isCurrent()) return;
      setData(stats);
    } catch (err: any) {
      if (!isCurrent()) return;
      setError(err?.message || t('player.connectionInfo.statusError', 'Failed to retrieve connection info'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [t]);

  const streamKey = channel
    ? `ch:${channel.source_id}:${channel.stream_id}`
    : vodInfo
    ? `vod:${vodInfo.source_id || ''}:${vodInfo.mediaId || vodInfo.title || vodInfo.url}`
    : catchupInfo
    ? `cu:${catchupInfo.channelId}:${catchupInfo.startTime}`
    : null;

  // Fetch when opened or when stream changes while open, and start/reset timer
  useEffect(() => {
    if (!isOpen) {
      // Invalidate any in-flight response so it can't repopulate a closed HUD.
      loadSeqRef.current += 1;
      // Reset the hover flag while the card is closed: the pointer can be anywhere
      // by the time it reopens and an unmounted card never fires mouseleave.
      setIsPaused(false);
      controllerRef.current?.stop();
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    controllerRef.current?.reset(5);
    // Only (re)start on a closed -> open transition. This effect also reruns when
    // the stream changes (streamKey) or the language changes (loadInfo -> t) while
    // the card is up, and start() clears the hover pause — restarting there would
    // resume the countdown and dismiss the card under a hovering pointer.
    if (!controllerRef.current?.getIsRunning()) {
      controllerRef.current?.start();
    }
    void loadInfo();
  }, [isOpen, streamKey, loadInfo]);

  // Pause / resume controller
  useEffect(() => {
    controllerRef.current?.setPaused(isPaused);
  }, [isPaused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => controllerRef.current?.stop();
  }, []);

  // Escape listener
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen]);

  if (!isOpen) return null;

  const isNumericMax = Boolean(data && data.maxConnections && data.maxConnections !== 'Unlimited' && data.maxConnections !== 'N/A');
  const activeNum = data ? parseInt(data.activeConnections, 10) : NaN;
  const maxNum = isNumericMax ? parseInt(data!.maxConnections, 10) : NaN;
  const hasValidNumbers = !isNaN(activeNum) && !isNaN(maxNum) && maxNum > 0;
  const percent = hasValidNumbers ? Math.min(100, Math.max(0, Math.round((activeNum / maxNum) * 100))) : null;
  const isLimitReached = hasValidNumbers && activeNum >= maxNum;
  const maxDisplay = !data ? '—' : data.maxConnections === 'Unlimited' ? '∞' : data.maxConnections === 'N/A' ? '—' : data.maxConnections;

  const statusClass = data
    ? `conn-info-status-chip--${data.status}`
    : 'conn-info-status-chip--unknown';

  return createPortal(
    <div
      className="conn-info-overlay-root"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => {
        controllerRef.current?.reset(3);
        setIsPaused(false);
      }}
    >
      <div className="conn-info-card">
        {/* Header */}
        <div className="conn-info-header">
          <div className="conn-info-header-left">
            <div className="conn-info-icon-badge">
              <ServerBadgeIcon />
            </div>
            <div className="conn-info-title-group">
              <div className="conn-info-provider-title" title={data?.sourceName || t('player.connectionInfo.title', 'Connection Info')}>
                {data?.sourceName || t('player.connectionInfo.title', 'Connection Info')}
              </div>
              {data?.streamTitle && (
                <div className="conn-info-stream-subtitle" title={data.streamTitle}>
                  {data.streamTitle}
                </div>
              )}
            </div>
          </div>

          <div className="conn-info-header-right">
            {data && (
              <span className={`conn-info-status-chip ${statusClass}`}>
                <span className="conn-info-status-dot" />
                {data.statusText}
              </span>
            )}
            {activeSourceId && (
              <button
                className={`conn-info-action-btn ${loading ? 'is-spinning' : ''}`}
                onClick={() => {
                  controllerRef.current?.reset(5);
                  void loadInfo();
                }}
                title={t('player.connectionInfo.refresh', 'Refresh')}
                aria-label={t('player.connectionInfo.refresh', 'Refresh')}
              >
                <RefreshIcon spinning={loading} />
              </button>
            )}
            <button
              className="conn-info-action-btn"
              onClick={onClose}
              title={t('player.connectionInfo.close', 'Close')}
              aria-label={t('player.connectionInfo.close', 'Close')}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Body */}
        {loading && !data ? (
          <div className="conn-info-loading-container">
            <div className="conn-info-spinner" />
            <span>{t('player.connectionInfo.fetching', 'Fetching provider info...')}</span>
          </div>
        ) : !activeSourceId ? (
          <div className="conn-info-empty-state">
            <div className="conn-info-empty-title">{t('player.connectionInfo.noStream', 'No Active Stream')}</div>
            <p className="conn-info-empty-desc">
              {t('player.connectionInfo.noStreamDesc', 'Play a channel or video to inspect provider connections.')}
            </p>
          </div>
        ) : error && !data ? (
          <div className="conn-info-empty-state">
            <div className="conn-info-empty-title" style={{ color: '#f87171' }}>{t('player.connectionInfo.statusError', 'Error')}</div>
            <p className="conn-info-empty-desc">{error}</p>
          </div>
        ) : data ? (
          <div className="conn-info-body">
            {/* Active / Max Highlight Box */}
            <div className="conn-info-highlight-box">
              <div className="conn-info-highlight-row">
                <span className="conn-info-highlight-label">
                  {t('player.connectionInfo.activeConnections', 'Connections')}
                </span>
                <div className="conn-info-highlight-values">
                  <span className={`conn-info-val-active ${isLimitReached ? 'is-limit' : ''}`}>
                    {data.activeConnections}
                  </span>
                  <span className="conn-info-val-divider">/</span>
                  <span className="conn-info-val-max" title={data.maxConnections}>
                    {maxDisplay}
                  </span>
                </div>
              </div>

              {percent !== null && (
                <div className="conn-info-meter-track" title={`${percent}% used`}>
                  <div
                    className={`conn-info-meter-fill ${isLimitReached ? 'meter-warning' : 'meter-normal'}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </div>

            {/* Metadata Detail Table */}
            <div className="conn-info-details-table">
              <div className="conn-info-detail-row">
                <span className="conn-info-detail-key">{t('player.connectionInfo.status', 'Status')}</span>
                <span className="conn-info-detail-val">
                  {data.statusText}
                  {data.isCachedFallback && (
                    <span className="conn-info-cached-badge">(cached)</span>
                  )}
                </span>
              </div>

              <div className="conn-info-detail-row">
                <span className="conn-info-detail-key">{t('player.connectionInfo.expiryDate', 'Expiry Date')}</span>
                <span className="conn-info-detail-val">{data.expiryDate || t('player.connectionInfo.unlimited', 'Unlimited')}</span>
              </div>

              {data.username && (
                <div className="conn-info-detail-row">
                  <span className="conn-info-detail-key">{t('player.connectionInfo.account', 'Account')}</span>
                  <span className="conn-info-detail-val conn-info-detail-mono">{data.username}</span>
                </div>
              )}

              {data.mac && (
                <div className="conn-info-detail-row">
                  <span className="conn-info-detail-key">{t('player.connectionInfo.mac', 'MAC')}</span>
                  <span className="conn-info-detail-val conn-info-detail-mono">{data.mac}</span>
                </div>
              )}

              {data.sourceType && (
                <div className="conn-info-detail-row">
                  <span className="conn-info-detail-key">{t('player.connectionInfo.type', 'Type')}</span>
                  <span className="conn-info-detail-val">{data.sourceType}</span>
                </div>
              )}

              {data.serverUrl && (
                <div className="conn-info-detail-row">
                  <span className="conn-info-detail-key">{t('player.connectionInfo.server', 'Server')}</span>
                  <span className="conn-info-detail-val conn-info-detail-mono" title={data.serverUrl}>
                    {data.serverUrl.replace(/^https?:\/\//, '')}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Footer Hint */}
        <div className="conn-info-footer">
          {shortcutKey ? (
            t('player.connectionInfo.dismissHint', {
              seconds: secondsRemaining,
              key: shortcutKey,
              defaultValue: `Auto-dismisses in ${secondsRemaining}s · Press Esc or ${shortcutKey} to close`,
            })
          ) : (
            t('player.connectionInfo.dismissHintEsc', {
              seconds: secondsRemaining,
              defaultValue: `Auto-dismisses in ${secondsRemaining}s · Press Esc to close`,
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
