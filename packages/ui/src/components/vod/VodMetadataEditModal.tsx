import { useState, useEffect, useRef } from 'react';
import type { StoredMovie, StoredSeries } from '../../db';
import {
  useVodMetadataOverridesStore,
  overrideKey,
  type VodMediaType,
} from '../../stores/vodMetadataOverridesStore';
import { useTmdbApiKey } from '../../hooks/useTmdbLists';
import { searchMovies, searchTvShows, getTmdbImageUrl } from '../../services/tmdb';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './VodMetadataEditModal.css';

export interface VodMetadataEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: StoredMovie | StoredSeries;
  type: 'movie' | 'series';
}

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
}

export function VodMetadataEditModal({ isOpen, onClose, item, type }: VodMetadataEditModalProps) {
  useTranslation();
  const tmdbKey = useTmdbApiKey();
  const hasTmdbKey = Boolean(tmdbKey && tmdbKey.trim() !== '');

  const mediaId = type === 'movie' ? (item as StoredMovie).stream_id : (item as StoredSeries).series_id;

  const override = useVodMetadataOverridesStore((s) => s.overrides[overrideKey(mediaId, type as VodMediaType)]);
  const hasOverride = Boolean(override);

  // Form fields
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [poster, setPoster] = useState('');
  const [plot, setPlot] = useState('');
  const [tmdbId, setTmdbId] = useState('');

  // TMDB search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Initialize the form only when the modal opens (not on every re-render).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!justOpened) return;
    setTitle(override?.title ?? item.title ?? item.name ?? '');
    setYear(override?.year ?? String((item as any).year ?? '').replace(/"/g, ''));
    setPoster(override?.poster ?? (type === 'movie' ? (item as StoredMovie).stream_icon : (item as StoredSeries).cover) ?? '');
    setPlot(override?.plot ?? item.plot ?? '');
    setTmdbId(override?.tmdb_id ? String(override.tmdb_id) : (item.tmdb_id ? String(item.tmdb_id) : ''));
    setSearchQuery('');
    setSearchResults([]);
    setSearchError(false);
    setSaved(false);
  }, [isOpen, override, item, type]);

  if (!isOpen) return null;

  const runSearch = async () => {
    if (!tmdbKey || !searchQuery.trim()) return;
    setSearching(true);
    setSearchError(false);
    try {
      const results = type === 'movie'
        ? await searchMovies(tmdbKey, searchQuery.trim())
        : await searchTvShows(tmdbKey, searchQuery.trim());
      setSearchResults((results as unknown as TmdbSearchResult[]) ?? []);
    } catch (e) {
      console.error('[VodMetadataEdit] TMDB search failed:', e);
      setSearchError(true);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const applyResult = (r: TmdbSearchResult) => {
    const posterPath = r.poster_path || r.backdrop_path;
    setTitle(r.title || r.name || '');
    setYear((r.release_date || r.first_air_date || '').slice(0, 4));
    setPoster(posterPath ? getTmdbImageUrl(posterPath, 'original') || '' : '');
    setPlot(r.overview || '');
    setTmdbId(String(r.id));
    setSearchResults([]);
    setSearchQuery(r.title || r.name || '');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await useVodMetadataOverridesStore.getState().setOverride(mediaId, type as VodMediaType, {
        title: title.trim() || null,
        year: year.trim() || null,
        poster: poster.trim() || null,
        plot: plot.trim() || null,
        tmdb_id: tmdbId ? Number(tmdbId) || null : null,
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onClose();
      }, 900);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    await useVodMetadataOverridesStore.getState().clearOverride(mediaId, type as VodMediaType);
    onClose();
  };

  const resultYear = (r: TmdbSearchResult) => (r.release_date || r.first_air_date || '').slice(0, 4);

  return (
    <div className="vod-metadata-edit-overlay" onClick={onClose}>
      <div className="vod-metadata-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vod-metadata-edit-modal__header">
          <h3 className="vod-metadata-edit-modal__title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {i18n.t('vod:editMetadataTitle')}
          </h3>
          <button className="vod-metadata-edit-modal__close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="vod-metadata-edit-modal__body">
          {/* TMDB search — only when a TMDB API key is configured */}
          {hasTmdbKey ? (
            <div className="vod-metadata-tmdb-section">
              <div className="vod-metadata-tmdb-search">
                <input
                  type="text"
                  className="vod-metadata-tmdb-input"
                  placeholder={i18n.t('vod:editMetadataTmdbSearchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                />
                <button
                  type="button"
                  className="vod-metadata-tmdb-btn"
                  onClick={runSearch}
                  disabled={searching || !searchQuery.trim()}
                >
                  {searching ? i18n.t('vod:editMetadataSearching') : i18n.t('vod:editMetadataTmdbSearchBtn')}
                </button>
              </div>

              {searchError && (
                <p className="vod-metadata-tmdb-error">{i18n.t('vod:editMetadataSearchError')}</p>
              )}

              {!searching && !searchError && searchResults.length === 0 && searchQuery && (
                <p className="vod-metadata-tmdb-empty">{i18n.t('vod:editMetadataNoResults')}</p>
              )}

              {searchResults.length > 0 && (
                <div className="vod-metadata-tmdb-results">
                  {searchResults.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="vod-metadata-tmdb-result"
                      onClick={() => applyResult(r)}
                    >
                      {r.poster_path ? (
                        <img
                          src={getTmdbImageUrl(r.poster_path, 'w92') || ''}
                          alt=""
                          className="vod-metadata-tmdb-result__poster"
                        />
                      ) : (
                        <div className="vod-metadata-tmdb-result__poster vod-metadata-tmdb-result__poster--placeholder">
                          {(r.title || r.name || '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="vod-metadata-tmdb-result__info">
                        <span className="vod-metadata-tmdb-result__name">{r.title || r.name}</span>
                        {resultYear(r) && (
                          <span className="vod-metadata-tmdb-result__year">{resultYear(r)}</span>
                        )}
                      </span>
                      <span className="vod-metadata-tmdb-result__use">{i18n.t('vod:editMetadataUseResult')}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="vod-metadata-tmdb-hint">{i18n.t('vod:editMetadataNoTmdbKey')}</p>
          )}

          {/* Manual fields */}
          <div className="vod-metadata-fields">
            <label className="vod-metadata-field">
              <span className="vod-metadata-field__label">{i18n.t('vod:editMetadataFieldTitle')}</span>
              <input
                type="text"
                className="vod-metadata-field__input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            <div className="vod-metadata-field-row">
              <label className="vod-metadata-field">
                <span className="vod-metadata-field__label">{i18n.t('vod:editMetadataFieldYear')}</span>
                <input
                  type="text"
                  className="vod-metadata-field__input"
                  value={year}
                  placeholder="2024"
                  onChange={(e) => setYear(e.target.value)}
                />
              </label>
              <label className="vod-metadata-field">
                <span className="vod-metadata-field__label">{i18n.t('vod:editMetadataTmdbId')}</span>
                <input
                  type="text"
                  className="vod-metadata-field__input"
                  value={tmdbId}
                  placeholder="12345"
                  onChange={(e) => setTmdbId(e.target.value.replace(/[^0-9]/g, ''))}
                />
              </label>
            </div>

            <label className="vod-metadata-field">
              <span className="vod-metadata-field__label">{i18n.t('vod:editMetadataFieldPoster')}</span>
              <input
                type="text"
                className="vod-metadata-field__input"
                value={poster}
                placeholder="https://..."
                onChange={(e) => setPoster(e.target.value)}
              />
            </label>

            <label className="vod-metadata-field">
              <span className="vod-metadata-field__label">{i18n.t('vod:editMetadataFieldPlot')}</span>
              <textarea
                className="vod-metadata-field__textarea"
                value={plot}
                rows={3}
                onChange={(e) => setPlot(e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="vod-metadata-edit-modal__footer">
          {hasOverride && (
            <button
              type="button"
              className="vod-metadata-edit-reset"
              onClick={handleReset}
            >
              {i18n.t('vod:editMetadataReset')}
            </button>
          )}
          <div className="vod-metadata-edit-footer-actions">
            <button type="button" className="vod-metadata-edit-cancel" onClick={onClose}>
              {i18n.t('vod:editMetadataCancel')}
            </button>
            <button
              type="button"
              className="vod-metadata-edit-save"
              onClick={handleSave}
              disabled={saving}
            >
              {saved ? `✓ ${i18n.t('vod:editMetadataSaved')}` : saving ? '...' : i18n.t('vod:editMetadataSave')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VodMetadataEditModal;
