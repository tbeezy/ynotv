import { useState, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { IdentifyResolution, LocalEntry } from '../../services/local-library/types';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';

interface IdentifyModalProps {
  target: LocalEntry[] | null;
  onClose: () => void;
  onResolved: (ids: string[], resolution: IdentifyResolution) => void;
}

type Candidate = {
  tmdbId: number;
  title: string;
  year: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  rating?: number;
};

function seedQuery(title: string, filename?: string): string {
  let raw = title || filename || '';
  raw = raw.replace(/\.(mkv|mp4|m4v|mov|avi|wmv|webm|ts|m2ts|mpg|mpeg|flv|ogv)$/i, '');
  return (
    raw
      .replace(/^s\d{1,2}[\s._-]*e\d{1,3}[\s._-]*/i, '')
      .replace(/^episode[\s._-]*\d{1,3}[\s._-]*/i, '')
      .replace(/^ep[\s._-]*\d{1,3}[\s._-]*/i, '')
      .replace(/\bs\d{1,2}[\s._-]*e\d{1,3}.*$/i, '')
      .replace(/\b\d{1,2}x\d{1,3}.*$/i, '')
      .replace(/\bseason[\s._-]*\d.*$/i, '')
      .trim() || raw
  );
}

function getTmdbHeadersAndParams(token: string): { headers: Record<string, string>; queryParam?: { key: string; value: string } } {
  const isBearer = token.length > 40 && token.includes('.');
  if (isBearer) {
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
  }
  return {
    headers: {
      'Content-Type': 'application/json',
    },
    queryParam: { key: 'api_key', value: token },
  };
}

export const IdentifyModal = memo(function IdentifyModal({
  target,
  onClose,
  onResolved,
}: IdentifyModalProps) {
  const { t } = useTranslation('vod');
  const tmdbToken = useActiveTmdbToken();
  const head = target && target.length > 0 ? target[0] : null;

  const [kind, setKind] = useState<'movie' | 'tv'>('movie');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);

  useEffect(() => {
    if (!head) return;
    const isMulti = target && target.length > 1;
    setKind(isMulti || head.type === 'show' ? 'tv' : 'movie');
    setQuery(seedQuery(head.title ?? '', head.filename));
    setResults([]);
  }, [head?.id, target?.length]);

  useEffect(() => {
    if (!head || !tmdbToken) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }

    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { headers, queryParam } = getTmdbHeadersAndParams(tmdbToken);
        const params = new URLSearchParams({ query: q, include_adult: 'false' });
        if (queryParam) params.set(queryParam.key, queryParam.value);

        const r = await fetch(`https://api.themoviedb.org/3/search/${kind}?${params}`, { headers });
        if (r.ok && alive) {
          const json = await r.json();
          const items: Candidate[] = (json.results ?? []).slice(0, 20).map((item: any) => {
            const date = item.release_date || item.first_air_date;
            return {
              tmdbId: item.id,
              title: item.title || item.name || '',
              year: date ? date.slice(0, 4) : null,
              posterPath: item.poster_path || null,
              backdropPath: item.backdrop_path || null,
              overview: item.overview || '',
              rating: typeof item.vote_average === 'number' ? item.vote_average : undefined,
            };
          });
          setResults(items);
        }
      } catch {
        /* noop */
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [head?.id, tmdbToken, kind, query]);

  if (!head || !target) return null;

  const handlePick = async (c: Candidate) => {
    setPicking(c.tmdbId);
    let imdbId: string | null = null;
    let runtime: number | undefined;

    if (tmdbToken) {
      try {
        const { headers, queryParam } = getTmdbHeadersAndParams(tmdbToken);
        const dparams = new URLSearchParams({ append_to_response: 'external_ids' });
        if (queryParam) dparams.set(queryParam.key, queryParam.value);
        const dr = await fetch(`https://api.themoviedb.org/3/${kind}/${c.tmdbId}?${dparams}`, { headers });
        if (dr.ok) {
          const dj = await dr.json();
          const imdb = dj.imdb_id ?? dj.external_ids?.imdb_id;
          if (typeof imdb === 'string' && imdb.startsWith('tt')) imdbId = imdb;
          if (typeof dj.runtime === 'number') runtime = dj.runtime;
        }
      } catch {
        /* noop */
      }
    }

    onResolved(
      target.map((e) => e.id),
      {
        tmdbId: c.tmdbId,
        imdbId,
        poster: c.posterPath ? `https://image.tmdb.org/t/p/w342${c.posterPath}` : null,
        backdrop: c.backdropPath ? `https://image.tmdb.org/t/p/w1280${c.backdropPath}` : null,
        title: c.title || head.title,
        year: c.year ? parseInt(c.year, 10) : head.year,
        type: kind === 'tv' ? 'show' : 'movie',
        overview: c.overview || null,
        rating: c.rating ?? null,
        runtime: runtime ?? null,
      },
    );

    setPicking(null);
    onClose();
  };

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '620px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div>
            <h3 className="local-modal-title">
              {target.length > 1
                ? t('identifyBatchTitle', 'Identify {{count}} files', { count: target.length })
                : t('identifyTitle', 'What is this title?')}
            </h3>
            <p className="local-modal-subtitle">
              {target.length > 1
                ? `${target.length} ${t('filesSelected', 'files selected for matching')} · ${head.filename}`
                : head.filename}
            </p>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body">
          {/* Type Toggle: Movie / Series */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className={`local-btn ${kind === 'movie' ? 'local-btn--primary' : 'local-btn--secondary'}`}
              onClick={() => setKind('movie')}
            >
              {t('movie', 'Movie')}
            </button>
            <button
              type="button"
              className={`local-btn ${kind === 'tv' ? 'local-btn--primary' : 'local-btn--secondary'}`}
              onClick={() => setKind('tv')}
            >
              {t('series', 'Series')}
            </button>
          </div>

          {/* Search Input */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchTmdb', 'Search TMDB...')}
              className="local-toolbar__search-input"
              style={{ height: '42px', borderRadius: '12px', paddingLeft: '38px' }}
            />
            <span className="local-toolbar__search-icon" style={{ left: '12px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
          </div>

          {/* Candidates List */}
          {!tmdbToken ? (
            <p style={{ color: '#ef4444', fontSize: '13px', background: 'rgba(239,68,68,0.1)', padding: '12px', borderRadius: '10px' }}>
              {t('addTmdbKeyPrompt', 'Add a TMDB API Key in Settings to search and identify titles.')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '45vh', overflowY: 'auto' }}>
              {loading && results.length === 0 && (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
                  {t('searching', 'Searching...')}
                </p>
              )}

              {!loading && results.length === 0 && query.trim() && (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
                  {t('noMatchesFound', 'No matches found. Try another search query.')}
                </p>
              )}

              {results.map((c) => (
                <div
                  key={c.tmdbId}
                  onClick={() => handlePick(c)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '14px',
                    padding: '10px',
                    borderRadius: '12px',
                    background: 'var(--surface-color, rgba(40,40,40,0.5))',
                    border: '1px solid var(--surface-border, rgba(255,255,255,0.08))',
                    cursor: picking != null ? 'wait' : 'pointer',
                    transition: 'background 0.15s ease',
                  }}
                >
                  <div style={{ width: '48px', height: '72px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0, background: '#111' }}>
                    {c.posterPath ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w185${c.posterPath}`}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        loading="lazy"
                      />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)' }}>
                        🎬
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {c.title}
                      </span>
                      {c.year && (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          ({c.year})
                        </span>
                      )}
                      {c.rating && c.rating > 0 && (
                        <span style={{ fontSize: '11px', color: 'var(--accent-primary, #00d4ff)', fontWeight: 600 }}>
                          ★ {c.rating.toFixed(1)}
                        </span>
                      )}
                    </div>
                    {c.overview && (
                      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.4 }}>
                        {c.overview}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
