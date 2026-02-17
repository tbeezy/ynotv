import { useEffect, useMemo } from 'react';
import { useMovieGenres, useMultipleMoviesByGenre } from '../../hooks/useTmdbLists';

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

  async function saveToStorage(genreIds: number[]) {
    if (!window.storage) return;
    await window.storage.updateSettings({ movieGenresEnabled: genreIds });
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Movie Genre Carousels</h3>
        </div>

        <p className="section-description">
          Select which genres to show as carousels on the Movies home page.
          Each selected genre will appear as a Netflix-style row.
        </p>

        {!settingsLoaded || loading || countsLoading ? (
          <div className="loading-state">Loading genres...</div>
        ) : genres.length === 0 ? (
          <div className="empty-state">
            <p>No genres available</p>
            <p className="hint">Unable to load genres from cache</p>
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
                Select All
              </button>
              <button
                type="button"
                className="sync-btn"
                onClick={handleDeselectAll}
                disabled={isNoneSelected}
              >
                Deselect All
              </button>
              <span className="genre-count">
                {enabledGenres?.length || 0} of {availableGenreIds.length} selected
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
                Add a TMDB access token for more genre options.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
