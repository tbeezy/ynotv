import { useSetChannelSortOrder } from '../../stores/uiStore';
import './PlaybackTab.css'; // Reuse existing tab styles for toggle

interface ChannelsTabProps {
  channelSortOrder: 'alphabetical' | 'number';
  onChannelSortOrderChange: (order: 'alphabetical' | 'number') => void;
  includeSourceInSearch: boolean;
  onIncludeSourceInSearchChange: (enabled: boolean) => void;
  maxSearchResults: number;
  onMaxSearchResultsChange: (limit: number) => void;
}

async function saveIncludeSourceInSearch(enabled: boolean) {
  if (!window.storage) return;
  await window.storage.updateSettings({ includeSourceInSearch: enabled });
}

async function saveMaxSearchResults(limit: number) {
  if (!window.storage) return;
  await window.storage.updateSettings({ maxSearchResults: limit });
}

export function ChannelsTab({
  channelSortOrder,
  onChannelSortOrderChange,
  includeSourceInSearch,
  onIncludeSourceInSearchChange,
  maxSearchResults,
  onMaxSearchResultsChange,
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

      <div className="settings-section" style={{ marginTop: '24px' }}>
        <div className="section-header">
          <h3>Search</h3>
        </div>

        <p className="section-description">
          Configure how channel search works.
        </p>

        <div className="timeshift-settings">
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">Include Source name in search</span>
              <span className="timeshift-toggle-sub">
                When enabled, search will also match against source names, and the source name will be displayed in search results.
                This helps distinguish between channels with the same name from different sources.
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={includeSourceInSearch}
                onChange={(e) => {
                onIncludeSourceInSearchChange(e.target.checked);
                saveIncludeSourceInSearch(e.target.checked);
              }}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <div className="refresh-settings" style={{ marginTop: '20px' }}>
          <div className="form-group inline">
            <label>Max search results</label>
            <select
              value={maxSearchResults}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                onMaxSearchResultsChange(value);
                saveMaxSearchResults(value);
              }}
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200 (default)</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
          </div>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            Maximum number of results to show in channel search, custom group search, and calendar channel selector.
            Higher values may impact performance.
          </p>
        </div>
      </div>
    </div>
  );
}
