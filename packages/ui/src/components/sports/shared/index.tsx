/**
 * Shared Sports UI Components
 * 
 * Reusable loading, error, and empty state components
 */

import type { ReactNode } from 'react';

// Loading State
interface LoadingStateProps {
  message?: string;
  className?: string;
}

export function LoadingState({ message = 'Loading...', className = '' }: LoadingStateProps) {
  return (
    <div className={`sports-loading-state ${className}`}>
      <div className="sports-spinner" />
      <span className="sports-loading-text">{message}</span>
    </div>
  );
}

// Error State
interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ message, onRetry, className = '' }: ErrorStateProps) {
  return (
    <div className={`sports-error-state ${className}`}>
      <div className="sports-error-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <p className="sports-error-text">{message}</p>
      {onRetry && (
        <button className="sports-retry-btn" onClick={onRetry}>
          Try Again
        </button>
      )}
    </div>
  );
}

// Empty State
interface EmptyStateProps {
  title: string;
  message: string;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, message, icon, className = '' }: EmptyStateProps) {
  return (
    <div className={`sports-empty-state ${className}`}>
      {icon && <div className="sports-empty-icon">{icon}</div>}
      <h3 className="sports-empty-title">{title}</h3>
      <p className="sports-empty-message">{message}</p>
    </div>
  );
}

// Tab Container with consistent styling
interface TabContainerProps {
  children: ReactNode;
  className?: string;
}

export function TabContainer({ children, className = '' }: TabContainerProps) {
  return (
    <div className={`sports-tab-content ${className}`}>
      {children}
    </div>
  );
}

// Tab Header with consistent styling
interface TabHeaderProps {
  title: string;
  children?: ReactNode;
  className?: string;
}

export function TabHeader({ title, children, className = '' }: TabHeaderProps) {
  return (
    <div className={`sports-tab-header ${className}`}>
      <h2 className="sports-tab-title">{title}</h2>
      {children && <div className="sports-tab-actions">{children}</div>}
    </div>
  );
}

// Section with consistent styling
interface SectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  live?: boolean;
}

export function Section({ title, children, className = '', live = false }: SectionProps) {
  return (
    <section className={`sports-section ${className}`}>
      <h2 className="sports-section-title">
        {live && <span className="sports-section-dot live" />}
        {title}
      </h2>
      {children}
    </section>
  );
}

// Grid Container
interface GridProps {
  children: ReactNode;
  className?: string;
  columns?: 1 | 2 | 3 | 4 | 'auto';
}

export function Grid({ children, className = '', columns = 'auto' }: GridProps) {
  const columnClass = columns === 'auto' ? '' : `sports-grid-cols-${columns}`;
  return (
    <div className={`sports-grid ${columnClass} ${className}`}>
      {children}
    </div>
  );
}
