/**
 * The "hide disabled" toggle in the Add/Edit Global EPG form.
 *
 * There is no DOM in this test environment, so the contract is checked against
 * the form's source: which list the rows and "Select All" read from, that the
 * toggle defaults to off and reuses the Playlist Sources wording, and — most
 * importantly for a *view* toggle — that flipping it can never change what is
 * attached to the link.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const sourcesTabSrc = readFileSync(new URL('../SourcesTab.tsx', import.meta.url), 'utf8');

/** The Add/Edit Global EPG form markup, from its portal to its closing tag. */
function formSection(): string {
  const start = sourcesTabSrc.indexOf('{showAddEpgForm && createPortal(');
  expect(start, 'expected to find the Global EPG form portal').toBeGreaterThanOrEqual(0);
  const end = sourcesTabSrc.indexOf('</form>', start);
  return sourcesTabSrc.slice(start, end);
}

/** The JSX element whose body contains `marker`. */
function elementAt(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
  const start = src.lastIndexOf('<button', at);
  const end = src.indexOf('</button>', at);
  return src.slice(start, end);
}

describe('Global EPG form — hide disabled playlists', () => {
  it('offers a toggle that defaults to off', () => {
    expect(sourcesTabSrc).toContain('const [epgHideDisabled, setEpgHideDisabled] = useState(false)');
  });

  it('filters the list to enabled playlists only when it is on', () => {
    const form = formSection();
    // The derived list behind the toggle: on = enabled playlists, off = all.
    expect(sourcesTabSrc).toContain(
      'epgHideDisabled ? sources.filter(s => s.enabled !== false) : sources'
    );
    // Every row and the select-all read that list, never `sources` directly.
    expect(form).toContain('{epgLinkableSources.map(source => (');
    expect(form).not.toContain('{sources.map(source => (');
    expect(elementAt(form, 'settings:sources.selectAll')).toContain('epgLinkableSources.map');
  });

  it('reuses the Playlist Sources toggle wording and styling', () => {
    const toggle = elementAt(formSection(), 'sources-hide-toggle');

    expect(toggle).toContain("' active'");
    expect(toggle).toContain('aria-pressed={epgHideDisabled}');
    expect(toggle).toContain("i18n.t('settings:channelManager.hideDisabled')");
    expect(toggle).toContain("i18n.t('common:showAll')");
  });

  it('only toggles the view, never the attachment', () => {
    const toggle = elementAt(formSection(), 'sources-hide-toggle');

    expect(toggle).toContain('setEpgHideDisabled(v => !v)');
    // A filter that rewrote the selection would attach or detach playlists the
    // user never touched.
    expect(toggle).not.toContain('setEpgFormData');
  });

  it('keeps already attached playlists when selecting all under the filter', () => {
    const selectAll = elementAt(formSection(), 'settings:sources.selectAll');

    // The union: everything shown, plus whatever the filter is hiding.
    expect(selectAll).toContain('...prev.sourceIds');
    expect(selectAll).toContain('...epgLinkableSources.map(s => s.id)');
  });

  it('explains an empty filtered list instead of claiming there are no playlists', () => {
    const form = formSection();

    expect(form).toContain("epgLinkableSources.length === 0");
    expect(form).toContain("i18n.t('common:noResultsFound')");
    // The real empty state keeps its own message.
    expect(form).toContain("sources.length === 0");
    expect(form).toContain("i18n.t('settings:sources.noSourcesAvailable')");
  });

  it('still binds each row to the link form state', () => {
    expect(formSection()).toContain('checked={epgFormData.sourceIds.includes(source.id)}');
  });
});
