import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { StremioStream, StremioStreamBadge } from '../../types/stremio';
import { useDownloadStore } from '../../stores/downloadStore';
import { extractStreamBadges, isLightColor, formatVideoSize } from '../../utils/streamBadges';
import './StreamPickerModal.css';

interface StreamPickerModalProps {
  streams: StremioStream[];
  onSelect: (stream: StremioStream) => void;
  onClose: () => void;
  meta?: any;
  selectedVideo?: any;
  showStreamBadges?: boolean;
  compiledBadgeRules?: { pattern: RegExp; badge: StremioStreamBadge }[];
  showFileSizeBadges?: boolean;
  streamBadgePlacement?: 'top' | 'bottom';
}

export function StreamPickerModal({
  streams,
  onSelect,
  onClose,
  meta,
  selectedVideo,
  showStreamBadges = true,
  compiledBadgeRules = [],
  showFileSizeBadges = true,
  streamBadgePlacement = 'bottom',
}: StreamPickerModalProps) {
  useTranslation();
  const directStreams = streams.filter(s => s.url);
  const torrentStreams = streams.filter(s => s.infoHash);

  const startDownload = useDownloadStore((s) => s.startDownload);
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);

  const handleDownloadStream = useCallback(
    async (stream: StremioStream, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!stream.url) return;
      setDownloadingUrl(stream.url);
      try {
        let title = '';
        if (meta) {
          if (meta.type === 'series' && selectedVideo) {
            title = `${meta.name} - S${selectedVideo.season}E${selectedVideo.episode}${selectedVideo.title ? ` - ${selectedVideo.title}` : ''}`;
          } else {
            title = `${meta.name}${meta.year ? ` (${meta.year})` : ''}`;
          }
        } else {
          title = stream.title || stream.name || i18n.t('stremio:stremioStream');
        }
        await startDownload(
          title,
          stream.url,
          undefined,
          undefined,
          undefined,
          meta?.poster || undefined,
          undefined,
          undefined,
          undefined,
          meta?.type === 'series' ? 'Series' : 'Movies'
        );
      } catch (error) {
        console.error('[StreamPickerModal] Stream download failed:', error);
        alert(i18n.t('stremio:failedStartDownload'));
      } finally {
        setDownloadingUrl(null);
      }
    },
    [meta, selectedVideo, startDownload]
  );

  const renderItemBadges = (stream: StremioStream) => {
    if (!showStreamBadges) return null;
    const badges = extractStreamBadges(stream, compiledBadgeRules);
    if (showFileSizeBadges && stream.behaviorHints?.videoSize) {
      const sizeStr = formatVideoSize(stream.behaviorHints.videoSize);
      if (sizeStr) {
        badges.push({
          label: sizeStr,
          color: '#4b5563',
        });
      }
    }
    if (badges.length === 0) return null;

    return (
      <div className="stremio-detail-stream-badges" style={{ 
        display: 'flex', 
        gap: '6px', 
        flexWrap: 'wrap', 
        alignItems: 'center',
        marginTop: streamBadgePlacement === 'top' ? '4px' : '6px',
        marginBottom: streamBadgePlacement === 'top' ? '6px' : '4px',
        transform: 'scale(0.9)',
        transformOrigin: 'left center',
      }}>
        {badges.map((badge) => {
          const bgColor = badge.color || '#1a1a1a';
          const isLightBg = isLightColor(bgColor);
          const textColor = badge.textColor || (isLightBg ? '#000000' : '#ffffff');
          return badge.imageUrl ? (
            <span
              key={badge.label}
              className="stremio-stream-badge-img"
              style={{
                backgroundColor: bgColor,
                borderColor: badge.borderColor,
                padding: '2px',
                height: '14px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <img src={badge.imageUrl} alt={badge.label} title={badge.label} style={{ height: '100%', objectFit: 'contain' }} />
            </span>
          ) : (
            <span
              key={badge.label}
              className="stremio-stream-badge"
              style={{
                backgroundColor: bgColor,
                color: textColor,
                borderColor: badge.borderColor,
                fontSize: '0.65rem',
                padding: '1px 4px',
                borderRadius: '3px',
              }}
            >
              {badge.label}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="stremio-picker-overlay" onClick={onClose}>
      <div className="stremio-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="stremio-picker-header">
          <h3 className="stremio-picker-title">{i18n.t('stremio:pickAStream')}</h3>
          <button className="stremio-picker-close" onClick={onClose}>✕</button>
        </div>

        <div className="stremio-picker-body">
          {directStreams.length > 0 && (
            <div className="stremio-picker-section">
              <h4 className="stremio-picker-section-title">{i18n.t('stremio:directStreams')}</h4>
              {directStreams.map((s, i) => {
                const name = s.name || '';
                const desc = s.description || s.title || '';
                const displayName = name || desc || `${i18n.t('stremio:streamNum', { num: i + 1 })}`;
                const displayDesc = name ? desc : '';
                return (
                  <div key={`direct-${i}`} className="stremio-picker-item-row">
                    <button className="stremio-picker-item" onClick={() => onSelect(s)}>
                      {streamBadgePlacement === 'top' && renderItemBadges(s)}
                      <div className="stremio-picker-item-name">{displayName}</div>
                      {streamBadgePlacement === 'bottom' && renderItemBadges(s)}
                      {displayDesc && <div className="stremio-picker-item-desc">{displayDesc}</div>}
                      <div className="stremio-picker-item-source">{s.addonName}</div>
                    </button>
                    {s.url && !s.url.startsWith('magnet:') && !s.url.startsWith('infoHash:') && (
                      <button
                        className={`stremio-picker-item-download ${downloadingUrl === s.url ? 'downloading' : ''}`}
                        onClick={(e) => handleDownloadStream(s, e)}
                        disabled={downloadingUrl === s.url}
                        title={i18n.t('stremio:downloadStream')}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {downloadingUrl === s.url ? (
                            <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" style={{ transformOrigin: 'center', animation: 'spin 1.5s linear infinite' }} />
                          ) : (
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3" strokeLinecap="round" strokeLinejoin="round" />
                          )}
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {torrentStreams.length > 0 && (
            <div className="stremio-picker-section">
              <h4 className="stremio-picker-section-title">
                {i18n.t('stremio:torrentStreams', { count: torrentStreams.length })}
                <span className="stremio-picker-section-sub">{i18n.t('stremio:resolvedViaDebrid')}</span>
              </h4>
              {torrentStreams.map((s, i) => {
                const name = s.name || '';
                const desc = s.description || s.title || '';
                const displayName = name || desc || `${i18n.t('stremio:torrentNum', { num: i + 1 })}`;
                const displayDesc = name ? desc : '';
                return (
                  <button key={`torrent-${i}`} className="stremio-picker-item" onClick={() => onSelect(s)}>
                    {streamBadgePlacement === 'top' && renderItemBadges(s)}
                    <div className="stremio-picker-item-name">{displayName}</div>
                    {streamBadgePlacement === 'bottom' && renderItemBadges(s)}
                    {displayDesc && <div className="stremio-picker-item-desc">{displayDesc}</div>}
                    <div className="stremio-picker-item-hash">
                      infoHash: {s.infoHash?.substring(0, 16)}...
                      {s.fileIdx !== undefined && ` | fileIdx: ${s.fileIdx}`}
                    </div>
                    <div className="stremio-picker-item-source">{s.addonName}</div>
                  </button>
                );
              })}
            </div>
          )}

          {streams.length === 0 && (
            <div className="stremio-picker-empty">{i18n.t('stremio:noStreamsAvailable')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
