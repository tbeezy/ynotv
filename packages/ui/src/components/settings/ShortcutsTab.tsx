import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { ShortcutsMap, ShortcutAction } from '../../types/app';
import { DEFAULT_SHORTCUTS, MOUSE_BUTTON_SHORTCUTS, formatShortcutKey } from '../../constants/shortcuts';

interface ShortcutsTabProps {
    shortcuts: ShortcutsMap;
    onShortcutsChange: (shortcuts: ShortcutsMap) => void;
}


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
    toggleSports: 'Toggle Sports',
    toggleCalendar: 'Toggle TV Calendar',
    toggleSettings: 'Toggle Settings',
    focusSearch: 'Focus Search',
    close: 'Close / Back',
    seekForward: 'Seek Forward',
    seekBackward: 'Seek Backward',
    layoutMain: 'Layout: Main View',
    layoutPip: 'Layout: Picture in Picture',
    layoutBigBottom: 'Layout: Big + Bottom Bar',
    layout2x2: 'Layout: 2×2 Grid',
    channelUp: 'Channel Up',
    channelDown: 'Channel Down',
    toggleEpgView: 'Toggle EPG View Layout',
    replayLastStream: 'Replay Last Stream',
    toggleTransparentGuide: 'Toggle Transparent Guide',
    toggleNuvio: 'Toggle Nuvio',
    toggleStrem: 'Toggle Strem',
    toggleJellyfin: 'Toggle Jellyfin',
    toggleShortcutsOverlay: 'Toggle Shortcuts Overlay',
    toggleConnectionInfo: 'Show / Hide Connection Info',
    mouseBackNavigation: 'Back Navigation (Mouse Button)'
};

const GROUPS: Record<string, ShortcutAction[]> = {
    'Playback': ['togglePlay', 'seekForward', 'seekBackward', 'toggleMute', 'selectSubtitle', 'selectAudio', 'toggleFullscreen', 'toggleConnectionInfo', 'replayLastStream'],
    'Navigation': ['channelUp', 'channelDown'],
    'Interface': ['toggleShortcutsOverlay', 'toggleLiveTV', 'toggleGuide', 'toggleTransparentGuide', 'toggleCategories', 'toggleDvr', 'toggleSports', 'toggleCalendar', 'toggleSettings', 'toggleStats', 'focusSearch', 'toggleEpgView', 'close', 'mouseBackNavigation', 'toggleNuvio', 'toggleStrem', 'toggleJellyfin'],
    'Layout': ['layoutMain', 'layoutPip', 'layoutBigBottom', 'layout2x2']
};


export function ShortcutsTab({ shortcuts, onShortcutsChange }: ShortcutsTabProps) {
    useTranslation();
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

        const handleMouseDown = (e: MouseEvent) => {
            // Only mouse side buttons (back/forward) can be recorded as shortcuts
            const key = MOUSE_BUTTON_SHORTCUTS[e.button];
            if (!key) return;

            e.preventDefault();
            e.stopPropagation();

            onShortcutsChange({
                ...shortcuts,
                [listeningFor]: key
            });
            setListeningFor(null);
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        window.addEventListener('mousedown', handleMouseDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
            window.removeEventListener('mousedown', handleMouseDown, { capture: true });
        };
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
                    <h3>{i18n.t('settings:shortcuts.title')}</h3>
                </div>
                <p className="section-description">
                    {i18n.t('settings:shortcuts.description')}
                </p>

                <div className="shortcuts-scroll-container">
                    {Object.entries(GROUPS).map(([groupName, actions]) => (
                        <div key={groupName} className="shortcuts-group">
                            <h4 style={{
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                color: 'var(--text-muted)',
                                margin: '0 0 12px 0'
                            }}>{i18n.t(`settings:shortcuts.groups.${groupName}`, { defaultValue: groupName })}</h4>
                            <div className="shortcuts-list">
                                {actions.map(action => (
                                    <div key={action} className="shortcut-row">
                                        <span className="shortcut-label">{i18n.t(`settings:shortcuts.actions.${action}`, { defaultValue: ACTION_LABELS[action] })}</span>
                                        <button
                                            className={`shortcut-btn ${listeningFor === action ? 'listening' : ''}`}
                                            onClick={() => setListeningFor(action)}
                                        >
                                            {listeningFor === action ? i18n.t('settings:shortcuts.listening') : formatShortcutKey(currentShortcuts[action])}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="settings-actions" style={{ marginTop: '20px' }}>
                    <button className="reset-shortcuts-btn" onClick={handleReset}>
                        {i18n.t('settings:shortcuts.resetDefaults')}
                    </button>
                </div>
            </div>

            {showResetConfirm && createPortal(
                <div className="source-form-overlay">
                    <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
                        <h3>{i18n.t('settings:shortcuts.resetTitle')}</h3>
                        <p style={{ color: 'var(--text-primary)', marginBottom: '24px', lineHeight: '1.5' }}>
                            {i18n.t('settings:shortcuts.resetMessage')}
                        </p>
                        <div className="form-actions" style={{ marginTop: '0' }}>
                            <button
                                className="cancel-btn"
                                onClick={() => setShowResetConfirm(false)}
                            >
                                {i18n.t('settings:shortcuts.cancel')}
                            </button>
                            <button
                                className="save-btn"
                                onClick={confirmReset}
                            >
                                {i18n.t('settings:shortcuts.confirmReset')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
