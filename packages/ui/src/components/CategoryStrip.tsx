import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCategoriesBySource, type CategoryWithCount, type SourceWithCategories } from '../hooks/useChannels';
import { db } from '../db';
import type { Source } from '../types/electron';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import './CategoryStrip.css';

interface CategoryStripProps {
  selectedCategoryId: string | null;
  onSelectCategory: (categoryId: string | null) => void;
  visible: boolean;
  sidebarExpanded: boolean;
}

// Chevron Icon for expand/collapse
const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16" height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 0.2s ease',
      marginRight: '8px'
    }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// Favorites button component
function FavoritesButton({ selectedCategoryId, onSelectCategory }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void }) {
  const favoriteCount = useLiveQuery(
    async () => {
      const allChannels = await db.channels.toArray();
      return allChannels.filter(ch => ch.is_favorite === true).length;
    }
  );

  return (
    <button
      className={`category-item ${selectedCategoryId === '__favorites__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__favorites__')}
    >
      <span className="category-name">⭐ Favorites</span>
      <span className="category-count">{favoriteCount ?? 0}</span>
    </button>
  );
}

export function CategoryStrip({ selectedCategoryId, onSelectCategory, visible, sidebarExpanded }: CategoryStripProps) {
  const groupedCategories = useCategoriesBySource();
  const [sources, setSources] = useState<Record<string, string>>({});
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const { version } = useSourceVersion(); // Listen for source changes

  // Fetch source names to resolve IDs
  useEffect(() => {
    async function fetchSources() {
      if (window.storage) {
        const result = await window.storage.getSources();
        if (result.data) {
          const sourceMap = result.data.reduce((acc: Record<string, string>, s: Source) => {
            acc[s.id] = s.name;
            return acc;
          }, {});
          setSources(sourceMap);

          const sourcesData = result.data;

          // Initialize new sources as expanded (only if not already set)
          setExpandedSources(prev => {
            const next = { ...prev };
            sourcesData.forEach((s: Source) => {
              if (next[s.id] === undefined) {
                next[s.id] = true;
              }
            });
            return next;
          });
        }
      }
    }
    fetchSources();
  }, [version]); // Re-fetch when version changes

  // Toggle expansion for a source
  const toggleSource = (sourceId: string) => {
    setExpandedSources(prev => ({
      ...prev,
      [sourceId]: !prev[sourceId]
    }));
  };

  // Calculate total channel count for "All" option
  const totalChannels = groupedCategories.reduce((sum, group) =>
    sum + group.categories.reduce((s, cat) => s + cat.channelCount, 0), 0
  );

  return (
    <div className={`category-strip ${visible ? 'visible' : 'hidden'} ${sidebarExpanded ? 'sidebar-expanded' : ''}`}>
      <div className="category-strip-header">
        <span className="category-strip-title">Categories</span>
      </div>

      <div className="category-strip-list">
        {/* "All Channels" option */}
        <button
          className={`category-item ${selectedCategoryId === null ? 'selected' : ''}`}
          onClick={() => onSelectCategory(null)}
        >
          <span className="category-name">All Channels</span>
          <span className="category-count">{totalChannels}</span>
        </button>

        {/* "Favorites" option */}
        <FavoritesButton
          selectedCategoryId={selectedCategoryId}
          onSelectCategory={onSelectCategory}
        />

        {/* Grouped Category list */}
        {groupedCategories.map((group) => (
          <div key={group.sourceId} className="category-source-group">
            <button
              className="category-source-header"
              onClick={() => toggleSource(group.sourceId)}
            >
              <div className="source-header-left">
                <ChevronIcon expanded={expandedSources[group.sourceId]} />
                <span className="source-name">{sources[group.sourceId] || 'Loading...'}</span>
              </div>
              <span className="source-count">
                {group.categories.reduce((s, cat) => s + cat.channelCount, 0)}
              </span>
            </button>

            {expandedSources[group.sourceId] && (
              <div className="category-source-content">
                {group.categories.map((category) => (
                  <button
                    key={category.category_id}
                    className={`category-item nested ${selectedCategoryId === category.category_id ? 'selected' : ''}`}
                    onClick={() => onSelectCategory(category.category_id)}
                  >
                    <span className="category-name">{category.category_name}</span>
                    <span className="category-count">{category.channelCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {groupedCategories.length === 0 && (
          <div className="category-empty">
            <p>No categories yet</p>
            <p className="hint">Add a source in Settings</p>
          </div>
        )}
      </div>
    </div>
  );
}
