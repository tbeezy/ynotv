import { useSetChannelSortOrder } from '../../stores/uiStore';

interface ChannelsTabProps {
  channelSortOrder: 'alphabetical' | 'number';
  onChannelSortOrderChange: (order: 'alphabetical' | 'number') => void;
}

export function ChannelsTab({
  channelSortOrder,
  onChannelSortOrderChange,
}: ChannelsTabProps) {
  const setChannelSortOrder = useSetChannelSortOrder();

  async function handleSortOrderChange(order: 'alphabetical' | 'number') {
    onChannelSortOrderChange(order);
    setChannelSortOrder(order); // Update global store immediately
    if (!window.storage) return;
    await window.storage.updateSettings({ channelSortOrder: order });
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Channel Display</h3>
        </div>

        <p className="section-description">
          Configure how channels are sorted in the guide.
        </p>

        <div className="refresh-settings">
          <div className="form-group inline">
            <label>Sort Order</label>
            <select
              value={channelSortOrder}
              onChange={(e) => handleSortOrderChange(e.target.value as 'alphabetical' | 'number')}
            >
              <option value="alphabetical">Alphabetical (A-Z)</option>
              <option value="number">Channel Number</option>
            </select>
          </div>
        </div>

        <p className="form-hint" style={{ marginTop: '0.75rem' }}>
          "Channel Number" uses the order from your provider (Xtream num or M3U tvg-chno).
          Channels without a number will appear at the end, sorted alphabetically.
        </p>
      </div>
    </div>
  );
}
