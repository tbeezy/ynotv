import { useState, useEffect } from 'react';
import { check, Update, DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import './UpdateModal.css';

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UpdateModal({ isOpen, onClose }: UpdateModalProps) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<'checking' | 'available' | 'downloading' | 'installing' | 'uptodate' | 'error'>('checking');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      checkForUpdate();
    }
  }, [isOpen]);

  const checkForUpdate = async () => {
    try {
      setStatus('checking');
      setProgress(0);
      setError(null);

      const result = await check();

      if (result === null) {
        setStatus('uptodate');
      } else {
        setUpdate(result);
        setStatus('available');
      }
    } catch (e) {
      console.error('[UpdateModal] Failed to check for updates:', e);
      setStatus('error');
      setError('Failed to check for updates. Please try again later.');
    }
  };

  const handleUpdate = async () => {
    if (!update) return;

    try {
      setStatus('downloading');

      let downloadedLength = 0;
      let contentLength: number | undefined;

      await update.download((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength;
            break;
          case 'Progress':
            downloadedLength += event.data.chunkLength;
            if (contentLength) {
              const percent = Math.round((downloadedLength / contentLength) * 100);
              setProgress(percent);
            }
            break;
          case 'Finished':
            setProgress(100);
            break;
        }
      });

      setStatus('installing');
      await update.install();
      await relaunch();
    } catch (e) {
      console.error('[UpdateModal] Failed to download/install update:', e);
      setStatus('error');
      setError('Failed to download or install the update. Please try again later.');
    }
  };

  const handleClose = () => {
    if (status !== 'downloading' && status !== 'installing') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="update-modal-overlay" onClick={handleClose}>
      <div className="update-modal-panel" onClick={e => e.stopPropagation()}>
        <div className="update-modal-header">
          <h2>
            {status === 'checking' && 'Checking for Updates'}
            {status === 'available' && 'Update Available'}
            {status === 'downloading' && 'Downloading Update'}
            {status === 'installing' && 'Installing Update'}
            {status === 'uptodate' && 'Up to Date'}
            {status === 'error' && 'Update Error'}
          </h2>
          {status !== 'downloading' && status !== 'installing' && (
            <button className="update-modal-close" onClick={handleClose}>✕</button>
          )}
        </div>

        <div className="update-modal-content">
          {status === 'checking' && (
            <div className="update-modal-checking">
              <div className="update-modal-spinner" />
              <p>Checking for available updates...</p>
            </div>
          )}

          {status === 'available' && update && (
            <div className="update-modal-available">
              <div className="update-modal-icon">🎉</div>
              <p className="update-modal-message">
                A new version of ynoTV is available!
              </p>
              <div className="update-modal-version">
                <div className="version-row">
                  <span className="version-label">Current:</span>
                  <span className="version-current">v{update.currentVersion}</span>
                </div>
                <div className="version-row">
                  <span className="version-label">New:</span>
                  <span className="version-new">v{update.version}</span>
                </div>
              </div>
              {update.body && (
                <div className="update-modal-notes">
                  <h4>What's New:</h4>
                  <div className="update-notes-content">{update.body}</div>
                </div>
              )}
              <div className="update-modal-actions">
                <button className="update-modal-btn secondary" onClick={handleClose}>
                  Later
                </button>
                <button className="update-modal-btn primary" onClick={handleUpdate}>
                  Update Now
                </button>
              </div>
            </div>
          )}

          {status === 'downloading' && (
            <div className="update-modal-downloading">
              <div className="update-modal-progress-bar">
                <div
                  className="update-modal-progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="update-modal-progress-text">{progress}% downloaded</p>
              <p className="update-modal-hint">Please don't close the app</p>
            </div>
          )}

          {status === 'installing' && (
            <div className="update-modal-installing">
              <div className="update-modal-spinner" />
              <p>Installing update...</p>
              <p className="update-modal-hint">The app will restart automatically</p>
            </div>
          )}

          {status === 'uptodate' && (
            <div className="update-modal-uptodate">
              <div className="update-modal-icon success">✓</div>
              <p className="update-modal-message">
                You're running the latest version of ynoTV!
              </p>
              <p className="update-modal-version-text">
                Current version: v{update?.currentVersion || '1.5.4'}
              </p>
              <div className="update-modal-actions">
                <button className="update-modal-btn primary" onClick={handleClose}>
                  OK
                </button>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="update-modal-error">
              <div className="update-modal-icon error">✕</div>
              <p className="update-modal-message">
                {error || 'Something went wrong'}
              </p>
              <div className="update-modal-actions">
                <button className="update-modal-btn secondary" onClick={handleClose}>
                  Cancel
                </button>
                <button className="update-modal-btn primary" onClick={checkForUpdate}>
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default UpdateModal;
