import { useState, useEffect } from 'react';
import type { StoredChannel } from '../db';
import { db } from '../db';
import { getFailoverGroupMembers } from '../services/failover-groups';
import { useSourceNameMap } from '../hooks/useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import './FailoverGroupOverlay.css';

interface FailoverGroupOverlayProps {
  currentChannel: StoredChannel | null;
  visible: boolean;
  onChannelClick: (channel: StoredChannel) => void;
  showSource?: boolean;
}

interface GroupMember {
  stream_id: string;
  priority: number;
  name: string;
  stream_icon?: string;
  source_id?: string;
}

export function FailoverGroupOverlay({
  currentChannel,
  visible,
  onChannelClick,
  showSource: showSourceProp,
}: FailoverGroupOverlayProps) {
  const { t } = useTranslation('player');
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [groupName, setGroupName] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const appSettingShowSource = useSettingsStore((s) => s.failoverGroupShowSource);
  const [localShowSource, setLocalShowSource] = useState(appSettingShowSource);
  const sourceNameMap = useSourceNameMap();

  useEffect(() => {
    setLocalShowSource(appSettingShowSource);
  }, [appSettingShowSource]);

  useEffect(() => {
    const handleSettingsChanged = (e: Event) => {
      const customEv = e as CustomEvent;
      if (customEv.detail && typeof customEv.detail.failoverGroupShowSource === 'boolean') {
        setLocalShowSource(customEv.detail.failoverGroupShowSource);
      }
    };

    window.addEventListener('ynotv:livetv-settings-changed', handleSettingsChanged);
    window.addEventListener('ynotv:settings-changed', handleSettingsChanged);
    return () => {
      window.removeEventListener('ynotv:livetv-settings-changed', handleSettingsChanged);
      window.removeEventListener('ynotv:settings-changed', handleSettingsChanged);
    };
  }, []);

  const showSource = showSourceProp ?? localShowSource;

  useEffect(() => {
    if (!currentChannel) {
      setMembers([]);
      setGroupName('');
      return;
    }

    let isMounted = true;
    setLoading(true);

    async function load() {
      try {
        // First find which group this channel belongs to
        const membership = await db.failoverGroupMembers
          .where('stream_id')
          .equals(currentChannel!.stream_id)
          .first();

        if (!membership) {
          if (isMounted) {
            setMembers([]);
            setGroupName('');
          }
          return;
        }

        const groupId = membership.group_id;

        // Fetch group name
        const group = await db.failoverGroups
          .where('group_id')
          .equals(groupId)
          .first();

        if (group && isMounted) {
          setGroupName(group.name);
        }

        // Fetch all members of this group
        const groupMembers = await getFailoverGroupMembers(groupId);
        if (isMounted) setMembers(groupMembers);
      } catch (e) {
        console.error('[FailoverGroupOverlay] Failed to load members:', e);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    load();
    return () => { isMounted = false; };
  }, [currentChannel?.stream_id]);

  if (!visible || members.length <= 1) return null;

  const currentStreamId = currentChannel?.stream_id;

  return (
    <div className="failover-group-overlay">
      <div className="fgo-header">
        <span className="fgo-header-icon">🔗</span>
        <span className="fgo-header-name" title={groupName}>{groupName}</span>
      </div>
      <div className="fgo-list">
        {members.map((member) => {
          const isActive = member.stream_id === currentStreamId;
          const sourceName = (showSource && sourceNameMap && member.source_id)
            ? sourceNameMap.get(member.source_id)
            : undefined;

          return (
            <button
              key={member.stream_id}
              className={`fgo-item ${isActive ? 'fgo-active' : ''}`}
              onClick={() => {
                if (isActive) return;
                // Need to find the full channel object — fetch from db
                db.channels.where('stream_id').equals(member.stream_id).first().then((ch) => {
                  if (ch) onChannelClick(ch);
                });
              }}
              disabled={isActive}
              title={isActive ? t('currentlyPlaying') : t('switchTo', { name: member.name })}
            >
              {member.stream_icon ? (
                <img
                  src={member.stream_icon}
                  alt=""
                  className="fgo-logo"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <span className="fgo-logo-placeholder">📺</span>
              )}
              <div className="fgo-info">
                <span className="fgo-name" title={member.name}>{member.name}</span>
                {sourceName && (
                  <span className="fgo-source-name" title={sourceName}>{sourceName}</span>
                )}
              </div>
              {isActive && <span className="fgo-badge">●</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
