import { StoredChannel } from '../db';

const RECENT_CHANNELS_KEY = 'ynotv_recent_channels';
const MAX_RECENT_CHANNELS = 10;

export interface RecentChannelEntry {
  streamId: string;
  timestamp: number;
  channelName: string;
}

// Simple event emitter for recent channels updates
type Listener = () => void;
const listeners: Listener[] = [];

export function onRecentChannelsUpdate(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  };
}

function notifyListeners(): void {
  listeners.forEach(listener => listener());
}

/** Add a channel to recently viewed list */
export async function addToRecentChannels(channel: StoredChannel): Promise<void> {
  const recent = getRecentChannels();

  // Remove if already exists (to move to front)
  const filtered = recent.filter(r => r.streamId !== channel.stream_id);

  // Add to front
  filtered.unshift({
    streamId: channel.stream_id,
    timestamp: Date.now(),
    channelName: channel.name,
  });

  // Keep only max
  const trimmed = filtered.slice(0, MAX_RECENT_CHANNELS);

  // Save
  localStorage.setItem(RECENT_CHANNELS_KEY, JSON.stringify(trimmed));

  // Notify listeners
  notifyListeners();
}

/** Get list of recently viewed channel IDs */
export function getRecentChannels(): RecentChannelEntry[] {
  try {
    const stored = localStorage.getItem(RECENT_CHANNELS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load recent channels:', e);
  }
  return [];
}

/** Clear recently viewed channels */
export function clearRecentChannels(): void {
  localStorage.removeItem(RECENT_CHANNELS_KEY);
  notifyListeners();
}
