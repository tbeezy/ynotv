/**
 * Sports Favorites Store - Zustand store with localStorage persistence
 *
 * Stores favorite teams for the Sports Hub.
 * Persists across sessions using localStorage.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SportsTeam } from '@ynotv/core';

interface FavoriteTeam extends SportsTeam {
  addedAt: number;
}

interface SportsFavoritesState {
  favorites: FavoriteTeam[];
  addFavorite: (team: SportsTeam) => void;
  removeFavorite: (teamId: string) => void;
  isFavorite: (teamId: string) => boolean;
  clearFavorites: () => void;
}

export const useSportsFavoritesStore = create<SportsFavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      
      addFavorite: (team) => set((state) => {
        if (state.favorites.some(f => f.id === team.id)) {
          return state;
        }
        return {
          favorites: [...state.favorites, { ...team, addedAt: Date.now() }]
        };
      }),
      
      removeFavorite: (teamId) => set((state) => ({
        favorites: state.favorites.filter(f => f.id !== teamId)
      })),
      
      isFavorite: (teamId) => get().favorites.some(f => f.id === teamId),
      
      clearFavorites: () => set({ favorites: [] }),
    }),
    {
      name: 'sports-favorites',
    }
  )
);

export const useFavoriteTeams = () => useSportsFavoritesStore((s) => s.favorites);
export const useAddFavorite = () => useSportsFavoritesStore((s) => s.addFavorite);
export const useRemoveFavorite = () => useSportsFavoritesStore((s) => s.removeFavorite);
export const useIsFavorite = (teamId: string) => useSportsFavoritesStore((s) => s.isFavorite(teamId));
