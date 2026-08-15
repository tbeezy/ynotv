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
 * Apply filter words to a string, returning the cleaned text plus the list of
 * words that actually matched (and therefore changed the text).
 */
export function applyFilterWordsDetailed(
  name: string,
  filterWords: string[]
): { text: string; matched: string[] } {
  if (!filterWords || filterWords.length === 0) return { text: name, matched: [] };

  let filteredName = name;
  const matched: string[] = [];
  filterWords.forEach(word => {
    const trimmed = word.trim();
    if (trimmed) {
      // Escape special regex characters
      const escapedWord = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedWord, 'gi');
      if (regex.test(filteredName)) {
        matched.push(trimmed);
        filteredName = filteredName.replace(regex, '').trim();
      }
    }
  });

  return { text: filteredName, matched };
}

/**
 * Apply filter words to a channel name
 */
export function applyFilterWords(name: string, filterWords: string[]): string {
  return applyFilterWordsDetailed(name, filterWords).text;
}
