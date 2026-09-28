import { describe, it, expect } from 'vitest';
import { computeEpisodeContextMenuPosition } from '../LocalDetail';

describe('EpisodeContextMenu positioning & boundary clamping', () => {
  const MENU_WIDTH = 190;
  const MENU_HEIGHT = 86;
  const VIEWPORT_WIDTH = 1920;
  const VIEWPORT_HEIGHT = 1080;

  it('keeps exact coordinates when cursor has plenty of space around it', () => {
    const pos = computeEpisodeContextMenuPosition(
      350,
      400,
      MENU_WIDTH,
      MENU_HEIGHT,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    expect(pos).toEqual({ x: 350, y: 400 });
  });

  it('clamps X to stay within viewport when right-clicked near the right edge', () => {
    // E.g., user right-clicks at x = 1850 in a 1920px wide viewport
    const pos = computeEpisodeContextMenuPosition(
      1850,
      400,
      MENU_WIDTH,
      MENU_HEIGHT,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    // Max allowable X is VIEWPORT_WIDTH - MENU_WIDTH - 10 = 1920 - 190 - 10 = 1720
    expect(pos.x).toBe(1720);
    expect(pos.y).toBe(400);
  });

  it('clamps X to stay at least 10px from the left edge', () => {
    const pos = computeEpisodeContextMenuPosition(
      4,
      300,
      MENU_WIDTH,
      MENU_HEIGHT,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(300);
  });

  it('flips Y upward when right-clicked near the bottom edge and space is available', () => {
    // E.g., user right-clicks at y = 1050 in a 1080px high viewport
    const pos = computeEpisodeContextMenuPosition(
      500,
      1050,
      MENU_WIDTH,
      MENU_HEIGHT,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    // Menu flips above cursor: y = 1050 - 86 = 964
    expect(pos.y).toBe(964);
    expect(pos.x).toBe(500);
  });

  it('safely clamps Y when viewport height is too small for upward flip', () => {
    // E.g., tight viewport height of 100px and click at y = 80
    const pos = computeEpisodeContextMenuPosition(
      500,
      80,
      MENU_WIDTH,
      MENU_HEIGHT,
      VIEWPORT_WIDTH,
      100,
    );
    // 80 - 86 = -6 (< 10), so clamps to Math.max(10, 100 - 86 - 10) = 10
    expect(pos.y).toBe(10);
  });

  it('does not flip Y when menu fits comfortably below cursor', () => {
    const pos = computeEpisodeContextMenuPosition(
      500,
      900,
      MENU_WIDTH,
      MENU_HEIGHT,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    // 900 + 86 = 986 <= 1070 (1080 - 10), so no flip or clamp needed
    expect(pos.y).toBe(900);
  });

  it('exports identical computeEpisodeContextMenuPosition from EpisodeContextMenu and LocalDetail', async () => {
    const fromLocalDetail = await import('../LocalDetail');
    const fromEpisodeContextMenu = await import('../EpisodeContextMenu');
    expect(fromLocalDetail.computeEpisodeContextMenuPosition).toBe(
      fromEpisodeContextMenu.computeEpisodeContextMenuPosition,
    );
    expect(fromLocalDetail.EpisodeContextMenu).toBe(
      fromEpisodeContextMenu.EpisodeContextMenu,
    );
  });
});

