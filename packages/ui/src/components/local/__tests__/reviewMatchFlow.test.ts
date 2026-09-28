import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Review-list lifecycle contract.
 *
 * These are source-level assertions on purpose: the review list and the identify
 * modal are portalled Tauri modals, and the UI test environment is node-only (no
 * jsdom, no testing-library), so the lifecycle cannot be driven in a test. The
 * behaviour being protected is narrow and structural — matching must never drop
 * a row optimistically, because the row would vanish even when the user cancels
 * the identify flow — so we assert on the wiring itself.
 */

const modalSrc = readFileSync(
  new URL('../ReviewUnmatchedModal.tsx', import.meta.url),
  'utf8',
);
const localTabSrc = readFileSync(new URL('../LocalTab.tsx', import.meta.url), 'utf8');

/** Source text of the block that starts at `marker`, braces balanced. */
function blockAfter(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block: ${marker}`);
}

describe('ReviewUnmatchedModal match wiring', () => {
  it('does not drop a row when a match is launched', () => {
    // The regression: dropping here emptied the working list synchronously, so
    // the list auto-closed (or silently lost rows the user then cancelled).
    expect(blockAfter(modalSrc, 'const matchGroup = ')).not.toContain('dropKeys');
    expect(blockAfter(modalSrc, 'const matchSelected = ')).not.toContain('dropKeys');
  });

  it('still drops rows for remove/skip, which write to the library immediately', () => {
    expect(blockAfter(modalSrc, 'const removeGroup = ')).toContain('dropKeys');
    expect(blockAfter(modalSrc, 'const skipGroup = ')).toContain('dropKeys');
    expect(blockAfter(modalSrc, 'const removeSelected = ')).toContain('dropKeys');
    expect(blockAfter(modalSrc, 'const skipSelected = ')).toContain('dropKeys');
  });

  it('adopts handled rows from the parent instead of guessing', () => {
    expect(modalSrc).toMatch(/handledKeys: Set<string>/);
    const effectAt = modalSrc.indexOf('handledKeys.size === 0');
    expect(effectAt).toBeGreaterThan(-1);
    const effect = modalSrc.slice(effectAt, effectAt + 700);
    expect(effect).toContain('setWorking');
    expect(effect).toContain('reviewGroupKey');
  });

  it('uses the shared review-group key so the parent can name the handled row', () => {
    expect(modalSrc).toContain(
      "import { reviewGroupIds, reviewGroupKey } from '../../services/local-library/review-groups';",
    );
    // A local copy would drift from the queue's key and silently drop nothing.
    expect(modalSrc).not.toMatch(/^function groupKey\(/m);
  });
});

describe('LocalTab identify-queue wiring', () => {
  it('reports a group as handled only after resolve, skip or remove', () => {
    const reports = localTabSrc.match(
      /markIdentifyHandled\(\);\r?\n\s*advanceIdentifyQueue\(\);/g,
    );
    expect(reports).toHaveLength(3);
  });

  it('reports nothing when the identify flow is cancelled', () => {
    const cancelAt = localTabSrc.lastIndexOf('identifyQueueRef.current = null;');
    expect(cancelAt).toBeGreaterThan(-1);
    const cancelPath = localTabSrc.slice(cancelAt, cancelAt + 240);
    expect(cancelPath).toContain('setIdentifyTarget(null)');
    expect(cancelPath).not.toContain('markIdentifyHandled');
    expect(cancelPath).not.toContain('setHandledReviewKeys');
  });

  it('carries the review-group key through the queue', () => {
    expect(localTabSrc).toContain('const identifyQueueRef = useRef<QueuedIdentify[] | null>(null);');
    const queue = blockAfter(localTabSrc, 'const openReviewMatch = useCallback(');
    expect(queue).toContain('reviewGroupKey(g)');
    expect(queue).toContain('reviewGroupEntries(g)');
    expect(blockAfter(localTabSrc, 'const advanceIdentifyQueue = useCallback(')).toContain(
      'identifyKeyRef.current = q[0].key',
    );
  });

  it('passes the handled keys to the review list and resets them on open', () => {
    expect(localTabSrc).toContain('handledKeys={handledReviewKeys}');
    expect(localTabSrc).toContain('setHandledReviewKeys(new Set());');
  });
});
