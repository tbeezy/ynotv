import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useVodHiddenItemsStore } from '../../stores/vodHiddenItemsStore';
import '../settings/CategoryManager.css'; // Re-use the same CSS as ManageVodCategories

interface HiddenTitlesModalProps {
    onClose: () => void;
}

/**
 * Lists every movie/series the user hid from browse and search, and lets them
 * bring titles back one by one or all at once.
 */
export function HiddenTitlesModal({ onClose }: HiddenTitlesModalProps) {
    useTranslation();
    const hidden = useVodHiddenItemsStore((s) => s.hidden);
    const hydrate = useVodHiddenItemsStore((s) => s.hydrate);

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    // Newest first, so a title hidden by mistake is at the top.
    const rows = useMemo(
        () => Object.values(hidden).sort((a, b) => b.hidden_at - a.hidden_at),
        [hidden]
    );

    return createPortal(
        <div className="category-manager-overlay" onClick={onClose}>
            <div
                className="category-manager-modal vertical-flex"
                onClick={(e) => e.stopPropagation()}
                style={{ display: 'flex', flexDirection: 'column' }}
            >
                <div className="category-manager-header" style={{ flexShrink: 0 }}>
                    <h2>{i18n.t('vod:hiddenTitles')}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                {rows.length > 0 && (
                    <div className="category-manager-actions" style={{ flexShrink: 0 }}>
                        <button onClick={() => void useVodHiddenItemsStore.getState().unhideAll()}>
                            {i18n.t('vod:unhideAll')}
                        </button>
                    </div>
                )}

                <div
                    className="category-list"
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
                >
                    {rows.map((row) => (
                        <div key={row.hidden_key} className="category-item">
                            <span className="category-name" style={{ flex: 1, minWidth: 0 }}>
                                {row.media_type === 'movie' ? '🎬' : '📺'} {row.title || row.media_id}
                            </span>
                            <button
                                className="order-btn"
                                style={{ width: 'auto', padding: '0 10px' }}
                                onClick={() => void useVodHiddenItemsStore.getState().unhide(row.media_id, row.media_type)}
                            >
                                {i18n.t('vod:unhide')}
                            </button>
                        </div>
                    ))}
                    {rows.length === 0 && (
                        <div className="category-empty-state" style={{ textAlign: 'center', padding: '2rem', opacity: 0.5 }}>
                            {i18n.t('vod:hiddenTitlesEmpty')}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}

export default HiddenTitlesModal;
