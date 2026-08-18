import { useTranslation } from 'react-i18next';
import './FailoverOverlay.css';
import type { FailoverState } from '../hooks/usePlayback';

interface Props {
  state: FailoverState;
  isSmall?: boolean;
}

export function FailoverOverlay({ state, isSmall = false }: Props) {
  const { t } = useTranslation('player');
  return (
    <div className={`failover-overlay ${isSmall ? 'small' : ''}`}>
      <div className="failover-content">
        <div className="failover-icon">
          {/* Arrows-rotate icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
        </div>
        <div className="failover-text">
          <span className="failover-title">
            {t('switchingToBackup')}
            <span className="failover-ellipsis" aria-hidden="true">…</span>
          </span>
          <span className="failover-from">&#x21b3; {state.toChannelName}</span>
          {state.attempt > 1 && (
            <span className="failover-attempt">{t('backupAttempt', { number: state.attempt })}</span>
          )}
        </div>
      </div>
    </div>
  );
}
