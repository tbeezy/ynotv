import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import {
  clearLocalStorage,
  formatBytes,
  getLocalStorageUsage,
  type StorageUsageEntry,
} from '../services/safeStorage';
import { logErrorAlways } from '../utils/logger';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  clearing: boolean;
  usage: { entries: StorageUsageEntry[]; totalBytes: number } | null;
}

/** Whether the error looks like a browser-storage capacity failure. */
function isQuotaError(error: Error | null): boolean {
  const name = error?.name ?? '';
  const message = error?.message ?? '';
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota|exceeded the quota/i.test(message)
  );
}

/**
 * Top-level error boundary.
 *
 * The app window is transparent, so if an uncaught render error ever blanks
 * the React tree the window would silently become invisible while still
 * showing in the taskbar. This boundary catches those errors and renders a
 * visible fallback instead, with a reload action so the app stays recoverable
 * without killing the process.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, clearing: false, usage: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught render error:', error, errorInfo);
    // Write the crash to the app log even when Debug logging is off, so the
    // user can share a log that contains it without enabling Debug mode first.
    logErrorAlways('[ErrorBoundary] Uncaught render error:', error?.message, error?.stack, errorInfo?.componentStack);
    // If this is a storage-quota crash, measure what's consuming localStorage
    // so the user (and the log) can see the culprit right on the error screen.
    if (isQuotaError(error)) {
      try {
        this.setState({ usage: getLocalStorageUsage() });
      } catch (e) {
        console.warn('[ErrorBoundary] Could not measure localStorage usage:', e);
      }
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleClearStorage = (): void => {
    const confirmed = window.confirm(
      'This clears the app\'s browser storage (expanded-sidebar state, recent channels, search ' +
        'history, widget layout, cached sports data, etc.). It does NOT touch your sources, ' +
        'settings, favorites, or the database. Use this if the app keeps crashing with a ' +
        'storage-quota error.\n\nContinue?'
    );
    if (!confirmed) return;
    this.setState({ clearing: true });
    try {
      clearLocalStorage();
    } finally {
      this.setState({ clearing: false });
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message || 'Unknown error';
    const detail = this.state.error?.stack || '';
    const quota = isQuotaError(this.state.error);
    const usage = this.state.usage;

    const row: CSSProperties = {
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      flexWrap: 'wrap',
      justifyContent: 'center',
    };

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px',
          background: '#0b0e14',
          color: '#e8ecf3',
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          textAlign: 'center',
          padding: '32px',
        }}
      >
        <div style={{ fontSize: '22px', fontWeight: 600, letterSpacing: '1px', color: '#00d4ff' }}>
          ynoTV
        </div>
        <div style={{ fontSize: '15px', fontWeight: 600 }}>
          Something went wrong{quota ? ' — storage is full' : ''}
        </div>
        <div
          style={{
            fontSize: '13px',
            color: '#9aa3b2',
            maxWidth: '520px',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            maxHeight: '160px',
            overflow: 'auto',
          }}
        >
          {message}
          {detail ? `\n\n${detail}` : ''}
        </div>

        {quota && usage && (
          <div
            style={{
              fontSize: '12px',
              color: '#9aa3b2',
              background: '#11161f',
              border: '1px solid #232b3a',
              borderRadius: '8px',
              padding: '10px 14px',
              maxWidth: '480px',
              textAlign: 'left',
              lineHeight: 1.6,
            }}
          >
            <div>
              localStorage usage:{' '}
              <b style={{ color: '#e8ecf3' }}>{formatBytes(usage.totalBytes)}</b>{' '}
              across {usage.entries.length} key(s)
            </div>
            {usage.entries.slice(0, 5).map((entry) => (
              <div key={entry.key} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ color: '#00d4ff' }}>{formatBytes(entry.bytes)}</span> {entry.key}
              </div>
            ))}
            {usage.entries.length > 5 && (
              <div style={{ color: '#6b7280' }}>…and {usage.entries.length - 5} more</div>
            )}
          </div>
        )}

        <div style={row}>
          <button
            onClick={this.handleReload}
            style={{
              padding: '8px 20px',
              borderRadius: '6px',
              border: 'none',
              background: '#00d4ff',
              color: '#06131a',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            onClick={this.handleClearStorage}
            disabled={this.state.clearing}
            style={{
              padding: '8px 20px',
              borderRadius: '6px',
              border: '1px solid #b42318',
              background: 'rgba(180, 35, 24, 0.15)',
              color: '#ff8f87',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {this.state.clearing ? 'Clearing…' : 'Clear app storage'}
          </button>
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280' }}>
          If this keeps happening, enable Debug logging in Settings and share the log.
        </div>
      </div>
    );
  }
}
