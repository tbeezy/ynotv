import './LoadingSkeleton.css';

interface SkeletonProps {
  variant?: 'card' | 'text' | 'avatar' | 'table-row' | 'news-card';
  count?: number;
}

export function LoadingSkeleton({ variant = 'card', count = 1 }: SkeletonProps) {
  const items = Array.from({ length: count }, (_, i) => i);

  if (variant === 'card') {
    return (
      <>
        {items.map(i => (
          <div key={i} className="skeleton-card">
            <div className="skeleton-card-header">
              <div className="skeleton skeleton-text skeleton-text-sm" />
              <div className="skeleton skeleton-badge" />
            </div>
            <div className="skeleton-card-body">
              <div className="skeleton-team-row">
                <div className="skeleton skeleton-avatar" />
                <div className="skeleton skeleton-text" />
                <div className="skeleton skeleton-score" />
              </div>
              <div className="skeleton-team-row">
                <div className="skeleton skeleton-avatar" />
                <div className="skeleton skeleton-text" />
                <div className="skeleton skeleton-score" />
              </div>
            </div>
          </div>
        ))}
      </>
    );
  }

  if (variant === 'table-row') {
    return (
      <>
        {items.map(i => (
          <div key={i} className="skeleton-table-row">
            <div className="skeleton skeleton-rank" />
            <div className="skeleton-team-cell">
              <div className="skeleton skeleton-avatar skeleton-avatar-sm" />
              <div className="skeleton skeleton-text" />
            </div>
            <div className="skeleton skeleton-text skeleton-text-sm" />
            <div className="skeleton skeleton-trend" />
          </div>
        ))}
      </>
    );
  }

  if (variant === 'news-card') {
    return (
      <>
        {items.map(i => (
          <div key={i} className="skeleton-news-card">
            <div className="skeleton skeleton-image" />
            <div className="skeleton-news-content">
              <div className="skeleton skeleton-text skeleton-text-sm" />
              <div className="skeleton skeleton-text skeleton-text-lg" />
              <div className="skeleton skeleton-text" />
            </div>
          </div>
        ))}
      </>
    );
  }

  if (variant === 'avatar') {
    return (
      <>
        {items.map(i => (
          <div key={i} className="skeleton skeleton-avatar" />
        ))}
      </>
    );
  }

  return (
    <>
      {items.map(i => (
        <div key={i} className="skeleton skeleton-text" />
      ))}
    </>
  );
}

export function GameCardSkeleton() {
  return (
    <div className="skeleton-card skeleton-card-game">
      <div className="skeleton-card-header">
        <div className="skeleton skeleton-text skeleton-text-sm skeleton-shimmer" />
        <div className="skeleton skeleton-badge skeleton-shimmer" />
      </div>
      <div className="skeleton-card-body">
        <div className="skeleton-team-row">
          <div className="skeleton skeleton-avatar skeleton-shimmer" />
          <div className="skeleton-team-info">
            <div className="skeleton skeleton-text skeleton-text-xs skeleton-shimmer" />
            <div className="skeleton skeleton-text skeleton-shimmer" />
          </div>
          <div className="skeleton skeleton-score skeleton-shimmer" />
        </div>
        <div className="skeleton-team-row">
          <div className="skeleton skeleton-avatar skeleton-shimmer" />
          <div className="skeleton-team-info">
            <div className="skeleton skeleton-text skeleton-text-xs skeleton-shimmer" />
            <div className="skeleton skeleton-text skeleton-shimmer" />
          </div>
          <div className="skeleton skeleton-score skeleton-shimmer" />
        </div>
      </div>
    </div>
  );
}

export function TableRowSkeleton({ columns = 4 }: { columns?: number }) {
  return (
    <div className="skeleton-table-row skeleton-shimmer">
      {Array.from({ length: columns }, (_, i) => (
        <div key={i} className="skeleton skeleton-text skeleton-text-sm" />
      ))}
    </div>
  );
}
