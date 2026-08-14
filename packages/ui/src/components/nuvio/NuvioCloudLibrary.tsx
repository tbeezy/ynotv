import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CloudLibraryFile,
  CloudLibraryItem,
  CloudLibraryItemType,
} from '../../types/cloud';
import {
  cloudLibraryStableKey,
  cloudLibraryFileStableKey,
  cloudLibraryItemPlayableFiles,
  cloudLibraryProviderPosterUrl,
  formatCloudBytes,
} from '../../types/cloud';
import { useNuvioCloudStore } from '../../stores/nuvioCloudStore';
import './NuvioCloudLibrary.css';

interface NuvioCloudLibraryProps {
  apiKeys: Record<string, string>;
  enabled: boolean;
  onPlay: (item: CloudLibraryItem, file: CloudLibraryFile) => void;
  onConnectCloudClick: () => void;
}

const CLOUD_TYPE_LABELS: Record<CloudLibraryItemType, string> = {
  Torrent: 'Torrent',
  Usenet: 'Usenet',
  WebDownload: 'Web Download',
  File: 'File',
};

export function NuvioCloudLibrary({
  apiKeys,
  enabled,
  onPlay,
  onConnectCloudClick,
}: NuvioCloudLibraryProps) {
  const { t } = useTranslation();
  const cloud = useNuvioCloudStore();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<CloudLibraryItemType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);

  const providerIds = useMemo(() => Object.keys(apiKeys).filter((id) => apiKeys[id]), [apiKeys]);

  useEffect(() => {
    void cloud.load(apiKeys, enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeys, enabled]);

  const handleRefresh = useCallback(() => {
    setSelectedItemKey(null);
    void cloud.refresh(apiKeys, enabled);
  }, [apiKeys, enabled, cloud]);

  const providerItems = useMemo(() => {
    const all = cloud.providers.flatMap((provider) => provider.items);
    if (!selectedProviderId) return all;
    return all.filter((item) => item.providerId === selectedProviderId);
  }, [cloud.providers, selectedProviderId]);

  const availableTypes = useMemo(() => {
    const types = new Set<CloudLibraryItemType>();
    providerItems.forEach((item) => types.add(item.type));
    return [...types].sort((a, b) => a.localeCompare(b));
  }, [providerItems]);

  const effectiveSelectedType = selectedType && availableTypes.includes(selectedType) ? selectedType : null;

  const filteredItems = useMemo(() => {
    let items = providerItems;
    if (effectiveSelectedType) {
      items = items.filter((item) => item.type === effectiveSelectedType);
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.files.some((file) => file.name.toLowerCase().includes(query)),
      );
    }
    return items;
  }, [providerItems, effectiveSelectedType, searchQuery]);

  const selectedItem = filteredItems.find((item) => cloudLibraryStableKey(item) === selectedItemKey) || null;

  const hasApiKeys = providerIds.length > 0;
  const hasProviderItems = cloud.providers.some((p) => p.items.length > 0);
  const errorProviders = cloud.providers.filter((p) => p.errorMessage && p.items.length === 0);
  const visibleErrorProviders = errorProviders.filter(
    (p) => !selectedProviderId || p.providerId === selectedProviderId,
  );

  const handleItemClick = (item: CloudLibraryItem) => {
    const playableFiles = cloudLibraryItemPlayableFiles(item);
    if (playableFiles.length === 1) {
      onPlay(item, playableFiles[0]);
    } else if (playableFiles.length > 1) {
      setSelectedItemKey(cloudLibraryStableKey(item));
    }
  };

  const handleFileClick = (item: CloudLibraryItem, file: CloudLibraryFile) => {
    onPlay(item, file);
  };

  const connectedProviders = cloud.providers.filter((p) => p.items.length > 0);

  return (
    <div className="nuvio-cloud">
      {!cloud.isLoaded ? (
        <div className="nuvio-cloud-skeleton">
          <div className="nuvio-cloud-skeleton-toolbar" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="nuvio-cloud-skeleton-row" />
          ))}
        </div>
      ) : !enabled ? (
        <div className="nuvio-cloud-empty-card">
          <div className="nuvio-cloud-empty-icon">☁️</div>
          <div className="nuvio-cloud-empty-title">{t('cloudLibraryDisabledTitle', 'Cloud Library is disabled')}</div>
          <div className="nuvio-cloud-empty-message">
            {t('cloudLibraryDisabledMessage', 'Enable the Cloud Library in Nuvio settings to browse your Torbox and Premiumize files.')}
          </div>
          <button className="nuvio-btn nuvio-btn-primary" onClick={onConnectCloudClick}>
            {t('cloudLibraryOpenSettings', 'Open Settings')}
          </button>
        </div>
      ) : !hasApiKeys ? (
        <div className="nuvio-cloud-empty-card">
          <div className="nuvio-cloud-empty-icon">🔑</div>
          <div className="nuvio-cloud-empty-title">{t('cloudLibraryConnectTitle', 'Connect a cloud provider')}</div>
          <div className="nuvio-cloud-empty-message">
            {t('cloudLibraryConnectMessage', 'Add your Torbox or Premiumize API key in Nuvio settings to browse your cloud files here.')}
          </div>
          <button className="nuvio-btn nuvio-btn-primary" onClick={onConnectCloudClick}>
            {t('cloudLibraryConnectAction', 'Connect Cloud')}
          </button>
        </div>
      ) : selectedItem ? (
        <div className="nuvio-cloud-file-picker">
          <div className="nuvio-cloud-file-picker-header">
            <button
              className="nuvio-cloud-back-btn"
              onClick={() => setSelectedItemKey(null)}
              title={t('cloudLibraryBack', 'Back')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="nuvio-cloud-file-picker-title-wrap">
              <div className="nuvio-cloud-file-picker-title">{selectedItem.name}</div>
              <div className="nuvio-cloud-file-picker-sub">{t('cloudLibraryFilePickerTitle', 'Select a file to play')}</div>
            </div>
          </div>
          <div className="nuvio-cloud-file-list">
            {cloudLibraryItemPlayableFiles(selectedItem).map((file) => (
              <div key={cloudLibraryFileStableKey(file)} className="nuvio-cloud-file-row" onClick={() => handleFileClick(selectedItem, file)}>
                <svg className="nuvio-cloud-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <div className="nuvio-cloud-file-name">{file.name}</div>
                {file.sizeBytes ? <div className="nuvio-cloud-file-size">{formatCloudBytes(file.sizeBytes)}</div> : null}
                <svg className="nuvio-cloud-file-play" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Toolbar: provider / type filters + refresh */}
          <div className="nuvio-cloud-toolbar">
            <div className="nuvio-cloud-filter-chips">
              <button
                className={`nuvio-cloud-chip ${!selectedProviderId ? 'active' : ''}`}
                onClick={() => { setSelectedProviderId(null); setSelectedType(null); }}
              >
                All providers
              </button>
              {cloud.providers.map((provider) => (
                <button
                  key={provider.providerId}
                  className={`nuvio-cloud-chip ${selectedProviderId === provider.providerId ? 'active' : ''}`}
                  onClick={() => { setSelectedProviderId(provider.providerId); setSelectedType(null); }}
                >
                  {provider.providerName}
                </button>
              ))}
              {availableTypes.length > 1 && (
                <>
                  <span className="nuvio-cloud-chip-separator" />
                  <button
                    className={`nuvio-cloud-chip ${!effectiveSelectedType ? 'active' : ''}`}
                    onClick={() => setSelectedType(null)}
                  >
                    All types
                  </button>
                  {availableTypes.map((type) => (
                    <button
                      key={type}
                      className={`nuvio-cloud-chip ${effectiveSelectedType === type ? 'active' : ''}`}
                      onClick={() => setSelectedType(type)}
                    >
                      {CLOUD_TYPE_LABELS[type] || type}
                    </button>
                  ))}
                </>
              )}
            </div>
            <button
              className="nuvio-cloud-refresh-btn"
              onClick={handleRefresh}
              disabled={cloud.isRefreshing}
              title={t('cloudLibraryRefresh', 'Refresh')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cloud.isRefreshing ? 'spinning' : ''}>
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="nuvio-cloud-search-wrap">
            <svg className="nuvio-cloud-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              className="nuvio-cloud-search"
              type="text"
              placeholder={t('cloudLibrarySearchLabel', 'Search cloud files...')}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSelectedItemKey(null); }}
            />
            {searchQuery && (
              <button className="nuvio-cloud-search-clear" onClick={() => setSearchQuery('')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Provider errors */}
          {visibleErrorProviders.map((provider) => (
            <div key={provider.providerId} className="nuvio-cloud-error-card">
              <div className="nuvio-cloud-error-title">
                Failed to load {provider.providerName} cloud
              </div>
              <div className="nuvio-cloud-error-message">{provider.errorMessage}</div>
              <button className="nuvio-btn" onClick={handleRefresh}>
                {t('cloudLibraryRetry', 'Retry')}
              </button>
            </div>
          ))}

          {/* Loading skeleton / empty / list */}
          {cloud.isRefreshing && filteredItems.length === 0 ? (
            <div className="nuvio-cloud-skeleton">
              {[0, 1, 2].map((i) => (
                <div key={i} className="nuvio-cloud-skeleton-row" />
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="nuvio-cloud-empty-card">
              <div className="nuvio-cloud-empty-icon">📂</div>
              <div className="nuvio-cloud-empty-title">
                {hasProviderItems
                  ? t('cloudLibraryEmptyTitle', 'No cloud files found')
                  : t('cloudLibraryEmptyTitleNoFiles', 'Your cloud library is empty')}
              </div>
              <div className="nuvio-cloud-empty-message">
                {t('cloudLibraryEmptyMessage', 'Nothing here yet. Add files to your Torbox or Premiumize cloud and refresh.')}
              </div>
              <button className="nuvio-btn" onClick={handleRefresh}>
                {t('cloudLibraryRetry', 'Retry')}
              </button>
            </div>
          ) : (
            <div className="nuvio-cloud-list">
              {filteredItems.map((item) => {
                const playableCount = cloudLibraryItemPlayableFiles(item).length;
                const poster = cloudLibraryProviderPosterUrl(item.providerId);
                return (
                  <div
                    key={cloudLibraryStableKey(item)}
                    className={`nuvio-cloud-row ${playableCount === 0 ? 'disabled' : ''}`}
                    onClick={() => handleItemClick(item)}
                  >
                    <div className="nuvio-cloud-row-main">
                      {poster && (
                        <img className="nuvio-cloud-row-logo" src={poster} alt={item.providerName} loading="lazy" />
                      )}
                      <div className="nuvio-cloud-row-text">
                        <div className="nuvio-cloud-row-title">{item.name}</div>
                        <div className="nuvio-cloud-row-sub">
                          {[item.providerName, CLOUD_TYPE_LABELS[item.type] || item.type, playableCount === 1 ? cloudLibraryItemPlayableFiles(item)[0].name : playableCount > 1 ? `${playableCount} files` : t('cloudLibraryNoPlayableFiles', 'No playable files')].join(' • ')}
                        </div>
                        <div className="nuvio-cloud-row-status">
                          {[item.status, item.sizeBytes ? formatCloudBytes(item.sizeBytes) : null, item.progressFraction != null ? `${Math.round(item.progressFraction * 100)}%` : null]
                            .filter((s): s is string => !!s)
                            .join(' • ') || (playableCount === 0 ? t('cloudLibraryNoPlayableFiles', 'No playable files') : 'Ready')}
                        </div>
                      </div>
                      {playableCount > 0 && (
                        <div className="nuvio-cloud-row-play">
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    {item.progressFraction != null && item.progressFraction < 0.999 && (
                      <div className="nuvio-cloud-progress-track">
                        <div
                          className="nuvio-cloud-progress-fill"
                          style={{ width: `${Math.round(item.progressFraction * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {connectedProviders.length > 0 && (
            <div className="nuvio-cloud-connected-hint">
              {t('cloudLibraryConnectedHint', 'Cloud files load directly from your debrid provider.')}
            </div>
          )}
        </>
      )}
    </div>
  );
}


