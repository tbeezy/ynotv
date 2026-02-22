import { useState, useEffect } from 'react';
import type { LayoutMode } from '../../hooks/useMultiview';

export interface SavedLayoutState {
  layout: LayoutMode;
  mainChannel: {
    channelName: string | null;
    channelUrl: string | null;
  };
  slots: {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    active: boolean;
  }[];
}

interface StartupTabProps {
  rememberLastChannels: boolean;
  savedLayoutState: SavedLayoutState | null;
  onRememberLastChannelsChange: (value: boolean) => void;
}

export function StartupTab({
  rememberLastChannels,
  savedLayoutState,
  onRememberLastChannelsChange,
}: StartupTabProps) {
  const [localValue, setLocalValue] = useState(rememberLastChannels);

  useEffect(() => {
    setLocalValue(rememberLastChannels);
  }, [rememberLastChannels]);

  const handleToggle = (checked: boolean) => {
    setLocalValue(checked);
    onRememberLastChannelsChange(checked);
  };

  const getLayoutLabel = (layout: LayoutMode): string => {
    switch (layout) {
      case 'main': return 'Main View';
      case 'pip': return 'Picture-in-Picture';
      case '2x2': return '2x2 Grid';
      case 'bigbottom': return 'Big Top + Bottom Bar';
      default: return layout;
    }
  };

  const getActiveChannelCount = (): number => {
    if (!savedLayoutState) return 0;
    let count = savedLayoutState.mainChannel.channelUrl ? 1 : 0;
    count += savedLayoutState.slots.filter(s => s.active).length;
    return count;
  };

  return (
    <div className="settings-tab-content">
      {/* Remember Channels Section */}
      <div className="settings-section" style={{ paddingBottom: '8px' }}>
        <div className="section-header">
          <h3>Startup Behavior</h3>
        </div>

        <p className="section-description" style={{ marginBottom: '12px' }}>
          Control what happens when the application starts and when switching between view layouts.
        </p>

        {/* Remember Last Channels Toggle */}
        <div style={{ marginTop: '1rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 0',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.95rem' }}>
                Remember Last Viewed Channels
              </div>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                Save channels when switching layouts and restore them on next startup
              </div>
            </div>
            <input
              type="checkbox"
              checked={localValue}
              onChange={(e) => handleToggle(e.target.checked)}
              style={{ cursor: 'pointer', marginLeft: '1rem' }}
            />
          </div>
        </div>

        {/* Info about current saved state */}
        {localValue && savedLayoutState && (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              background: 'rgba(0, 212, 255, 0.1)',
              border: '1px solid rgba(0, 212, 255, 0.2)',
              borderRadius: '8px',
            }}
          >
            <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
              <strong>Saved Layout State</strong>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem' }}>
              <div>Layout: {getLayoutLabel(savedLayoutState.layout)}</div>
              <div>Active Channels: {getActiveChannelCount()}</div>
              {savedLayoutState.mainChannel.channelName && (
                <div style={{ marginTop: '0.5rem' }}>
                  Main: {savedLayoutState.mainChannel.channelName}
                </div>
              )}
              {savedLayoutState.slots.filter(s => s.active).length > 0 && (
                <div style={{ marginTop: '0.25rem' }}>
                  {savedLayoutState.slots
                    .filter(s => s.active)
                    .map(s => `Slot ${s.id}: ${s.channelName}`)
                    .join(', ')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Feature explanation */}
        <div
          style={{
            marginTop: '1.5rem',
            padding: '1rem',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '8px',
          }}
        >
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem' }}>
            <strong style={{ color: 'rgba(255,255,255,0.9)' }}>How it works:</strong>
            <ul style={{ marginTop: '0.5rem', marginLeft: '1.2rem', lineHeight: '1.6' }}>
              <li>Channels are automatically saved when you switch layouts or close the app</li>
              <li>2x2 Grid and Big Top + Bottom Bar share the same 4 video sources</li>
              <li>Picture-in-Picture uses the Main view + Slot 2</li>
              <li>Main View only uses the primary player</li>
              <li>When switching layouts, available channels are restored to their respective players</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
