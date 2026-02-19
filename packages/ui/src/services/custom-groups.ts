import { db, type CustomGroup, type CustomGroupChannel } from '../db';


/**
 * Create a new custom group
 */
export async function createCustomGroup(name: string): Promise<string> {
    const groupId = crypto.randomUUID();
    const count = await db.customGroups.count();

    await db.customGroups.add({
        group_id: groupId,
        name,
        display_order: count,
        created_at: Date.now()
    });

    return groupId;
}

/**
 * Delete a custom group and all its channel mappings
 */
export async function deleteCustomGroup(groupId: string): Promise<void> {
    await db.transaction('rw', [db.customGroups, db.customGroupChannels], async () => {
        await db.customGroupChannels.where('group_id').equals(groupId).delete();
        await db.customGroups.delete(groupId);
    });
}

/**
 * Rename a custom group
 */
export async function renameCustomGroup(groupId: string, newName: string): Promise<void> {
    await db.customGroups.update(groupId, { name: newName });
}

/**
 * Add channels to a custom group
 */
export async function addChannelsToGroup(groupId: string, streamIds: string[]): Promise<void> {
    await db.transaction('rw', [db.customGroupChannels], async () => {
        // Get current max order
        const lastItem = await db.customGroupChannels
            .where('group_id').equals(groupId)
            .reverse() // Sort by ID or order? We should verify schema.
            // The index is idx_custom_group_channels_order(group_id, display_order)
            // But Dexie 'reverse' on a compound index might be tricky if not defined in Dexie schema string.
            // Let's just use toArray and sort for now if count is low, or count().
            .sortBy('display_order');

        let nextOrder = 0;
        if (lastItem && lastItem.length > 0) {
            nextOrder = (lastItem[0].display_order || 0) + 1;
        }

        const now = Date.now();
        const items: CustomGroupChannel[] = streamIds.map((streamId, index) => ({
            group_id: groupId,
            stream_id: streamId,
            display_order: nextOrder + index,
            added_at: now
        }));

        await db.customGroupChannels.bulkAdd(items);
    });
}

/**
 * Remove channels from a custom group
 */
export async function removeChannelsFromGroup(groupId: string, streamIds: string[]): Promise<void> {
    await db.transaction('rw', [db.customGroupChannels], async () => {
        // Fetch specific entries since .and() is not supported in our adapter
        const groupChannels = await db.customGroupChannels.where('group_id').equals(groupId).toArray();
        const idsToDelete = groupChannels
            .filter(c => streamIds.includes(c.stream_id))
            .map(c => c.id as number);

        if (idsToDelete.length > 0) {
            await db.customGroupChannels.bulkDelete(idsToDelete);
        }
    });
}

/**
 * Reorder channels in a custom group
 */
export async function reorderGroupChannels(groupId: string, orderedStreamIds: string[]): Promise<void> {
    await db.transaction('rw', [db.customGroupChannels], async () => {
        const items = await db.customGroupChannels.where('group_id').equals(groupId).toArray();
        const itemMap = new Map(items.map(i => [i.stream_id, i]));

        for (let i = 0; i < orderedStreamIds.length; i++) {
            const streamId = orderedStreamIds[i];
            const item = itemMap.get(streamId);
            if (item) {
                await db.customGroupChannels.update(item.id!, { display_order: i });
            }
        }
    });
}
