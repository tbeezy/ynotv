import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bridge } from '../services/tauri-bridge';
import { useSettingsStore } from '../stores/settingsStore';
import { StoredChannel } from '../db';
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
  channel?: StoredChannel | null;
}

export function TrackSelectionModal({ isOpen, type, onClose, channel }: TrackSelectionModalProps) {
  const { t } = useTranslation('player');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [ccTracks, setCcTracks] = useState<CCTrack[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCcId, setSelectedCcId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [audioDelay, setAudioDelay] = useState<number>(0.0);
  const [activeTab, setActiveTab] = useState<'tracks' | 'devices' | 'settings'>('tracks');
  const [devices, setDevices] = useState<{ name: string; description: string }[]>([]);
  const [currentDevice, setCurrentDevice] = useState<string>('auto');

  // Subtitle controls state
  const [subSize, setSubSize] = useState<number>(35);
  const [subDelay, setSubDelay] = useState<number>(0.0);
  const [subVerticalOffset, setSubVerticalOffset] = useState<number>(90);
  const [subColor, setSubColor] = useState<string>('#ffffff');
  const [subBackgroundEnabled, setSubBackgroundEnabled] = useState<boolean>(false);
  const [subBackgroundColor, setSubBackgroundColor] = useState<string>('#000000');
  const [subBackgroundOpacity, setSubBackgroundOpacity] = useState<number>(80);
  const [subAlign, setSubAlign] = useState<'center' | 'left' | 'right'>('center');

  useEffect(() => {
    if (isOpen) {
      setActiveTab('tracks');
      loadTracks();
      if (type === 'audio') {
        loadAudioDelay();
        loadAudioDevices();
      } else if (type === 'subtitle') {
        loadSubtitleDelay();
        loadSubtitleSettings();
      }
    }
  }, [isOpen, type]);

  const loadTracks = async () => {
    setLoading(true);
    try {
      const trackList = await Bridge.getTrackList();

      // Filter regular subtitle tracks (non-CC)
      const targetType = type === 'subtitle' ? 'sub' : type;
      const filteredTracks = trackList
        .filter((t: any) => t.type === targetType && !isCCTrack(t))
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
      const currentCc = ccList.find((t: CCTrack) => t.selected);
      if (current) {
        setSelectedId(current.id);
        setSelectedCcId(null);
      } else if (currentCc) {
        setSelectedCcId(currentCc.id);
        setSelectedId(null);
      } else {
        setSelectedId(0);
        setSelectedCcId(null);
      }
    } catch (e) {
      console.error('Failed to load tracks:', e);
    } finally {
      setLoading(false);
    }
  };

  const parseMpvNumber = (value: any): number => {
    const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
    return typeof data === 'number' && Number.isFinite(data) ? data : 0.0;
  };

  const loadAudioDelay = async () => {
    try {
      const delayVal = await Bridge.getProperty('audio-delay');
      setAudioDelay(parseMpvNumber(delayVal));
    } catch (e) {
      console.error('Failed to load audio delay:', e);
    }
  };

  const handleAudioDelayChange = async (delta: number) => {
    const newDelay = Math.round((audioDelay + delta) * 10) / 10;
    try {
      await Bridge.setProperty('audio-delay', newDelay);
      setAudioDelay(newDelay);
      
      if (channel) {
        try {
          // Per-channel audio delays live in the settings store — read the
          // current map, patch the entry, and persist through the setter.
          const delays = { ...(useSettingsStore.getState().channelAudioDelays || {}) };
          const key = `${channel.source_id}_${channel.stream_id}`;
          
          if (newDelay === 0.0) {
            delete delays[key];
          } else {
            delays[key] = newDelay;
          }
          
          useSettingsStore.getState().setChannelAudioDelays(delays);
        } catch (saveErr) {
          console.error('Failed to save channel audio delay settings:', saveErr);
        }
      }
    } catch (e) {
      console.error('Failed to set audio delay:', e);
    }
  };

  const handleResetAudioDelay = async () => {
    try {
      await Bridge.setProperty('audio-delay', 0.0);
      setAudioDelay(0.0);
      
      if (channel) {
        try {
          const delays = { ...(useSettingsStore.getState().channelAudioDelays || {}) };
          const key = `${channel.source_id}_${channel.stream_id}`;
          
          delete delays[key];
          
          useSettingsStore.getState().setChannelAudioDelays(delays);
        } catch (saveErr) {
          console.error('Failed to save channel audio delay settings:', saveErr);
        }
      }
    } catch (e) {
      console.error('Failed to reset audio delay:', e);
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

  const loadAudioDevices = async () => {
    try {
      const list = await Bridge.getProperty('audio-device-list');
      const data = list && typeof list === 'object' && 'data' in list ? list.data : list;
      let parsed = Array.isArray(data) ? data : [];
      parsed = parsed.filter((d: any) => d && d.name && d.name !== 'auto');
      const deviceList = [
        { name: 'auto', description: 'Default (Autoselect)' },
        ...parsed
      ];
      setDevices(deviceList);

      let selectedDev = 'auto';
      const ss = useSettingsStore.getState().subtitleSettings;
      if (ss.audioDevice) {
        selectedDev = ss.audioDevice;
      }
      setCurrentDevice(selectedDev);
    } catch (e) {
      console.error('Failed to load audio devices:', e);
    }
  };

  const handleSelectDevice = async (deviceName: string) => {
    try {
      await Bridge.setProperty('audio-device', deviceName);
      setCurrentDevice(deviceName);

      useSettingsStore.getState().setSubtitleSettings({ audioDevice: deviceName });
    } catch (e) {
      console.error('Failed to set audio device:', e);
    }
  };

  const loadSubtitleSettings = async () => {
    try {
      const ss = useSettingsStore.getState().subtitleSettings;
      if (ss.defaultSize) setSubSize(ss.defaultSize);
      if (ss.subColor) setSubColor(ss.subColor);
      if (ss.subBackgroundEnabled !== undefined) setSubBackgroundEnabled(ss.subBackgroundEnabled);
      if (ss.subBackgroundColor) setSubBackgroundColor(ss.subBackgroundColor);
      if (ss.subBackgroundOpacity !== undefined) setSubBackgroundOpacity(ss.subBackgroundOpacity);
      if (ss.subVerticalOffset !== undefined) setSubVerticalOffset(ss.subVerticalOffset);
      if (ss.subAlign) setSubAlign(ss.subAlign);
    } catch (e) {
      console.error('Failed to load subtitle settings:', e);
    }
  };

  const loadSubtitleDelay = async () => {
    try {
      const delayVal = await Bridge.getProperty('sub-delay');
      setSubDelay(parseMpvNumber(delayVal));
    } catch (e) {
      console.error('Failed to load subtitle delay:', e);
    }
  };

  const handleSubDelayChange = async (delta: number) => {
    const newDelay = Math.round((subDelay + delta) * 10) / 10;
    try {
      await Bridge.setSubtitleDelay(newDelay);
      setSubDelay(newDelay);
    } catch (e) {
      console.error('Failed to set subtitle delay:', e);
    }
  };

  const handleResetSubDelay = async () => {
    try {
      await Bridge.setSubtitleDelay(0.0);
      setSubDelay(0.0);
    } catch (e) {
      console.error('Failed to reset subtitle delay:', e);
    }
  };

  const handleSubSizeChange = async (val: number) => {
    setSubSize(val);
    try {
      await Bridge.setSubtitleSize(val);
      useSettingsStore.getState().setSubtitleSettings({ defaultSize: val });
    } catch (e) {
      console.error('Failed to set subtitle size:', e);
    }
  };

  const handleSubPosChange = async (val: number) => {
    setSubVerticalOffset(val);
    try {
      const pos = Math.max(0, Math.min(100, val));
      await Bridge.setSubtitlePos(pos);
      useSettingsStore.getState().setSubtitleSettings({ subVerticalOffset: val });
    } catch (e) {
      console.error('Failed to set subtitle position:', e);
    }
  };

  const handleSubAlignChange = async (align: 'center' | 'left' | 'right') => {
    setSubAlign(align);
    try {
      await Bridge.setSubtitleAlign(align);
      useSettingsStore.getState().setSubtitleSettings({ subAlign: align });
    } catch (e) {
      console.error('Failed to set subtitle alignment:', e);
    }
  };

  const handleSubColorChange = async (color: string) => {
    setSubColor(color);
    try {
      await Bridge.setSubtitleColor(color);
      useSettingsStore.getState().setSubtitleSettings({ subColor: color });
    } catch (e) {
      console.error('Failed to set subtitle color:', e);
    }
  };

  const handleSubBackgroundToggle = async (enabled: boolean) => {
    setSubBackgroundEnabled(enabled);
    try {
      if (enabled) {
        await Bridge.setSubtitleBackColor(subBackgroundColor, subBackgroundOpacity);
        await Bridge.setSubtitleBorderStyle('background-box');
      } else {
        await Bridge.setSubtitleBackColor(subBackgroundColor, 0);
        await Bridge.setSubtitleBorderStyle('outline-and-shadow');
      }
      useSettingsStore.getState().setSubtitleSettings({ subBackgroundEnabled: enabled });
    } catch (e) {
      console.error('Failed to set subtitle background toggle:', e);
    }
  };

  const handleSubBackgroundOpacityChange = async (opacity: number) => {
    setSubBackgroundOpacity(opacity);
    try {
      if (subBackgroundEnabled) {
        await Bridge.setSubtitleBackColor(subBackgroundColor, opacity);
      }
      useSettingsStore.getState().setSubtitleSettings({ subBackgroundOpacity: opacity });
    } catch (e) {
      console.error('Failed to set subtitle background opacity:', e);
    }
  };

  const handleSubBackgroundColorChange = async (color: string) => {
    setSubBackgroundColor(color);
    try {
      if (subBackgroundEnabled) {
        await Bridge.setSubtitleBackColor(color, subBackgroundOpacity);
      }
      useSettingsStore.getState().setSubtitleSettings({ subBackgroundColor: color });
    } catch (e) {
      console.error('Failed to set subtitle background color:', e);
    }
  };

  if (!isOpen) return null;

  const title = type === 'subtitle' 
    ? (activeTab === 'tracks' ? 'Subtitle Tracks' : 'Subtitle Settings')
    : (activeTab === 'tracks' ? 'Audio Tracks' : 'Audio Devices');

  return (
    <div className="track-modal-overlay" onClick={onClose}>
      <div className="track-modal" onClick={(e) => e.stopPropagation()}>
        <div className="track-modal-header">
          <h3>{title}</h3>
          <button className="track-modal-close" onClick={onClose}>×</button>
        </div>

        {type === 'subtitle' ? (
          <div className="track-modal-tabs">
            <button 
              className={`track-modal-tab ${activeTab === 'tracks' ? 'active' : ''}`}
              onClick={() => setActiveTab('tracks')}
            >
              Subtitle Tracks
            </button>
            <button 
              className={`track-modal-tab ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              Subtitle Settings
            </button>
          </div>
        ) : (
          <div className="track-modal-tabs">
            <button 
              className={`track-modal-tab ${activeTab === 'tracks' ? 'active' : ''}`}
              onClick={() => setActiveTab('tracks')}
            >
              Audio Tracks
            </button>
            <button 
              className={`track-modal-tab ${activeTab === 'devices' ? 'active' : ''}`}
              onClick={() => setActiveTab('devices')}
            >
              Audio Devices
            </button>
          </div>
        )}

        <div className="track-modal-content">
          {loading ? (
            <div className="track-modal-loading">{t('loading')}</div>
          ) : (
            <>
              {type === 'audio' && activeTab === 'tracks' && (
                <div className="audio-sync-container">
                  <span className="audio-sync-label">{t('audioDelaySync')}</span>
                  <div className="audio-sync-controls">
                    <button 
                      className="audio-sync-btn audio-sync-btn-large" 
                      onClick={() => handleAudioDelayChange(-1.0)}
                      title={t('decreaseDelay1sAudio')}
                    >
                      -1s
                    </button>
                    <button 
                      className="audio-sync-btn" 
                      onClick={() => handleAudioDelayChange(-0.1)}
                      title={t('decreaseDelay01s')}
                    >
                      -0.1s
                    </button>
                    <span className="audio-sync-value">
                      {audioDelay > 0 ? `+${audioDelay.toFixed(1)}s` : `${audioDelay.toFixed(1)}s`}
                    </span>
                    <button 
                      className="audio-sync-btn" 
                      onClick={() => handleAudioDelayChange(0.1)}
                      title={t('increaseDelay01s')}
                    >
                      +0.1s
                    </button>
                    <button 
                      className="audio-sync-btn audio-sync-btn-large" 
                      onClick={() => handleAudioDelayChange(1.0)}
                      title={t('increaseDelay1sAudio')}
                    >
                      +1s
                    </button>
                    {audioDelay !== 0 && (
                      <button 
                        className="audio-sync-reset" 
                        onClick={handleResetAudioDelay}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              )}

              {type === 'subtitle' && activeTab === 'tracks' && (
                <div className="audio-sync-container">
                  <span className="audio-sync-label">{t('subtitleDelaySync')}</span>
                  <div className="audio-sync-controls">
                    <button 
                      className="audio-sync-btn audio-sync-btn-large" 
                      onClick={() => handleSubDelayChange(-1.0)}
                      title={t('decreaseDelay1sSubtitle')}
                    >
                      -1s
                    </button>
                    <button 
                      className="audio-sync-btn" 
                      onClick={() => handleSubDelayChange(-0.1)}
                      title={t('decreaseDelay01s')}
                    >
                      -0.1s
                    </button>
                    <span className="audio-sync-value">
                      {subDelay > 0 ? `+${subDelay.toFixed(1)}s` : `${subDelay.toFixed(1)}s`}
                    </span>
                    <button 
                      className="audio-sync-btn" 
                      onClick={() => handleSubDelayChange(0.1)}
                      title={t('increaseDelay01s')}
                    >
                      +0.1s
                    </button>
                    <button 
                      className="audio-sync-btn audio-sync-btn-large" 
                      onClick={() => handleSubDelayChange(1.0)}
                      title={t('increaseDelay1sSubtitle')}
                    >
                      +1s
                    </button>
                    {subDelay !== 0 && (
                      <button 
                        className="audio-sync-reset" 
                        onClick={handleResetSubDelay}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              )}

              {type === 'subtitle' && activeTab === 'settings' ? (
                <div className="subtitle-settings-container">
                  <div className="subtitle-setting-row">
                    <div className="subtitle-setting-info">
                      <span className="subtitle-setting-label">{t('fontSize')}</span>
                      <span className="subtitle-setting-val">{subSize}pt</span>
                    </div>
                    <div className="subtitle-setting-control">
                      <input 
                        type="range" 
                        min="10" 
                        max="80" 
                        value={subSize} 
                        onChange={(e) => handleSubSizeChange(parseInt(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="subtitle-setting-row">
                    <div className="subtitle-setting-info">
                      <span className="subtitle-setting-label">{t('verticalPosition')}</span>
                      <span className="subtitle-setting-val">{subVerticalOffset}%</span>
                    </div>
                    <div className="subtitle-setting-control">
                      <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        value={subVerticalOffset} 
                        onChange={(e) => handleSubPosChange(parseInt(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="subtitle-setting-row">
                    <div className="subtitle-setting-info">
                      <span className="subtitle-setting-label">{t('alignment')}</span>
                    </div>
                    <div className="subtitle-align-btns">
                      <button 
                        className={`audio-sync-btn ${subAlign === 'left' ? 'active-align' : ''}`}
                        onClick={() => handleSubAlignChange('left')}
                      >
                        Left
                      </button>
                      <button 
                        className={`audio-sync-btn ${subAlign === 'center' ? 'active-align' : ''}`}
                        onClick={() => handleSubAlignChange('center')}
                      >
                        Center
                      </button>
                      <button 
                        className={`audio-sync-btn ${subAlign === 'right' ? 'active-align' : ''}`}
                        onClick={() => handleSubAlignChange('right')}
                      >
                        Right
                      </button>
                    </div>
                  </div>

                  <div className="subtitle-setting-row">
                    <div className="subtitle-setting-info">
                      <span className="subtitle-setting-label">{t('textColor')}</span>
                    </div>
                    <div className="subtitle-setting-color">
                      <input 
                        type="color" 
                        value={subColor} 
                        onChange={(e) => handleSubColorChange(e.target.value)}
                      />
                      <span className="subtitle-hex-val">{subColor.toUpperCase()}</span>
                    </div>
                  </div>

                  <div className="subtitle-setting-row">
                    <div className="subtitle-setting-info">
                      <span className="subtitle-setting-label">{t('backgroundBox')}</span>
                    </div>
                    <label className="subtitle-toggle">
                      <input 
                        type="checkbox" 
                        checked={subBackgroundEnabled} 
                        onChange={(e) => handleSubBackgroundToggle(e.target.checked)}
                      />
                      <span className="subtitle-toggle-slider"></span>
                    </label>
                  </div>

                  {subBackgroundEnabled && (
                    <>
                      <div className="subtitle-setting-row">
                        <div className="subtitle-setting-info">
                          <span className="subtitle-setting-label">{t('backgroundColor')}</span>
                        </div>
                        <div className="subtitle-setting-color">
                          <input 
                            type="color" 
                            value={subBackgroundColor} 
                            onChange={(e) => handleSubBackgroundColorChange(e.target.value)}
                          />
                          <span className="subtitle-hex-val">{subBackgroundColor.toUpperCase()}</span>
                        </div>
                      </div>

                      <div className="subtitle-setting-row">
                        <div className="subtitle-setting-info">
                          <span className="subtitle-setting-label">{t('backgroundOpacity')}</span>
                          <span className="subtitle-setting-val">{subBackgroundOpacity}%</span>
                        </div>
                        <div className="subtitle-setting-control">
                          <input 
                            type="range" 
                            min="0" 
                            max="100" 
                            value={subBackgroundOpacity} 
                            onChange={(e) => handleSubBackgroundOpacityChange(parseInt(e.target.value))}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : type === 'audio' && activeTab === 'devices' ? (
                <ul className="track-list">
                  {devices.map((device) => {
                    const isSelected = currentDevice === device.name;
                    return (
                      <li
                        key={device.name}
                        className={`track-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleSelectDevice(device.name)}
                      >
                        <span className="track-name">
                          {device.description || device.name}
                          {device.name === 'auto' && <span className="track-badge">{t('default')}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : type === 'subtitle' && tracks.length === 0 && ccTracks.length === 0 ? (
                <div className="track-modal-empty">{t('noSubtitleTracks')}</div>
              ) : type === 'audio' && tracks.length === 0 ? (
                <div className="track-modal-empty">{t('noAudioTracks')}</div>
              ) : (
                <>
                  {/* Regular Subtitle/Audio Tracks */}
                  {(tracks.length > 0 || (type === 'subtitle' && ccTracks.length > 0)) && (
                    <>
                      <div className="track-section-title">
                        {type === 'subtitle' ? 'Subtitles' : 'Audio Tracks'}
                      </div>
                      <ul className="track-list">
                        {type === 'subtitle' && (
                          <li
                            className={`track-item ${selectedId === 0 && !selectedCcId ? 'selected' : ''}`}
                            onClick={handleDisable}
                          >
                            <span className="track-name">{t('disabled')}</span>
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
                              {track.default && <span className="track-badge">{t('default')}</span>}
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
                      <div className="track-section-title track-section-cc">{t('closedCaptioning')}</div>
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
            </>
          )}
        </div>

        <div className="track-modal-footer">
          <button className="track-modal-btn" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}
