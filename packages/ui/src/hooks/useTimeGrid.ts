import { useState, useEffect, useCallback, useMemo } from 'react';

export interface TimeGridState {
  // The left edge of the visible time window
  anchor: Date;
  // True when showing current time at left edge
  isAtNow: boolean;
  // Number of hours visible (2-5)
  visibleHours: number;
  // Pixels per hour based on available width
  pixelsPerHour: number;
  // Start and end of visible window
  windowStart: Date;
  windowEnd: Date;
  // Start and end of data loading window (wider for preloading)
  loadStart: Date;
  loadEnd: Date;
}

export interface TimeGridActions {
  goBack: () => void;
  goForward: () => void;
  goToNow: () => void;
}

// Clamp a value between min and max
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Get current time (for "now at left edge")
function getNow(): Date {
  return new Date();
}

// Floor to the current hour
function floorToHour(date: Date): Date {
  const result = new Date(date);
  result.setMinutes(0, 0, 0);
  return result;
}

// Add hours to a date
function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

interface UseTimeGridOptions {
  // Available width for the program grid (excluding channel column)
  availableWidth: number;
  // Target pixels per hour (baseline for calculations)
  targetPixelsPerHour?: number;
  // Minimum visible hours
  minHours?: number;
  // Maximum visible hours
  maxHours?: number;
  // Hours to preload before visible window
  preloadBefore?: number;
  // Hours to preload after visible window
  preloadAfter?: number;
}

export function useTimeGrid({
  availableWidth,
  targetPixelsPerHour = 200,
  minHours = 2,
  maxHours = 5,
  preloadBefore = 2,
  preloadAfter = 4,
}: UseTimeGridOptions): TimeGridState & TimeGridActions {
  // Current anchor point (left edge of visible window)
  // When isAtNow=true, anchor is current time (now at left edge)
  const [anchor, setAnchor] = useState<Date>(() => getNow());
  const [isAtNow, setIsAtNow] = useState(true);

  // Calculate visible hours and pixels per hour based on available width
  const { visibleHours, pixelsPerHour } = useMemo(() => {
    if (availableWidth <= 0) {
      return { visibleHours: minHours, pixelsPerHour: targetPixelsPerHour };
    }

    const idealHours = availableWidth / targetPixelsPerHour;
    const hours = clamp(idealHours, minHours, maxHours);
    const pph = availableWidth / hours;

    return { visibleHours: hours, pixelsPerHour: pph };
  }, [availableWidth, targetPixelsPerHour, minHours, maxHours]);

  // Calculate window boundaries
  const windowStart = anchor;
  const windowEnd = useMemo(() => addHours(anchor, visibleHours), [anchor, visibleHours]);

  // Calculate preload boundaries (wider window for data fetching)
  const loadStart = useMemo(() => addHours(anchor, -preloadBefore), [anchor, preloadBefore]);
  const loadEnd = useMemo(() => addHours(anchor, visibleHours + preloadAfter), [anchor, visibleHours, preloadAfter]);

  // Update anchor to current time when at "now" view
  useEffect(() => {
    if (!isAtNow) return;

    // Update anchor to current time (snapped to hour)
    const updateNow = () => {
      setAnchor(floorToHour(getNow()));
    };

    // Update immediately
    updateNow();

    // Update every minute to keep the view current
    const interval = setInterval(updateNow, 60000);
    return () => clearInterval(interval);
  }, [isAtNow]);

  // Navigation: go back one hour (snap to even hour)
  const goBack = useCallback(() => {
    setIsAtNow(false);
    setAnchor((current) => {
      // If at "now", first back goes to current hour
      // Otherwise, go back one hour
      const currentHour = floorToHour(current);
      if (current.getTime() === currentHour.getTime()) {
        // Already at an hour boundary, go back one hour
        return addHours(currentHour, -1);
      }
      // First back snaps to current hour
      return currentHour;
    });
  }, []);

  // Navigation: go forward one hour (snap to even hour)
  const goForward = useCallback(() => {
    setIsAtNow(false);
    setAnchor((current) => {
      const currentHour = floorToHour(current);
      // Go to next hour
      return addHours(currentHour, 1);
    });
  }, []);

  // Navigation: return to current time
  const goToNow = useCallback(() => {
    setIsAtNow(true);
    setAnchor(getNow());
  }, []);

  return {
    anchor,
    isAtNow,
    visibleHours,
    pixelsPerHour,
    windowStart,
    windowEnd,
    loadStart,
    loadEnd,
    goBack,
    goForward,
    goToNow,
  };
}
