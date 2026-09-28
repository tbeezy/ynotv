import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { FolderType, LibraryFolder } from '../../services/local-library/types';
import {
  useScannedFolders,
  useLocalLibrary,
  removeScannedFolder,
  relocateScannedFolder,
} from '../../services/local-library/local-library';

interface LocalFoldersModalProps {
  isOpen: boolean;
  folderFilter?: 'movie' | 'show';
  onClose: () => void;
  onRescanFolder: (folder: string) => Promise<void>;
  onAddNewFolder: (type: FolderType) => Promise<void>;
  onRescanAllFolders?: () => Promise<void>;
}

export const LocalFoldersModal = memo(function LocalFoldersModal({
  isOpen,
  folderFilter,
  onClose,
  onRescanFolder,
  onAddNewFolder,
  onRescanAllFolders,
}: LocalFoldersModalProps) {
  const { t } = useTranslation('vod');
  const configuredFolders = useScannedFolders();
  const library = useLocalLibrary();
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null);
  const [rescanningFolder, setRescanningFolder] = useState<string | null>(null);
  const [missingFolders, setMissingFolders] = useState<Set<string>>(new Set());

  const checkFolders = useCallback(async () => {
    const missing = new Set<string>();
    for (const folder of configuredFolders) {
      const exists = await invoke<boolean>('check_path_exists', { path: folder.path }).catch(() => false);
      if (!exists) {
        missing.add(folder.path);
      }
    }
    setMissingFolders(missing);
  }, [configuredFolders]);

  useEffect(() => {
    if (isOpen) {
      void checkFolders();
    }
  }, [isOpen, checkFolders]);

  const filteredConfiguredFolders = useMemo(() => {
    if (!folderFilter) return configuredFolders;
    return configuredFolders.filter((f) => f.type === folderFilter || f.type === 'mixed');
  }, [configuredFolders, folderFilter]);

  // Compute stats per configured scan root
  const folderStats = useMemo(() => {
    const statsMap = new Map<string, { total: number; movies: number; episodes: number }>();
    for (const folder of configuredFolders) {
      const normFolder = folder.path.replace(/\\/g, '/').toLowerCase();
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
      statsMap.set(folder.path, { total, movies, episodes });
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

  const handleRelocate = useCallback(
    async (oldPath: string) => {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: t('relocateFolderTitle', 'Select New Location for Folder'),
        });
        if (!selected || typeof selected !== 'string') return;
        relocateScannedFolder(oldPath, selected);
        await checkFolders();
      } catch (e) {
        console.error('[LocalFoldersModal] Failed to relocate folder:', e);
      }
    },
    [checkFolders, t],
  );

  const typeLabel = useCallback(
    (type: FolderType): string => {
      if (type === 'movie') return t('folderTypeMovie', 'Movies');
      if (type === 'show') return t('folderTypeSeries', 'Series');
      return t('folderTypeMixed', 'Mixed');
    },
    [t],
  );

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
            <h3 className="local-modal-title">
              {folderFilter === 'movie'
                ? t('manageMovieFolders', 'Manage Movie Folders')
                : folderFilter === 'show'
                ? t('manageSeriesFolders', 'Manage Series Folders')
                : t('manageFolders', 'Manage Local Folders')}
            </h3>
            <p className="local-modal-subtitle">
              {folderFilter === 'movie'
                ? t('manageMovieFoldersSubtitle', 'View, rescan, or remove movie folder sources in your local library.')
                : folderFilter === 'show'
                ? t('manageSeriesFoldersSubtitle', 'View, rescan, or remove series folder sources in your local library.')
                : t('manageFoldersSubtitle', 'View, rescan, or remove folder sources in your local library.')}
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
          {filteredConfiguredFolders.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0' }}>
              {folderFilter === 'movie'
                ? t('noMovieFoldersAdded', 'No movie folders have been added yet.')
                : folderFilter === 'show'
                ? t('noSeriesFoldersAdded', 'No series folders have been added yet.')
                : t('noFoldersAdded', 'No folders have been added yet.')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {filteredConfiguredFolders.map((folder: LibraryFolder) => {
                const stats = folderStats.get(folder.path) || { total: 0, movies: 0, episodes: 0 };
                const isRescanning = rescanningFolder === folder.path;
                const isConfirming = confirmDeleteFolder === folder.path;

                return (
                  <div
                    key={folder.path}
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
                          title={folder.path}
                        >
                          {folder.path}
                        </span>
                        <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              marginRight: '8px',
                              padding: '1px 8px',
                              borderRadius: '999px',
                              fontSize: '10.5px',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.4px',
                              color: 'var(--accent-primary, #00d4ff)',
                              border: '1px solid var(--accent-primary, #00d4ff)',
                            }}
                          >
                            {typeLabel(folder.type)}
                          </span>
                          {stats.total} {t('items', 'items')} ({stats.movies} {t('movies', 'movies')}, {stats.episodes} {t('episodes', 'episodes')})
                        </span>
                        {missingFolders.has(folder.path) && (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                              fontSize: '11px',
                              fontWeight: 600,
                              color: '#f87171',
                              background: 'rgba(239, 68, 68, 0.15)',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              width: 'fit-content',
                              marginTop: '2px',
                            }}
                          >
                            ⚠️ {t('folderNotFoundOrOffline', 'Folder not found or drive disconnected')}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      {missingFolders.has(folder.path) && (
                        <button
                          type="button"
                          className="local-btn local-btn--primary"
                          style={{ height: '30px', padding: '0 10px', fontSize: '12px' }}
                          onClick={() => handleRelocate(folder.path)}
                          title={t('relocateFolder', 'Select new location for this folder')}
                        >
                          {t('relocate', 'Relocate')}
                        </button>
                      )}

                      <button
                        type="button"
                        className="local-btn local-btn--secondary"
                        style={{ height: '30px', padding: '0 10px', fontSize: '12px' }}
                        onClick={() => handleRescan(folder.path)}
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
                        onClick={() => handleOpenExplorer(folder.path)}
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
                        onClick={() => handleRemove(folder.path)}
                        title={isConfirming ? t('confirmRemoveFolder', 'Click again to remove all files in this folder') : t('removeFolder', 'Remove folder')}
                      >
                        {isConfirming ? t('confirm', 'Confirm') : t('common:remove', 'Remove')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
            {onRescanAllFolders && filteredConfiguredFolders.length > 1 ? (
              <button
                type="button"
                className="local-btn local-btn--secondary"
                onClick={() => {
                  onClose();
                  void onRescanAllFolders();
                }}
                title={t('rescanAllTitle', 'Scan all configured folders for new media files')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                {t('rescanAll', 'Rescan All')}
              </button>
            ) : <div />}
            <div style={{ display: 'flex', gap: '10px' }}>
              {folderFilter !== 'show' && (
                <button
                  type="button"
                  className="local-btn local-btn--primary"
                  onClick={() => void onAddNewFolder('movie')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <line x1="12" y1="11" x2="12" y2="17" />
                    <line x1="9" y1="14" x2="15" y2="14" />
                  </svg>
                  {t('addMoviesFolder', 'Add Movies folder')}
                </button>
              )}
              {folderFilter !== 'movie' && (
                <button
                  type="button"
                  className="local-btn local-btn--primary"
                  onClick={() => void onAddNewFolder('show')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <line x1="12" y1="11" x2="12" y2="17" />
                    <line x1="9" y1="14" x2="15" y2="14" />
                  </svg>
                  {t('addSeriesFolder', 'Add Series folder')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
