import { useState, useEffect } from 'react';

/**
 * Tracks the total rendered height of a Virtuoso list (the element with
 * `data-testid="virtuoso-item-list"` inside the scroller). This equals the
 * sum of all row heights, which lets the EPG current-time indicator stop at
 * the last rendered row instead of spanning the whole panel when a category
 * or search has only a few channels.
 *
 * Pass the scroller DOM node (from Virtuoso's `scrollerRef`). The hook watches
 * the scroller subtree so it re-attaches whenever the list element first
 * appears or is recreated by Virtuoso, and observes the list with a
 * ResizeObserver to track height changes as rows are measured.
 */
export function useVirtuosoListHeight(scroller: HTMLElement | null): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!scroller) return;

    let listEl: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;

    const measure = () => {
      if (listEl) setHeight(listEl.getBoundingClientRect().height);
    };

    const attach = () => {
      const el = scroller.querySelector('[data-testid="virtuoso-item-list"]');
      if (!(el instanceof HTMLElement)) {
        // List removed (e.g. no rows) -> fall back to full-height line
        if (listEl) {
          if (ro) ro.disconnect();
          ro = null;
          listEl = null;
          setHeight(0);
        }
        return;
      }
      if (el === listEl) return; // already attached; ResizeObserver handles size changes
      if (ro) ro.disconnect();
      listEl = el;
      ro = new ResizeObserver(measure);
      ro.observe(listEl);
      measure();
    };

    attach();
    const mo = new MutationObserver(() => attach());
    mo.observe(scroller, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      if (ro) ro.disconnect();
      setHeight(0);
    };
  }, [scroller]);

  return height;
}
