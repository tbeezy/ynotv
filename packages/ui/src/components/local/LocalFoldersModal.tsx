import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  useScannedFolders,
  useLocalLibrary,
  removeScannedFolder,
} from '../../services/local-library/local-library';

interface LocalFoldersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRescanFolder: (folder: string) => Promise<void>;
  onAddNewFolder: () => Promise<void>;
}

export const LocalFoldersModal = memo(function LocalFoldersModal({
  isOpen,
  onClose,
  onRescanFolder,
  onAddNewFolder,
}: LocalFoldersModalProps) {
  const { t } = useTranslation('vod');
  const configuredFolders = useScannedFolders();
  const library = useLocalLibrary();
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null);
  const [rescanningFolder, setRescanningFolder] = useState<string | null>(null);

  // Compute stats per configured scan root
  const folderStats = useMemo(() => {
    const statsMap = new Map<string, { total: number; movies: number; episodes: number }>();
    for (const folder of configuredFolders) {
      const normFolder = folder.replace(/\\/g, '/').toLowerCase();
      const prefix = normFolder.endsWith('/') ? normFolder : `${normFolder}/`;
      let total = 0;
      let movies = 0;
      let episodes = 0;
      for (const item of library) {
        const itemPath = item.path.replace(/\\/g, '/').toLowerCase();
        if (itemPath.startsWith(prefix) || itemPath === normFolder) {
          total += 1;
          if (item.type === 'movie') movies += 1;
          else episodes += 1;
        }
      }
      statsMap.set(folder, { total, movies, episodes });
    }
    return statsMap;
  }, [configuredFolders, library]);

  const handleOpenExplorer = useCallback(async (folder: string) => {
    try {
      await invoke('open_file_location', { filePath: folder });
    } catch (e) {
      console.error('[LocalFoldersModal] Failed to open folder:', e);
    }
  }, []);

  const handleRescan = useCallback(
    async (folder: string) => {
      setRescanningFolder(folder);
      try {
        await onRescanFolder(folder);
      } finally {
        setRescanningFolder(null);
      }
    },
    [onRescanFolder],
  );

  const handleRemove = useCallback((folder: string) => {
    if (confirmDeleteFolder === folder) {
      removeScannedFolder(folder);
      setConfirmDeleteFolder(null);
    } else {
      setConfirmDeleteFolder(folder);
    }
  }, [confirmDeleteFolder]);

  if (!isOpen) return null;

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '640px' }}
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={() => setConfirmDeleteFolder(null)}
      >
        <div className="local-modal-header">
          <div>
            <h3 className="local-modal-title">{t('manageFolders', 'Manage Local Folders')}</h3>
            <p className="local-modal-subtitle">
              {t('manageFoldersSubtitle', 'View, rescan, or remove folder sources in your local library.')}
            </p>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body" style={{ gap: '14px' }}>
          {configuredFolders.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0' }}>
              {t('noFoldersAdded', 'No folders have been added yet.')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {configuredFolders.map((folder) => {
                const stats = folderStats.get(folder) || { total: 0, movies: 0, episodes: 0 };
                const isRescanning = rescanningFolder === folder;
                const isConfirming = confirmDeleteFolder === folder;

                return (
                  <div
                    key={folder}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '14px',
                      padding: '12px 16px',
                      borderRadius: '14px',
                      background: 'var(--surface-color, rgba(40,40,40,0.5))',
                      border: '1px solid var(--surface-border, rgba(255,255,255,0.08))',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                      <div style={{ color: 'var(--accent-primary, #00d4ff)', flexShrink: 0 }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: '13.5px',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={folder}
                        >
                          {folder}
                        </span>
                        <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                          {stats.total} {t('items', 'items')} ({stats.movies} {t('movies', 'movies')}, {stats.episodes} {t('episodes', 'episodes')})
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      <button
                        type="button"
                        className="local-btn local-btn--secondary"
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px' }}
                        onClick={() => handleRescan(folder)}
                        disabled={isRescanning}
                        title={t('rescan', 'Rescan folder')}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={isRescanning ? 'local-spin' : ''}>
                          <path d="M23 4v6h-6M1 20v-6h6" />
                          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                        </svg>
                        {isRescanning ? t('scanning', 'Scanning...') : t('rescan', 'Rescan')}
                      </button>

                      <button
                        type="button"
                        className="local-btn local-btn--secondary"
                        style={{ height: '30px', padding: '0 8px' }}
                        onClick={() => handleOpenExplorer(folder)}
                        title={t('openFolder', 'Open in Explorer')}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        className={`local-btn ${isConfirming ? 'local-btn--primary' : 'local-btn--secondary'}`}
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px', ...(isConfirming ? { background: '#ef4444', color: '#ffffff' } : { color: '#ef4444' }) }}
                        onClick={() => handleRemove(folder)}
                        title={isConfirming ? t('confirmRemoveFolder', 'Click again to remove all files in this folder') : t('removeFolder', 'Remove folder')}
                      >
                        {isConfirming ? t('confirm', 'Confirm') : t('remove', 'Remove')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
            <button
              type="button"
              className="local-btn local-btn--primary"
              onClick={onAddNewFolder}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
              {t('addFolder', 'Add folder')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
