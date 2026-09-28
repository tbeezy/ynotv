import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const modalSrc = readFileSync(
  new URL('../LocalEpisodesModal.tsx', import.meta.url),
  'utf8',
);
const localTabSrc = readFileSync(new URL('../LocalTab.tsx', import.meta.url), 'utf8');
const localTabCss = readFileSync(new URL('../LocalTab.css', import.meta.url), 'utf8');

describe('LocalEpisodesModal sizing and context menu contract', () => {
  it('applies local-modal-content--episodes class for wide desktop layout', () => {
    expect(modalSrc).toContain('className="local-modal-content local-modal-content--episodes"');
    expect(localTabCss).toMatch(/\.local-modal-content--episodes[\s\S]*?max-width:\s*880px/);
  });

  it('wires onContextMenu to episode rows', () => {
    expect(modalSrc).toContain('onContextMenu={(e) => onContextMenu(e, episode)}');
    expect(modalSrc).toContain('onContextMenu={handleEpisodeContextMenu}');
    expect(modalSrc).toContain('setCtxMenu({ x: e.clientX, y: e.clientY, entry })');
  });

  it('renders EpisodeContextMenu and EditEpisodeMetadataModal', () => {
    expect(modalSrc).toContain('<EpisodeContextMenu');
    expect(modalSrc).toContain('<EditEpisodeMetadataModal');
    expect(modalSrc).toContain('updateLocalEntries([editTarget.id], { ...patch, metadataLocked: true })');
  });

  it('delegates onFixMatch to the parent LocalTab component', () => {
    expect(modalSrc).toContain('onFixMatch?.(entry)');
    expect(localTabSrc).toContain('onFixMatch={(ep) => setIdentifyTarget([ep])}');
  });

  it('keeps currentEpisodesTarget fresh in LocalTab as library items update', () => {
    expect(localTabSrc).toContain('currentEpisodesTarget = useMemo(');
    expect(localTabSrc).toContain('matchGroup = groups.find((g) => g.kind === \'show\' && g.key === episodesModalTarget.key)');
    expect(localTabSrc).toContain('{ key: matchGroup.key, head: matchGroup.head, episodes: matchGroup.episodes }');
  });
});
