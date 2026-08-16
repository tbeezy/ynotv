import { useEffect, useMemo } from 'react';
import { useMovieGenres, useMultipleMoviesByGenre } from '../../hooks/useTmdbLists';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';

interface MoviesTabProps {
  tmdbApiKey: string | null;
  enabledGenres: number[] | undefined;
  onEnabledGenresChange: (genres: number[]) => void;
  settingsLoaded: boolean;
}

export function MoviesTab({
  tmdbApiKey,
  enabledGenres,
  onEnabledGenresChange,
  settingsLoaded,
}: MoviesTabProps) {
  useTranslation();
  const setMovieGenresEnabled = useSettingsStore((s) => s.setMovieGenresEnabled);
  const { genres, loading } = useMovieGenres(tmdbApiKey);

  // Get all genre IDs to check availability
  const allGenreIds = useMemo(() => genres.map(g => g.id), [genres]);

  // Fetch actual matched content per genre from local library
  const genreData = useMultipleMoviesByGenre(tmdbApiKey, allGenreIds);

  // Check if any genre is still loading
  const countsLoading = Array.from(genreData.values()).some(d => d.loading);

  // Check if a genre has content in local library
  const hasContent = (genreId: number) => {
    const data = genreData.get(genreId);
    return data ? data.items.length > 0 : false;
  };

  // Get available genres (ones with content in local library)
  const availableGenreIds = useMemo(() =>
    genres.filter(g => hasContent(g.id)).map(g => g.id),
    [genres, genreData]
  );

  // Initialize with only genres that have content
  useEffect(() => {
    if (enabledGenres === undefined && genres.length > 0 && !countsLoading && availableGenreIds.length > 0) {
      onEnabledGenresChange(availableGenreIds);
    }
  }, [genres, enabledGenres, onEnabledGenresChange, availableGenreIds, countsLoading]);

  const isAllSelected = enabledGenres && availableGenreIds.length > 0 &&
    availableGenreIds.every(id => enabledGenres.includes(id));
  const isNoneSelected = !enabledGenres || enabledGenres.length === 0;

  function handleToggleGenre(genreId: number) {
    if (!hasContent(genreId)) return; // Don't allow toggling unavailable genres
    const current = enabledGenres || [];
    const newEnabled = current.includes(genreId)
      ? current.filter(id => id !== genreId)
      : [...current, genreId];
    onEnabledGenresChange(newEnabled);
    saveToStorage(newEnabled);
  }

  function handleSelectAll() {
    onEnabledGenresChange(availableGenreIds);
    saveToStorage(availableGenreIds);
  }

  function handleDeselectAll() {
    onEnabledGenresChange([]);
    saveToStorage([]);
  }

  function saveToStorage(genreIds: number[]) {
    setMovieGenresEnabled(genreIds);
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:movies.genreCarousels')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:movies.genreCarouselsSub')}
        </p>

        {!settingsLoaded || loading || countsLoading ? (
          <div className="loading-state">{i18n.t('settings:movies.loadingGenres')}</div>
        ) : genres.length === 0 ? (
          <div className="empty-state">
            <p>{i18n.t('settings:movies.noGenres')}</p>
            <p className="hint">{i18n.t('settings:movies.noGenresHint')}</p>
          </div>
        ) : (
          <>
            <div className="genre-actions">
              <button
                type="button"
                className="sync-btn"
                onClick={handleSelectAll}
                disabled={isAllSelected}
              >
                {i18n.t('settings:movies.selectAll')}
              </button>
              <button
                type="button"
                className="sync-btn"
                onClick={handleDeselectAll}
                disabled={isNoneSelected}
              >
                {i18n.t('settings:movies.deselectAll')}
              </button>
              <span className="genre-count">
                {i18n.t('settings:movies.selectedCount', { count: enabledGenres?.length || 0, total: availableGenreIds.length })}
              </span>
            </div>

            <div className="genre-grid-container">
              <div className="genre-grid">
                {genres.map(genre => {
                  const available = hasContent(genre.id);
                  return (
                    <label
                      key={genre.id}
                      className={`genre-checkbox ${!available ? 'genre-checkbox--disabled' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={available && (enabledGenres?.includes(genre.id) ?? true)}
                        onChange={() => handleToggleGenre(genre.id)}
                        disabled={!available}
                      />
                      <span className="genre-name">{genre.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {!tmdbApiKey && (
              <p className="settings-disclaimer">
                {i18n.t('settings:movies.tmdbHint')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
