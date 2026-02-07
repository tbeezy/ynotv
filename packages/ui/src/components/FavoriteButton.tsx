import React from 'react';
import { toggleChannelFavorite } from '../db';
import './FavoriteButton.css';

interface FavoriteButtonProps {
    streamId: string;
    isFavorite: boolean;
    onToggle?: () => void;
}

export function FavoriteButton({ streamId, isFavorite, onToggle }: FavoriteButtonProps) {
    async function handleClick(e: React.MouseEvent) {
        e.stopPropagation(); // Prevent triggering channel selection
        await toggleChannelFavorite(streamId);
        if (onToggle) onToggle();
    }

    return (
        <button
            className={`favorite-btn ${isFavorite ? 'favorited' : ''}`}
            onClick={handleClick}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
            {isFavorite ? '★' : '☆'}
        </button>
    );
}
