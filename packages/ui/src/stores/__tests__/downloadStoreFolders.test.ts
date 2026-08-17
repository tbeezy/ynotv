import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDownloadStore } from '../downloadStore';
import { useSettingsStore } from '../settingsStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn().mockResolvedValue('/custom/prompt/save/file.mp4'),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe('downloadStore folder organization', () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: [], pendingStalkerDownload: null });
    useSettingsStore.setState({
      downloadsPath: 'C:\\Users\\User\\Downloads',
      separateDownloadFolders: true,
    });
    vi.clearAllMocks();
  });

  it('routes movies to Movies subfolder when separateDownloadFolders is true', async () => {
    await useDownloadStore.getState().startDownload(
      'Inception (2010)',
      'http://example.com/movie.mp4',
      undefined,
      7200,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Movies'
    );

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe('C:\\Users\\User\\Downloads\\Movies\\Inception (2010).mp4');
  });

  it('routes series to Series subfolder when separateDownloadFolders is true', async () => {
    await useDownloadStore.getState().startDownload(
      'Breaking Bad - S01E01',
      'http://example.com/episode.mp4',
      undefined,
      3600,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Series'
    );

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe('C:\\Users\\User\\Downloads\\Series\\Breaking Bad - S01E01.mp4');
  });

  it('auto-detects series title format and routes to Series subfolder if category is omitted', async () => {
    await useDownloadStore.getState().startDownload(
      'Severance - S02E01 - Episode Name',
      'http://example.com/stream.mp4'
    );

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe('C:\\Users\\User\\Downloads\\Series\\Severance - S02E01 - Episode Name.mp4');
  });

  it('does not duplicate subfolder if downloadsPath already ends with category', async () => {
    useSettingsStore.setState({
      downloadsPath: 'C:\\Users\\User\\Downloads\\Movies',
      separateDownloadFolders: true,
    });

    await useDownloadStore.getState().startDownload(
      'The Matrix (1999)',
      'http://example.com/matrix.mp4',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Movies'
    );

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe('C:\\Users\\User\\Downloads\\Movies\\The Matrix (1999).mp4');
  });

  it('saves directly to downloadsPath root when separateDownloadFolders is false', async () => {
    useSettingsStore.setState({
      downloadsPath: 'C:\\Users\\User\\Downloads',
      separateDownloadFolders: false,
    });

    await useDownloadStore.getState().startDownload(
      'Interstellar (2014)',
      'http://example.com/interstellar.mp4',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Movies'
    );

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe('C:\\Users\\User\\Downloads\\Interstellar (2014).mp4');
  });

  it('preserves category through stalker download confirmation', async () => {
    await useDownloadStore.getState().startDownload(
      'Stalker Series - S01E01',
      'stalker_12345',
      undefined,
      undefined,
      undefined,
      undefined,
      'stalker-source-id',
      'stalker_12345',
      undefined,
      'Series'
    );

    expect(useDownloadStore.getState().pendingStalkerDownload).not.toBeNull();
    expect(useDownloadStore.getState().pendingStalkerDownload?.category).toBe('Series');

    await useDownloadStore.getState().confirmStalkerDownload(true);

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe('C:\\Users\\User\\Downloads\\Series\\Stalker Series - S01E01.mp4');
  });

  it('uses custom preResolvedSavePath for season folder organization', async () => {
    const customPath = 'C:\\Users\\User\\Downloads\\Series\\Invincible\\Season 1\\Invincible - S01E01.mp4';
    await useDownloadStore.getState().startDownload(
      'Invincible - S01E01',
      'http://example.com/invincible_s01e01.mp4',
      undefined,
      3000,
      customPath,
      undefined,
      'source-1',
      'stream-url',
      undefined,
      'Series'
    );

    const downloads = useDownloadStore.getState().downloads;
    expect(downloads.length).toBe(1);
    expect(downloads[0].savePath).toBe(customPath);
  });
});
