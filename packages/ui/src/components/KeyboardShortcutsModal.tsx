import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import i18n from '../i18n';
import type { ShortcutsMap, ShortcutAction } from '../types/app';
import { DEFAULT_SHORTCUTS, formatShortcutKey } from '../constants/shortcuts';
import './KeyboardShortcutsModal.css';

interface KeyboardShortcutsModalProps {
    isOpen: boolean;
    onClose: () => void;
    shortcuts: ShortcutsMap;
}

interface ShortcutDisplayItem {
    action: ShortcutAction;
    label: string;
}

interface ShortcutGroup {
    title: string;
    items: ShortcutDisplayItem[];
}

const GROUPS: ShortcutGroup[] = [
    {
        title: 'Playback',
        items: [
            { action: 'togglePlay', label: 'Play / Pause' },
            { action: 'toggleMute', label: 'Mute / Unmute' },
            { action: 'seekForward', label: 'Seek Forward 10s' },
            { action: 'seekBackward', label: 'Seek Backward 10s' },
            { action: 'selectSubtitle', label: 'Select Subtitle' },
            { action: 'selectAudio', label: 'Select Audio Track' },
            { action: 'toggleFullscreen', label: 'Toggle Fullscreen' },
            { action: 'toggleStats', label: 'Stream Statistics' },
            { action: 'toggleConnectionInfo', label: 'Connection / Account Info' },
            { action: 'replayLastStream', label: 'Replay Last Stream' }
        ]
    },
    {
        title: 'Navigation',
        items: [
            { action: 'channelUp', label: 'Next Stream / Channel Up' },
            { action: 'channelDown', label: 'Previous Stream / Channel Down' },
            { action: 'focusSearch', label: 'Focus Search' },
            { action: 'close', label: 'Close / Back / Exit Fullscreen' }
        ]
    },
    {
        title: 'Interface',
        items: [
            { action: 'toggleShortcutsOverlay', label: 'Shortcuts Overlay Guide' },
            { action: 'toggleLiveTV', label: 'Toggle Live TV Guide' },
            { action: 'toggleGuide', label: 'Toggle EPG Guide' },
            { action: 'toggleTransparentGuide', label: 'Toggle Transparent Guide' },
            { action: 'toggleCategories', label: 'Toggle Categories' },
            { action: 'toggleDvr', label: 'Toggle DVR' },
            { action: 'toggleSports', label: 'Toggle Sports' },
            { action: 'toggleCalendar', label: 'Toggle TV Calendar' },
            { action: 'toggleSettings', label: 'Toggle Settings' },
            { action: 'toggleEpgView', label: 'Toggle EPG View' },
            { action: 'mouseBackNavigation', label: 'Back Navigation (Mouse Button)' }
        ]
    },
    {
        title: 'Layout',
        items: [
            { action: 'layoutMain', label: 'Layout: Main View' },
            { action: 'layoutPip', label: 'Layout: Picture in Picture' },
            { action: 'layoutBigBottom', label: 'Layout: Big + Bottom Bar' },
            { action: 'layout2x2', label: 'Layout: 2×2 Grid' }
        ]
    }
];

export function KeyboardShortcutsModal({ isOpen, onClose, shortcuts }: KeyboardShortcutsModalProps) {
    const currentShortcuts = { ...DEFAULT_SHORTCUTS, ...shortcuts };
    const triggerKey = formatShortcutKey(currentShortcuts.toggleShortcutsOverlay || '/');

    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return createPortal(
        <div className="shortcuts-modal-overlay" onClick={onClose}>
            <div className="shortcuts-modal-container" onClick={(e) => e.stopPropagation()}>
                <div className="shortcuts-modal-header">
                    <div className="shortcuts-title-wrapper">
                        <h2 className="shortcuts-modal-title">{i18n.t('settings:shortcuts.title')}</h2>
                        <span className="shortcut-key-badge trigger-badge">{triggerKey}</span>
                    </div>
                    <button className="shortcuts-close-btn" onClick={onClose} aria-label={i18n.t('settings:shortcuts.closeOverlay')}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="shortcuts-modal-body">
                    {GROUPS.map((group) => (
                        <div key={group.title} className="shortcuts-column">
                            <div className="shortcuts-group-title">{i18n.t(`settings:shortcuts.groups.${group.title}`, { defaultValue: group.title })}</div>
                            <div className="shortcuts-item-list">
                                {group.items.map((item) => {
                                    const rawKey = currentShortcuts[item.action];
                                    const formatted = formatShortcutKey(rawKey);

                                    return (
                                        <div key={item.action} className="shortcut-item-row">
                                            <span className="shortcut-item-label">{i18n.t(`settings:shortcuts.actions.${item.action}`, { defaultValue: item.label })}</span>
                                            <div className="shortcut-key-badges">
                                                {formatted ? (
                                                    <kbd className="shortcut-key-badge">{formatted}</kbd>
                                                ) : (
                                                    <span style={{ opacity: 0.4, fontSize: '0.8rem' }}>{i18n.t('settings:shortcuts.unbound')}</span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="shortcuts-modal-footer">
                    <div className="shortcuts-footer-hint">
                        <span>{i18n.t('settings:shortcuts.press')}</span>
                        <kbd className="shortcut-key-badge" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>Esc</kbd>
                        <span>{i18n.t('settings:shortcuts.or')}</span>
                        <kbd className="shortcut-key-badge" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>{triggerKey}</kbd>
                        <span>{i18n.t('settings:shortcuts.toDismiss')}</span>
                    </div>
                    <div>{i18n.t('settings:shortcuts.configurableInSettings')}</div>
                </div>
            </div>
        </div>,
        document.body
    );
}
