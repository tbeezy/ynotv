interface SecurityTabProps {
  allowLanSources: boolean;
  onAllowLanSourcesChange: (enabled: boolean) => void;
}

export function SecurityTab({
  allowLanSources,
  onAllowLanSourcesChange,
}: SecurityTabProps) {
  async function handleAllowLanChange(enabled: boolean) {
    if (!window.storage) return;
    onAllowLanSourcesChange(enabled);
    await window.storage.updateSettings({ allowLanSources: enabled });
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Network Security</h3>
        </div>

        <p className="section-description">
          By default, ynoTV blocks requests to local network addresses to prevent
          malicious playlists from probing your internal network (SSRF protection).
        </p>

        <div className="tmdb-form" style={{ marginTop: '1rem' }}>
          <label className="genre-checkbox" style={{ maxWidth: '320px' }}>
            <input
              type="checkbox"
              checked={allowLanSources}
              onChange={(e) => handleAllowLanChange(e.target.checked)}
            />
            <span className="genre-name">Allow LAN sources</span>
          </label>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            Enable this if your IPTV provider runs on your local network
            (e.g., Plex, Jellyfin, or a NAS). Only enable if you trust your playlist sources.
          </p>
        </div>
      </div>

      <p className="settings-disclaimer">
        Blocked addresses: localhost, 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x,
        and cloud metadata endpoints (169.254.x.x).
      </p>
    </div>
  );
}
