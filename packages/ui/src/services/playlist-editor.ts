import { db, type CustomPlaylist, type PlaylistCategoryLink, type PlaylistIndividualChannel } from '../db';

// ── Create ────────────────────────────────────────────────────────────────────

export async function createPlaylist(name: string): Promise<string> {
  const playlistId = crypto.randomUUID();
  const count = await db.customPlaylists.count();
  await db.customPlaylists.add({
    playlist_id: playlistId,
    name,
    display_order: count,
    created_at: Date.now()
  });
  return playlistId;
}

// ── Rename ────────────────────────────────────────────────────────────────────

export async function renamePlaylist(playlistId: string, newName: string): Promise<void> {
  await db.customPlaylists.update(playlistId, { name: newName });
}

// ── Delete ─────────────────────────────────────────────────────────────────────
// IMPORTANT: Manually delete children first since CASCADE may not fire.

export async function deletePlaylist(playlistId: string): Promise<void> {
  // Delete all category links for this playlist
  const catLinks = await db.playlistCategoryLinks.where('playlist_id').equals(playlistId).toArray();
  const catLinkIds = catLinks.map(l => l.id as number);
  if (catLinkIds.length > 0) await db.playlistCategoryLinks.bulkDelete(catLinkIds);

  // Delete all individual channels for this playlist
  const indivChannels = await db.playlistIndividualChannels.where('playlist_id').equals(playlistId).toArray();
  const indivIds = indivChannels.map(c => c.id as number);
  if (indivIds.length > 0) await db.playlistIndividualChannels.bulkDelete(indivIds);

  // Now delete the playlist itself
  await db.customPlaylists.delete(playlistId);
}

// ── Category Link CRUD ────────────────────────────────────────────────────────

export async function addCategoryToPlaylist(
  playlistId: string,
  sourceId: string,
  categoryId: string
): Promise<number> {
  // Check for duplicate
  const existing = await db.playlistCategoryLinks
    .whereRaw('playlist_id = ? AND category_id = ?', [playlistId, categoryId])
    .toArray();
  if (existing.length > 0) return existing[0].id as number; // Already added

  const existing_links = await db.playlistCategoryLinks
    .where('playlist_id').equals(playlistId)
    .toArray();
  const maxOrder = existing_links.length > 0
    ? Math.max(...existing_links.map(l => l.display_order))
    : -1;

  const id = await db.playlistCategoryLinks.add({
    playlist_id: playlistId,
    source_id: sourceId,
    category_id: categoryId,
    display_order: maxOrder + 1,
    added_at: Date.now()
  });
  return id as number;
}

export async function removeCategoryFromPlaylist(linkId: number): Promise<void> {
  await db.playlistCategoryLinks.delete(linkId);
}

export async function renameCategoryLink(linkId: number, customName: string | null): Promise<void> {
  await db.playlistCategoryLinks.update(linkId, { custom_name: customName ?? undefined });
}


// ── Individual Channel CRUD ───────────────────────────────────────────────────

export async function addIndividualChannelToPlaylist(
  playlistId: string,
  streamId: string
): Promise<void> {
  // Check for duplicate
  const existing = await db.playlistIndividualChannels
    .whereRaw('playlist_id = ? AND stream_id = ?', [playlistId, streamId])
    .toArray();
  if (existing.length > 0) return; // Already added

  const all = await db.playlistIndividualChannels
    .where('playlist_id').equals(playlistId)
    .toArray();
  const maxOrder = all.length > 0 ? Math.max(...all.map(c => c.display_order)) : -1;

  await db.playlistIndividualChannels.add({
    playlist_id: playlistId,
    stream_id: streamId,
    display_order: maxOrder + 1,
    added_at: Date.now()
  });
}

