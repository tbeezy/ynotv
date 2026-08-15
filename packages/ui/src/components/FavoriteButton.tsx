import React from 'react';
import { useTranslation } from 'react-i18next';
import { setChannelFavorite } from '../db';
import { useFavoriteOverride, useFavoriteOverridesStore } from '../stores/favoriteOverridesStore';
import './FavoriteButton.css';

interface FavoriteButtonProps {
    streamId: string;
    isFavorite: boolean;
    onToggle?: () => void;
}

export function FavoriteButton({ streamId, isFavorite, onToggle }: FavoriteButtonProps) {
    const { t } = useTranslation('live');
    const override = useFavoriteOverride(streamId);
    const setOverride = useFavoriteOverridesStore((s) => s.setOverride);

    // The optimistic override wins so the star flips instantly on click,
    // before the database write (and the debounced live-query refresh) lands.
    const effectiveFavorite = override ?? isFavorite;

    async function handleClick(e: React.MouseEvent) {
        e.stopPropagation(); // Prevent triggering channel selection

        const previous = effectiveFavorite;
        const next = !previous;

        // Optimistic UI: flip the star immediately.
        setOverride(streamId, next);

        try {
            await setChannelFavorite(streamId, next);
            if (onToggle) {
                onToggle();
            }
        } catch (err) {
            console.error('[FavoriteButton] Error toggling favorite:', err);
            // Revert to the previous state on failure.
            setOverride(streamId, previous);
        }
    }

    return (
        <button
            className={`favorite-btn ${effectiveFavorite ? 'favorited' : ''}`}
            onClick={handleClick}
            title={effectiveFavorite ? t('removeFromFavorites') : t('addToFavorites')}
        >
            {effectiveFavorite ? '★' : '☆'}
        </button>
    );
}
