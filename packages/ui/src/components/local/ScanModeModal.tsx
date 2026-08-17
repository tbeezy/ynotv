import { memo } from 'react';
import { useTranslation } from 'react-i18next';

export type ScanMode = 'nfo' | 'tmdb';

interface ScanModeModalProps {
  isOpen: boolean;
  nfoCount: number;
  onPick: (mode: ScanMode) => void;
  onClose: () => void;
}

export const ScanModeModal = memo(function ScanModeModal({
  isOpen,
  nfoCount,
  onPick,
  onClose,
}: ScanModeModalProps) {
  const { t } = useTranslation('vod');

  if (!isOpen) return null;

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '480px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div>
            <h3 className="local-modal-title">{t('scanModeTitle', 'NFO files found')}</h3>
            <p className="local-modal-subtitle">
              {t('scanModeSubtitle', 'We found {count} .nfo metadata files in this folder. How would you like to import them?', { count: nfoCount })}
            </p>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body" style={{ gap: '12px' }}>
          <button
            type="button"
            onClick={() => onPick('nfo')}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '16px',
              borderRadius: '14px',
              background: 'var(--surface-color, rgba(40,40,40,0.5))',
              border: '1px solid var(--accent-primary, #00d4ff)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('useNfoMode', 'Use .nfo & Local Artwork')}
            </span>
            <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {t('useNfoModeDesc', 'Fastest. Uses your existing sidecar NFOs and local posters/backdrops with TMDB fallback for missing info.')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onPick('tmdb')}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '16px',
              borderRadius: '14px',
              background: 'var(--surface-color, rgba(40,40,40,0.5))',
              border: '1px solid var(--surface-border, rgba(255,255,255,0.1))',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('useTmdbMode', 'Scan Online with TMDB')}
            </span>
            <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {t('useTmdbModeDesc', 'Parses filenames and fetches fresh artwork, ratings, cast, and overviews online from TMDB.')}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
});
