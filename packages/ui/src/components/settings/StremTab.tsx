import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import type { StremioStreamPickerMode, BadgeSource } from '../../types/stremio';
import { parseBadgePayload, isLightColor, convertArgbToRgba } from '../../utils/streamBadges';

interface StremTabProps {
  stremioStreamPickerMode: StremioStreamPickerMode;
  onStremioStreamPickerModeChange: (mode: StremioStreamPickerMode) => Promise<void>;
  showStremioStreamBadges: boolean;
  onShowStremioStreamBadgesChange: (show: boolean) => Promise<void>;
  badgeSources: BadgeSource[];
  onBadgeSourcesChange: (sources: BadgeSource[]) => Promise<void>;
  stremioBadgeSize: number;
  onStremioBadgeSizeChange: (size: number) => void;
  showHoverDetails: boolean;
  onShowHoverDetailsChange: (show: boolean) => Promise<void>;
  showFileSizeBadges: boolean;
  onShowFileSizeBadgesChange: (show: boolean) => Promise<void> | void;
  streamBadgePlacement: 'top' | 'bottom';
  onStreamBadgePlacementChange: (placement: 'top' | 'bottom') => Promise<void> | void;
  stremioCacheFetchResults: boolean;
  onStremioCacheFetchResultsChange: (enabled: boolean) => Promise<void> | void;
  stremioCacheFetchTimeout: number;
  onStremioCacheFetchTimeoutChange: (timeout: number) => Promise<void> | void;
}

