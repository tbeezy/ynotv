import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ShortcutsMap, ShortcutAction } from '../../types/app';

interface ShortcutsTabProps {
    shortcuts: ShortcutsMap;
    onShortcutsChange: (shortcuts: ShortcutsMap) => void;
}
const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
    togglePlay: ' ',
    toggleMute: 'm',
    cycleSubtitle: 'j',
    cycleAudio: 'a',
    selectSubtitle: 'j',
    selectAudio: 'a',
    toggleStats: 'i',
    toggleFullscreen: 'f',
    toggleGuide: 'g',
    toggleCategories: 'c',
    toggleLiveTV: 'l',
    toggleDvr: 'r',
    toggleSettings: ',',
    focusSearch: 's',
    close: 'Escape',
    seekForward: 'ArrowRight',
    seekBackward: 'ArrowLeft',
    layoutMain: '1',
    layoutPip: '2',
    layoutBigBottom: '3',
    layout2x2: '4'
};

const ACTION_LABELS: Record<ShortcutAction, string> = {
    togglePlay: 'Play / Pause',
    toggleMute: 'Mute / Unmute',
    cycleSubtitle: 'Cycle Subtitles (Legacy)',
    cycleAudio: 'Cycle Audio Track (Legacy)',
    selectSubtitle: 'Select Subtitle (Modal)',
    selectAudio: 'Select Audio Track (Modal)',
    toggleStats: 'Show / Hide Stats',
    toggleFullscreen: 'Toggle Fullscreen',
    toggleGuide: 'Toggle Guide',
    toggleCategories: 'Toggle Categories',
    toggleLiveTV: 'Toggle Live TV (Guide + Categories)',
    toggleDvr: 'Toggle DVR',
    toggleSettings: 'Toggle Settings',
    focusSearch: 'Focus Search',
    close: 'Close / Back',
    seekForward: 'Seek Forward',
    seekBackward: 'Seek Backward',
    layoutMain: 'Layout: Main View',
    layoutPip: 'Layout: Picture in Picture',
    layoutBigBottom: 'Layout: Big + Bottom Bar',
    layout2x2: 'Layout: 2×2 Grid'
};

const GROUPS: Record<string, ShortcutAction[]> = {
    'Playback': ['togglePlay', 'seekForward', 'seekBackward', 'toggleMute', 'selectSubtitle', 'selectAudio', 'toggleFullscreen'],
    'Interface': ['toggleLiveTV', 'toggleGuide', 'toggleCategories', 'toggleDvr', 'toggleSettings', 'toggleStats', 'focusSearch', 'close'],
    'Layout': ['layoutMain', 'layoutPip', 'layoutBigBottom', 'layout2x2']
};


export function ShortcutsTab({ shortcuts, onShortcutsChange }: ShortcutsTabProps) {
    const [listeningFor, setListeningFor] = useState<ShortcutAction | null>(null);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // Merge current shortcuts with defaults to ensure all keys exist
    const currentShortcuts = { ...DEFAULT_SHORTCUTS, ...shortcuts };

    useEffect(() => {
        if (!listeningFor) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Ignore modifier-only presses
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

            const key = e.key; // We might want to handle modifiers like 'Ctrl+S' later, keeping simple for now

            onShortcutsChange({
                ...shortcuts,
                [listeningFor]: key
            });
            setListeningFor(null);
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [listeningFor, shortcuts, onShortcutsChange]);

    const handleReset = () => {
        setShowResetConfirm(true);
    };

    const confirmReset = () => {
        onShortcutsChange({}); // Empty map will loop back to defaults in logic
        setShowResetConfirm(false);
    };

    return (
        <div className="settings-tab-content shortcuts-tab-content">
            <div className="settings-section">
                <div className="section-header">
                    <h3>Keyboard Shortcuts</h3>
                </div>
                <p className="section-description">
                    Click on a shortcut to rebind it. Press <b>Esc</b> to cancel listening (unless rebinding Close).
                </p>

                <div className="shortcuts-scroll-container">
                    {Object.entries(GROUPS).map(([groupName, actions]) => (
                        <div key={groupName} className="shortcuts-group">
                            <h4 style={{
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                color: 'rgba(255, 255, 255, 0.5)',
                                margin: '0 0 12px 0'
                            }}>{groupName}</h4>
                            <div className="shortcuts-list">
                                {actions.map(action => (
                                    <div key={action} className="shortcut-row">
                                        <span className="shortcut-label">{ACTION_LABELS[action]}</span>
                                        <button
                                            className={`shortcut-btn ${listeningFor === action ? 'listening' : ''}`}
                                            onClick={() => setListeningFor(action)}
                                        >
                                            {listeningFor === action ? 'Press any key...' : (currentShortcuts[action] === ' ' ? 'Space' : currentShortcuts[action])}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="settings-actions" style={{ marginTop: '20px' }}>
                    <button className="reset-shortcuts-btn" onClick={handleReset}>
                        Reset to Defaults
                    </button>
                </div>
            </div>

            {showResetConfirm && createPortal(
                <div className="source-form-overlay">
                    <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
                        <h3>Reset Shortcuts</h3>
                        <p style={{ color: 'rgba(255,255,255,0.8)', marginBottom: '24px', lineHeight: '1.5' }}>
                            Are you sure you want to reset all keyboard shortcuts to their default values?
                        </p>
                        <div className="form-actions" style={{ marginTop: '0' }}>
                            <button
                                className="cancel-btn"
                                onClick={() => setShowResetConfirm(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="save-btn"
                                onClick={confirmReset}
                            >
                                Reset to Defaults
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