export async function addMultipleIndividualChannelsToPlaylist(
  playlistId: string,
  streamIds: string[]
): Promise<void> {
  const existing = await db.playlistIndividualChannels
    .where('playlist_id').equals(playlistId)
    .toArray();
  const existingIds = new Set(existing.map(c => c.stream_id));
  const newIds = streamIds.filter(id => !existingIds.has(id));
  if (newIds.length === 0) return;

  const maxOrder = existing.length > 0 ? Math.max(...existing.map(c => c.display_order)) : -1;
  const now = Date.now();
  const items: PlaylistIndividualChannel[] = newIds.map((streamId, i) => ({
    playlist_id: playlistId,
    stream_id: streamId,
    display_order: maxOrder + 1 + i,
    added_at: now
  }));
  await db.playlistIndividualChannels.bulkAdd(items);
}

export async function removeIndividualChannelFromPlaylist(
  playlistId: string,
  streamId: string
): Promise<void> {
  const all = await db.playlistIndividualChannels
    .where('playlist_id').equals(playlistId)
    .toArray();
  const toDelete = all.filter(c => c.stream_id === streamId).map(c => c.id as number);
  if (toDelete.length > 0) await db.playlistIndividualChannels.bulkDelete(toDelete);
}

export async function reorderPlaylistIndividualChannels(
  playlistId: string,
  orderedStreamIds: string[]
): Promise<void> {
  const items = await db.playlistIndividualChannels
    .where('playlist_id').equals(playlistId)
    .toArray();
  const itemMap = new Map(items.map(i => [i.stream_id, i]));

  const bulkItems = orderedStreamIds
    .map((streamId, i) => {
      const item = itemMap.get(streamId);
      return item && item.id !== undefined ? { ...item, display_order: i } : null;
    })
    .filter(Boolean) as PlaylistIndividualChannel[];
  if (bulkItems.length > 0) {
    await db.playlistIndividualChannels.bulkPut(bulkItems);
  }
}

// ── Reorder Playlists in Sidebar ──────────────────────────────────────────────

export async function reorderPlaylists(orderedPlaylistIds: string[]): Promise<void> {
  const playlists = await db.customPlaylists.where('playlist_id').anyOf(orderedPlaylistIds).toArray();
  const playlistMap = new Map(playlists.map(p => [p.playlist_id, p]));
  const bulkItems = orderedPlaylistIds
    .map((id, i) => {
      const playlist = playlistMap.get(id);
      return playlist ? { ...playlist, display_order: i } : null;
    })
    .filter(Boolean) as CustomPlaylist[];
  if (bulkItems.length > 0) {
    await db.customPlaylists.bulkPut(bulkItems);
  }
}

// ── Revert Real Source To Default ─────────────────────────────────────────────

export async function revertRealSourceToDefault(sourceId: string): Promise<void> {
  // 1. Delete category links
  await db.playlistCategoryLinks.where('playlist_id').equals(sourceId).delete();
  
  // 2. Delete individual channels
  await db.playlistIndividualChannels.where('playlist_id').equals(sourceId).delete();
  
  // 3. Reset display_order of native categories to null
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    `UPDATE categories SET display_order = NULL WHERE source_id = $1`,
    [sourceId]
  );
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('categories', 'update');
}

// ── Category Channel Insertions ─────────────────────────────────────────────

export async function addChannelToCategory(
  playlistId: string,
  parentCategoryId: string,
  streamId: string
): Promise<void> {
  const existing = await db.playlistIndividualChannels
    .whereRaw('playlist_id = ? AND stream_id = ? AND parent_category_id = ?', [playlistId, streamId, parentCategoryId])
    .toArray();
  if (existing.length > 0) return;

  const all = await db.playlistIndividualChannels
    .whereRaw('playlist_id = ? AND parent_category_id = ?', [playlistId, parentCategoryId])
    .toArray();
  const maxOrder = all.length > 0 ? Math.max(...all.map(c => c.display_order)) : -1;

  await db.playlistIndividualChannels.put({
    playlist_id: playlistId,
    stream_id: streamId,
    parent_category_id: parentCategoryId,
    display_order: maxOrder + 1,
    added_at: Date.now()
  });
}

