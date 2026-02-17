import { useLiveQuery } from './useSqliteLiveQuery';
import { db } from '../db';

/**
 * Hook to get filter words for a specific category
 */
export function useCategoryFilterWords(categoryId: string | null): string[] {
  const filterWords = useLiveQuery(
    async () => {
      if (!categoryId) return [];
      const category = await db.categories.get(categoryId);
      return category?.filter_words || [];
    },
    [categoryId]
  );
  
  return filterWords || [];
}

/**
 * Apply filter words to a channel name
 */
export function applyFilterWords(name: string, filterWords: string[]): string {
  if (!filterWords || filterWords.length === 0) return name;
  
  let filteredName = name;
  filterWords.forEach(word => {
    if (word.trim()) {
      // Escape special regex characters
      const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filteredName = filteredName.replace(new RegExp(escapedWord, 'gi'), '').trim();
    }
  });
  
  return filteredName;
}
