import { useEffect, useState } from 'react';
import { Bridge } from '../services/tauri-bridge';
import './TrackSelectionModal.css';

interface Track {
  id: number;
  type: 'audio' | 'sub';
  title?: string;
  lang?: string;
  codec?: string;
  default: boolean;
  selected: boolean;
}

interface CCTrack {
  id: number;
  channel: number;
  selected: boolean;
}

interface TrackSelectionModalProps {
  isOpen: boolean;
  type: 'audio' | 'subtitle';
  onClose: () => void;
}

export function TrackSelectionModal({ isOpen, type, onClose }: TrackSelectionModalProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [ccTracks, setCcTracks] = useState<CCTrack[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCcId, setSelectedCcId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      loadTracks();
    }
  }, [isOpen]);

  const loadTracks = async () => {
    setLoading(true);
    try {
      const trackList = await Bridge.getTrackList();

      // Filter regular subtitle tracks (non-CC)
      const filteredTracks = trackList
        .filter((t: any) => t.type === type && !isCCTrack(t))
        .map((t: any) => ({
          id: t.id,
          type: t.type,
          title: t.title,
          lang: t.lang,
          codec: t.codec,
          default: t.default || false,
          selected: t.selected || false,
        }));
      setTracks(filteredTracks);

      // Find CC tracks (EIA-608/708)
      const ccList = trackList
        .filter((t: any) => t.type === 'sub' && isCCTrack(t))
        .map((t: any) => ({
          id: t.id,
          channel: extractCcChannel(t.title, t.codec),
          selected: t.selected || false,
        }));
      setCcTracks(ccList);

      // Find currently selected track
      const current = filteredTracks.find((t: Track) => t.selected);
      if (current) {
        setSelectedId(current.id);
      }

      const currentCc = ccList.find((t: CCTrack) => t.selected);
      if (currentCc) {
        setSelectedCcId(currentCc.id);
      }
    } catch (e) {
      console.error('Failed to load tracks:', e);
    } finally {
      setLoading(false);
    }
  };

  const isCCTrack = (track: any): boolean => {
    const codec = (track.codec || '').toLowerCase();
    const title = (track.title || '').toLowerCase();
    return codec.includes('eia') ||
           codec.includes('608') ||
           codec.includes('708') ||
           title.includes('cc') ||
           title.includes('closed caption');
  };

  const extractCcChannel = (title?: string, codec?: string): number => {
    // Try to extract channel number from title (e.g., "CC1", "CC2")
    const match = title?.match(/CC(\d)/i);
    if (match) return parseInt(match[1]);
    return 1;
  };

  const handleSelect = async (trackId: number) => {
    try {
      if (type === 'audio') {
        await Bridge.setAudioTrack(trackId);
      } else {
        await Bridge.setSubtitleTrack(trackId);
      }
      setSelectedId(trackId);
      onClose();
    } catch (e) {
      console.error('Failed to set track:', e);
    }
  };

  const handleDisable = async () => {
    try {
      // ID 0 disables the track in MPV
      if (type === 'audio') {
        await Bridge.setAudioTrack(0);
      } else {
        await Bridge.setSubtitleTrack(0);
      }
      setSelectedId(0);
      setSelectedCcId(null);
      onClose();
    } catch (e) {
      console.error('Failed to disable track:', e);
    }
  };

  const handleSelectCc = async (trackId: number) => {
    try {
      await Bridge.setSubtitleTrack(trackId);
      setSelectedCcId(trackId);
      setSelectedId(null); // Clear regular subtitle selection
      onClose();
    } catch (e) {
      console.error('Failed to set CC track:', e);
    }
  };

  if (!isOpen) return null;

  const title = type === 'audio' ? 'Audio Tracks' : 'Subtitle Tracks';

  return (
    <div className="track-modal-overlay" onClick={onClose}>
      <div className="track-modal" onClick={(e) => e.stopPropagation()}>
        <div className="track-modal-header">
          <h3>{title}</h3>
          <button className="track-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="track-modal-content">
          {loading ? (
            <div className="track-modal-loading">Loading...</div>
          ) : type === 'subtitle' && tracks.length === 0 && ccTracks.length === 0 ? (
            <div className="track-modal-empty">No {type} tracks available</div>
          ) : type === 'audio' && tracks.length === 0 ? (
            <div className="track-modal-empty">No {type} tracks available</div>
          ) : (
            <>
              {/* Regular Subtitle/Audio Tracks */}
              {tracks.length > 0 && (
                <>
                  <div className="track-section-title">
                    {type === 'subtitle' ? 'Subtitles' : 'Audio Tracks'}
                  </div>
                  <ul className="track-list">
                    {/* Disable option for subtitles */}
                    {type === 'subtitle' && (
                      <li
                        className={`track-item ${selectedId === 0 && !selectedCcId ? 'selected' : ''}`}
                        onClick={handleDisable}
                      >
                        <span className="track-name">Disabled</span>
                      </li>
                    )}
                    {tracks.map((track) => (
                      <li
                        key={track.id}
                        className={`track-item ${selectedId === track.id && !selectedCcId ? 'selected' : ''}`}
                        onClick={() => handleSelect(track.id)}
                      >
                        <span className="track-name">
                          {track.title || `${type === 'audio' ? 'Audio' : 'Subtitle'} ${track.id}`}
                          {track.default && <span className="track-badge">Default</span>}
                        </span>
                        <span className="track-info">
                          {track.lang && <span className="track-lang">{track.lang.toUpperCase()}</span>}
                          {track.codec && <span className="track-codec">{track.codec.toUpperCase()}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/* Closed Captioning Section (Subtitle only) */}
              {type === 'subtitle' && ccTracks.length > 0 && (
                <>
                  <div className="track-section-title track-section-cc">Closed Captioning</div>
                  <ul className="track-list">
                    {ccTracks.map((cc) => (
                      <li
                        key={cc.id}
                        className={`track-item ${selectedCcId === cc.id ? 'selected' : ''}`}
                        onClick={() => handleSelectCc(cc.id)}
                      >
                        <span className="track-name">
                          CC{cc.channel} - Closed Captions
                          <span className="track-badge cc-badge">CC</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>

        <div className="track-modal-footer">
          <button className="track-modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