export async function removeChannelFromCategory(
  playlistId: string,
  parentCategoryId: string,
  streamId: string
): Promise<void> {
  const all = await db.playlistIndividualChannels
    .whereRaw('playlist_id = ? AND parent_category_id = ?', [playlistId, parentCategoryId])
    .toArray();
  const toDelete = all.filter(c => c.stream_id === streamId).map(c => c.id as number);
  if (toDelete.length > 0) {
    await db.playlistIndividualChannels.bulkDelete(toDelete);
  }
}


export async function addCustomCategoryToPlaylist(
  playlistId: string,
  name: string
): Promise<number> {
  const existing_links = await db.playlistCategoryLinks
    .where('playlist_id').equals(playlistId)
    .toArray();
  const maxOrder = existing_links.length > 0
    ? Math.max(...existing_links.map(l => l.display_order))
    : -1;

  const id = await db.playlistCategoryLinks.add({
    playlist_id: playlistId,
    source_id: 'custom',
    category_id: `custom:${crypto.randomUUID()}`,
    custom_name: name,
    display_order: maxOrder + 1,
    added_at: Date.now()
  });
  return id as number;
}

export async function addChannelsToCategory(
  playlistId: string,
  parentCategoryId: string,
  streamIds: string[]
): Promise<void> {
  if (streamIds.length === 0) return;

  const existing = await db.playlistIndividualChannels
    .whereRaw('playlist_id = ? AND parent_category_id = ?', [playlistId, parentCategoryId])
    .toArray();
  const existingStreamIds = new Set(existing.map(c => c.stream_id));

  const toAdd = streamIds.filter(id => !existingStreamIds.has(id));
  if (toAdd.length === 0) return;

  const maxOrder = existing.length > 0 ? Math.max(...existing.map(c => c.display_order)) : -1;

  const newItems = toAdd.map((streamId, index) => ({
    playlist_id: playlistId,
    stream_id: streamId,
    parent_category_id: parentCategoryId,
    display_order: maxOrder + 1 + index,
    added_at: Date.now()
  }));

  await db.playlistIndividualChannels.bulkAdd(newItems);
}

// ── Category Folder CRUD ─────────────────────────────────────────────────────

export async function createCategoryFolder(playlistId: string, name: string): Promise<string> {
  const folderId = crypto.randomUUID();
  const existing = await db.categoryFolders.where('playlist_id').equals(playlistId).toArray();
  const maxOrder = existing.length > 0 ? Math.max(...existing.map(f => f.display_order)) : -1;
  await db.categoryFolders.add({
    folder_id: folderId,
    playlist_id: playlistId,
    name,
    display_order: maxOrder + 1,
    created_at: Date.now()
  });
  return folderId;
}

export async function renameCategoryFolder(folderId: string, newName: string): Promise<void> {
  await db.categoryFolders.update(folderId, { name: newName });
}

export async function deleteCategoryFolder(folderId: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    `UPDATE categories SET folder_id = NULL WHERE folder_id = $1`,
    [folderId]
  );
  await dbInstance.execute(
    `UPDATE playlist_category_links SET folder_id = NULL WHERE folder_id = $1`,
    [folderId]
  );
  await db.categoryFolders.delete(folderId);
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('categories', 'update');
  dbEvents.notify('playlist_category_links', 'update');
}

export async function assignCategoryToFolder(
  isLink: boolean,
  id: string | number,
  folderId: string | null
): Promise<void> {
  if (isLink) {
    await db.playlistCategoryLinks.update(Number(id), { folder_id: folderId || null as any });
  } else {
    await db.categories.update(String(id), { folder_id: folderId || null as any });
  }
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('categories', 'update');
  dbEvents.notify('playlist_category_links', 'update');
}

export async function reorderCategoryFolders(folderOrders: Array<{ folderId: string; displayOrder: number }>): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  for (const item of folderOrders) {
    await dbInstance.execute(
      `UPDATE category_folders SET display_order = $1 WHERE folder_id = $2`,
      [item.displayOrder, item.folderId]
    );
  }
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('category_folders', 'update');
}
