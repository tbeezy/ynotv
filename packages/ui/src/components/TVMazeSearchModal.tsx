import { invoke } from '@tauri-apps/api/core';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './TVMazeSearchModal.css';

interface ShowResult {
  score: number;
  show: {
    id: number;
    name: string;
    status?: string;
    network?: { name: string };
    image?: { medium?: string };
    summary?: string;
  };
}

interface Props {
  programTitle: string;
  channelName?: string;
  channelId?: string;
  onClose: () => void;
}

export function TVMazeSearchModal({ programTitle, channelName, channelId, onClose }: Props) {
  console.log('[TVMaze] Modal opened with:', { programTitle, channelName, channelId });
  const [query, setQuery] = useState(programTitle);
  const [results, setResults] = useState<ShowResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  console.log('[TVMaze] Component rendering, results count:', results.length);

  useEffect(() => {
    console.log('[TVMaze] Initial search for:', programTitle);
    handleSearch();
  }, []);

  useEffect(() => {
    console.log('[TVMaze] Results changed:', results.length);
  }, [results]);

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<ShowResult[]>('search_tvmaze', { query: query.trim() });
      setResults(res.slice(0, 6));
    } catch (e: any) {
      setError(e?.toString() || 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(show: ShowResult['show']) {
    console.log('[TVMaze] Adding show:', {
      tvmazeId: show.id,
      showName: show.name,
      channelName,
      channelId,
      status: show.status
    });
    setAdding(show.id);
    try {
      const result = await invoke('add_tv_favorite', {
        tvmazeId: show.id,
        showName: show.name,
        showImage: show.image?.medium ?? null,
        channelName: channelName ?? null,
        channelId: channelId ?? null,
        status: show.status ?? null,
      });
      console.log('[TVMaze] Add success:', result);
      onClose();
    } catch (e: any) {
      console.error('[TVMaze] Add failed:', e);
      setError(e?.toString() || 'Failed to add show');
    } finally {
      setAdding(null);
    }
  }

  return createPortal(
    <div className="tvmaze-overlay" onMouseDown={e => e.stopPropagation()} onClick={onClose}>
      <div className="tvmaze-modal" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        <div className="tvmaze-header">
          <h2>Track Show</h2>
          <button className="tvmaze-close" onClick={onClose}>✕</button>
        </div>
        <div className="tvmaze-search-row">
          <input
            className="tvmaze-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            autoFocus
          />
          <button className="tvmaze-search-btn" onClick={handleSearch} disabled={loading}>
            {loading ? '…' : 'Search'}
          </button>
        </div>
        {error && <div className="tvmaze-error">{error}</div>}
        <div style={{ padding: '0 20px', color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }}>
          Click a show below to track it
        </div>
        <div className="tvmaze-results">
          {results.map(r => (
            <div
              key={r.show.id}
              className={`tvmaze-result ${adding === r.show.id ? 'adding' : ''}`}
              onMouseDown={() => console.log('[TVMaze] MouseDown on:', r.show.id)}
              onClick={() => {
                console.log('[TVMaze] Row clicked:', r.show.id, r.show.name);
                handleAdd(r.show);
              }}
              style={{ cursor: adding ? 'wait' : 'pointer' }}
            >
              {r.show.image?.medium
                ? <img src={r.show.image.medium} alt={r.show.name} className="tvmaze-thumb" />
                : <div className="tvmaze-thumb-placeholder">📺</div>
              }
              <div className="tvmaze-result-info">
                <strong>{r.show.name}</strong>
                <span>{r.show.network?.name}{r.show.status ? ` · ${r.show.status}` : ''}</span>
              </div>
              <div className="tvmaze-add-label">
                {adding === r.show.id ? '⏳' : '+ Track'}
              </div>
            </div>
          ))}
          {!loading && results.length === 0 && <div className="tvmaze-empty">No results</div>}
        </div>
      </div>
    </div>,
    document.body
  );
}