export function StremTab({
  stremioStreamPickerMode,
  onStremioStreamPickerModeChange,
  showStremioStreamBadges,
  onShowStremioStreamBadgesChange,
  badgeSources,
  onBadgeSourcesChange,
  stremioBadgeSize,
  onStremioBadgeSizeChange,
  showHoverDetails,
  onShowHoverDetailsChange,
  showFileSizeBadges,
  onShowFileSizeBadgesChange,
  streamBadgePlacement,
  onStreamBadgePlacementChange,
  stremioCacheFetchResults,
  onStremioCacheFetchResultsChange,
  stremioCacheFetchTimeout,
  onStremioCacheFetchTimeoutChange,
}: StremTabProps) {
  useTranslation();
  const [badgeUrl, setBadgeUrl] = useState('');
  const [badgePaste, setBadgePaste] = useState('');
  const [badgeImportError, setBadgeImportError] = useState('');
  const [badgeImporting, setBadgeImporting] = useState(false);
  const [expandedSourceUrl, setExpandedSourceUrl] = useState<string | null>(null);

  const handleImportBadge = useCallback(async () => {
    setBadgeImportError('');
    const url = badgeUrl.trim();
    const paste = badgePaste.trim();
    if (!url && !paste) {
      setBadgeImportError(i18n.t('settings:strem.errBadgeInput'));
      return;
    }

    setBadgeImporting(true);
    try {
      let payloadStr = paste;
      let sourceUrl = url;
      let sourceName = '';
      if (paste) {
        sourceUrl = `pasted_${Date.now()}`;
        const pastedCount = badgeSources.filter((s) => s.url.startsWith('pasted_')).length + 1;
        sourceName = `${i18n.t('settings:strem.pastedRule', { count: pastedCount })}`;
      } else {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          setBadgeImportError(i18n.t('settings:strem.errBadgeUrl'));
          setBadgeImporting(false);
          return;
        }
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        payloadStr = await resp.text();
        sourceName = url.split('/').pop() || url;
      }

      const payload = parseBadgePayload(payloadStr);
      const newSource: BadgeSource = {
        url: sourceUrl,
        name: sourceName,
        payload,
        isActive: true,
      };

      const updated = badgeSources.filter(
        (s) => s.url.toLowerCase() !== newSource.url.toLowerCase(),
      );
      updated.push(newSource);

      await onBadgeSourcesChange(updated);
      setBadgeUrl('');
      setBadgePaste('');
    } catch (err: any) {
      setBadgeImportError(translateNativeError(err?.message) || i18n.t('settings:strem.errImportFailed'));
    } finally {
      setBadgeImporting(false);
    }
  }, [badgeUrl, badgePaste, badgeSources, onBadgeSourcesChange]);

  const handleToggleSource = useCallback(
    async (url: string) => {
      const updated = badgeSources.map((s) => ({
        ...s,
        isActive: s.url === url ? !s.isActive : s.isActive,
      }));
      await onBadgeSourcesChange(updated);
    },
    [badgeSources, onBadgeSourcesChange],
  );

  const handleDeleteSource = useCallback(
    async (url: string) => {
      const updated = badgeSources.filter((s) => s.url !== url);
      await onBadgeSourcesChange(updated);
    },
    [badgeSources, onBadgeSourcesChange],
  );

  return (
    <div className="settings-tab-content strem-settings-tab">
      <div className="settings-section">
      <h3 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
        {i18n.t('settings:strem.title')}
      </h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
        {i18n.t('settings:strem.description')}
      </p>
      <div className="retry-setting-row" style={{ borderBottom: 'none' }}>
        <div className="timeshift-toggle-info">
          <span className="timeshift-toggle-label">{i18n.t('settings:strem.pickerMode')}</span>
          <span className="timeshift-toggle-sub">
            {i18n.t('settings:strem.pickerModeSub')}
          </span>
        </div>
        <div className="stremio-picker-toggle">
          <button
            className={`stremio-picker-btn ${stremioStreamPickerMode === 'modal' ? 'active' : ''}`}
            onClick={() => onStremioStreamPickerModeChange('modal')}
          >
            {i18n.t('settings:strem.showPicker')}
          </button>
          <button
            className={`stremio-picker-btn ${stremioStreamPickerMode === 'autoplay' ? 'active' : ''}`}
            onClick={() => onStremioStreamPickerModeChange('autoplay')}
          >
            {i18n.t('settings:strem.autoPlay')}
          </button>
        </div>
      </div>

      <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '20px' }}>
        <div className="timeshift-toggle-info">
          <span className="timeshift-toggle-label">{i18n.t('settings:strem.hoverDetails')}</span>
          <span className="timeshift-toggle-sub">{i18n.t('settings:strem.hoverDetailsSub')}</span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={showHoverDetails}
            onChange={(e) => onShowHoverDetailsChange(e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {/* Cache Fetch Results section for Stremio */}
      <div style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '20px', marginTop: '20px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
          {i18n.t('settings:strem.cacheTitle')}
        </h3>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {i18n.t('settings:strem.cacheDescription')}
        </p>

        <div className="retry-setting-row" style={{ borderBottom: 'none' }}>
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:strem.cacheResults')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:strem.cacheResultsSub')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={stremioCacheFetchResults}
              onChange={(e) => onStremioCacheFetchResultsChange(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {stremioCacheFetchResults && (
          <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:strem.cacheExpiration', { minutes: stremioCacheFetchTimeout })}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:strem.cacheExpirationSub')}</span>
            </div>
            <input
              type="range"
              min="1"
              max="30"
              step="1"
              value={stremioCacheFetchTimeout}
              onChange={(e) => onStremioCacheFetchTimeoutChange(Number(e.target.value))}
              style={{
                width: '120px',
                accentColor: '#00d4ff',
              }}
            />
          </div>
        )}
      </div>

      <h3 style={{ margin: '24px 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
        {i18n.t('settings:strem.badgesTitle')}
      </h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
        Show quality, codec, HDR and audio badges on stream links, or import custom badge rules.
      </p>

      <div className="retry-setting-row" style={{ borderBottom: 'none' }}>
        <div className="timeshift-toggle-info">
          <span className="timeshift-toggle-label">{i18n.t('settings:strem.enableBadgesLabel')}</span>
          <span className="timeshift-toggle-sub">{i18n.t('settings:strem.enableBadgesLabelSub')}</span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={showStremioStreamBadges}
            onChange={(e) => onShowStremioStreamBadgesChange(e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {showStremioStreamBadges && (
        <>
          <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:strem.fileSizeBadges')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:strem.fileSizeBadgesSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={showFileSizeBadges}
                onChange={(e) => onShowFileSizeBadgesChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:strem.badgePosition')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:strem.badgePositionSub')}</span>
            </div>
            <select
              value={streamBadgePlacement}
              onChange={(e) => onStreamBadgePlacementChange(e.target.value as 'top' | 'bottom')}
              style={{
                background: 'var(--surface-color)',
                border: '1px solid var(--surface-border)',
                color: 'var(--text-primary)',
                borderRadius: '6px',
                padding: '6px 10px',
                fontSize: '0.8rem',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="bottom" style={{ background: 'var(--surface-color)' }}>{i18n.t('settings:strem.bottomBelow')}</option>
              <option value="top" style={{ background: 'var(--surface-color)' }}>{i18n.t('settings:strem.topAbove')}</option>
            </select>
          </div>

          <div className="retry-setting-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <span className="timeshift-toggle-label" style={{ fontSize: '0.85rem' }}>{i18n.t('settings:strem.badgeScale', { percent: stremioBadgeSize })}</span>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', width: '100%', boxSizing: 'border-box' }}>
            <input
              type="range"
              min="80"
              max="180"
              step="5"
              value={stremioBadgeSize}
              onChange={(e) => onStremioBadgeSizeChange(Number(e.target.value))}
              style={{
                flex: 1,
                accentColor: '#00d4ff',
                cursor: 'pointer',
                height: '6px',
                borderRadius: '3px',
                background: 'var(--surface-color)',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--surface-border)', width: '100%', boxSizing: 'border-box' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 700, letterSpacing: '0.05em' }}>
              {i18n.t('settings:strem.livePreview')}
            </div>
            <div className="stremio-detail-stream-badges" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                <img src="https://raw.githubusercontent.com/nobnobz/Omni-Template-Bot-Bid-Raiser/main/Other/regex%20tags/4k.png" alt="4K" />
              </span>
              <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                <img src="https://raw.githubusercontent.com/nobnobz/Omni-Template-Bot-Bid-Raiser/main/Other/regex%20tags/HDR.png" alt="HDR" />
              </span>
              <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                <img src="https://raw.githubusercontent.com/ngreyx1/badges/refs/heads/main/images%20w:o%20logo/webdl-black.png" alt="WEB-DL" />
              </span>
              <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                <img src="https://raw.githubusercontent.com/nobnobz/Omni-Template-Bot-Bid-Raiser/main/Other/regex%20tags/51.png" alt="5.1" />
              </span>
            </div>
          </div>
        </div>
      </>
      )}

      {/* Custom Badge Import */}
      <div style={{ marginTop: '20px', borderTop: '1px solid var(--surface-border)', paddingTop: '16px' }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
          {i18n.t('settings:strem.fusionBadges')}
        </div>

        <input
          type="text"
          placeholder={i18n.t('settings:strem.badgeUrlPlaceholder')}
          value={badgeUrl}
          onChange={(e) => setBadgeUrl(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--surface-color)',
            border: '1px solid var(--surface-border)',
            color: 'var(--text-primary)',
            borderRadius: '6px',
            padding: '8px 10px',
            fontSize: '0.8rem',
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: '8px',
          }}
        />

        <textarea
          placeholder={i18n.t('settings:strem.badgePastePlaceholder')}
          value={badgePaste}
          onChange={(e) => setBadgePaste(e.target.value)}
          rows={3}
          style={{
            width: '100%',
            background: 'var(--surface-color)',
            border: '1px solid var(--surface-border)',
            color: 'var(--text-primary)',
            borderRadius: '6px',
            padding: '8px 10px',
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            outline: 'none',
            boxSizing: 'border-box',
            resize: 'vertical',
            marginBottom: '8px',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <button
            onClick={handleImportBadge}
            disabled={badgeImporting}
            style={{
              background: 'var(--surface-glow)',
              border: '1px solid var(--accent-glow)',
              color: '#00d4ff',
              borderRadius: '6px',
              padding: '7px 16px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: badgeImporting ? 'not-allowed' : 'pointer',
              opacity: badgeImporting ? 0.6 : 1,
            }}
          >
            {badgeImporting ? i18n.t('common:importing') : i18n.t('common:import')}
          </button>
          {badgeImportError && (
            <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>{badgeImportError}</span>
          )}
        </div>

        {/* Imported Sources List */}
        {badgeSources.length > 0 && (
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.05em' }}>
              {i18n.t('settings:strem.importedSources')}
            </div>
            {badgeSources.map((source) => {
              const isExpanded = expandedSourceUrl === source.url;
              return (
                <div
                  key={source.url}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'var(--surface-color)',
                    border: `1px solid ${source.isActive ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                    marginBottom: '4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div
                      onClick={() => setExpandedSourceUrl(isExpanded ? null : source.url)}
                      style={{ flex: 1, overflow: 'hidden', cursor: 'pointer' }}
                    >
                      <div style={{
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}>
                        <span>{source.name}</span>
                        <span style={{
                          fontSize: '0.55rem',
                          color: 'var(--text-muted)',
                          transform: isExpanded ? 'rotate(90deg)' : 'none',
                          transition: 'transform 0.15s',
                          display: 'inline-block',
                        }}>
                          ▶
                        </span>
                      </div>
                      <div style={{
                        fontSize: '0.65rem',
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {i18n.t('settings:strem.filtersGroups', { filters: source.payload.filters.length, groups: source.payload.groups.length })}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginLeft: '8px' }}>
                      <button
                        onClick={() => handleToggleSource(source.url)}
                        title={source.isActive ? i18n.t('common:active') : i18n.t('settings:strem.clickToActivate')}
                        style={{
                          background: source.isActive ? 'var(--surface-glow)' : 'var(--surface-color)',
                          border: `1px solid ${source.isActive ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                          color: source.isActive ? 'var(--accent-primary)' : 'var(--text-muted)',
                          borderRadius: '4px',
                          padding: '3px 8px',
                          fontSize: '0.7rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {source.isActive ? i18n.t('common:active') : i18n.t('common:inactive')}
                      </button>
                      {!source.isDefault && (
                        <button
                          onClick={() => handleDeleteSource(source.url)}
                          title={i18n.t('common:remove')}
                          style={{
                            background: 'rgba(239,68,68,0.1)',
                            border: '1px solid rgba(239,68,68,0.2)',
                            color: '#ef4444',
                            borderRadius: '4px',
                            padding: '3px 8px',
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {i18n.t('common:delete')}
                        </button>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{
                      marginTop: '8px',
                      paddingTop: '8px',
                      borderTop: '1px solid var(--surface-border)',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 700, letterSpacing: '0.03em' }}>
                        {i18n.t('settings:strem.previewBadges', { count: source.payload.filters.length })}:
                      </div>
                      <div className="stremio-detail-stream-badges" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {source.payload.filters.map((filter, fIdx) => {
                          const bgColor = convertArgbToRgba(filter.tagColor) || '#1a1a1a';
                          const isLightBg = isLightColor(bgColor);
                          const textColor = convertArgbToRgba(filter.textColor) || (isLightBg ? '#000000' : '#ffffff');
                          const borderColor = convertArgbToRgba(filter.borderColor) || 'transparent';

                          return filter.imageURL ? (
                            <span
                              key={filter.id || fIdx}
                              className="stremio-stream-badge-img"
                              style={{
                                backgroundColor: bgColor,
                                borderColor: borderColor,
                              }}
                            >
                              <img src={filter.imageURL} alt={filter.name} title={filter.name} />
                            </span>
                          ) : (
                            <span
                              key={filter.id || fIdx}
                              className="stremio-stream-badge"
                              style={{
                                backgroundColor: bgColor,
                                color: textColor,
                                borderColor: borderColor,
                              }}
                            >
                              {filter.name}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  </div>
);
}
