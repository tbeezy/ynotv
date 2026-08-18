import { useMemo, memo } from 'react';
import { useEpgClockFormat } from '../stores/uiStore';
import { formatTime } from '../utils/dateTime';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { RecordingIndicator } from './RecordingIndicator';
import type { StoredProgram, StoredChannel } from '../db';
import './ProgramBlock.css';

interface ProgramBlockProps {
  program: StoredProgram;
  channel?: StoredChannel;
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  onClick?: () => void;
  onPlayCatchup?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, programDesc?: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  isRecording?: boolean;
  isScheduled?: boolean;
  isCatchupAvailable?: boolean;
}

interface ProgramStyle {
  left: number;
  width: number;
  visible: boolean;
}

// Gap between program blocks in pixels
const PROGRAM_GAP = 2;

export function getProgramStyle(
  program: StoredProgram,
  windowStart: Date,
  windowEnd: Date,
  pixelsPerHour: number
): ProgramStyle {
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();

  const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
  const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();

  // Not visible if entirely outside window
  if (progEndMs <= windowStartMs || progStartMs >= windowEndMs) {
    return { left: 0, width: 0, visible: false };
  }

  // If the program started before the visible window and only overlaps into the window
  // by a negligible amount (less than 1 minute), it belongs to the previous timeslot
  // and must not render as an overlapping sliver.
  if (progStartMs < windowStartMs && progEndMs - windowStartMs < 60000) {
    return { left: 0, width: 0, visible: false };
  }

  // If the program ends after the visible window and only overlaps into the window
  // by a negligible amount (less than 1 minute), it belongs to the next timeslot.
  if (progEndMs > windowEndMs && windowEndMs - progStartMs < 60000) {
    return { left: 0, width: 0, visible: false };
  }

  // Clamp to visible window
  const visibleStart = Math.max(progStartMs, windowStartMs);
  const visibleEnd = Math.min(progEndMs, windowEndMs);

  if (visibleEnd <= visibleStart) {
    return { left: 0, width: 0, visible: false };
  }

  // Calculate position and width in pixels
  const startOffsetHours = (visibleStart - windowStartMs) / 3600000;
  const durationHours = (visibleEnd - visibleStart) / 3600000;

  // Subtract gap from width to create visual separation
  const rawWidth = durationHours * pixelsPerHour;
  if (rawWidth <= PROGRAM_GAP) {
    return { left: 0, width: 0, visible: false };
  }

  // Apply minimum width only to programs starting in this window, preventing
  // clamped left-edge slices from expanding into adjacent blocks.
  const width = progStartMs < windowStartMs
    ? Math.max(rawWidth - PROGRAM_GAP, 1)
    : Math.max(rawWidth - PROGRAM_GAP, 20);

  return {
    left: startOffsetHours * pixelsPerHour,
    width,
    visible: true,
  };
}

export const ProgramBlock = memo(function ProgramBlock({
  program,
  channel,
  windowStart,
  windowEnd,
  pixelsPerHour,
  onClick,
  onPlayCatchup,
  onContextMenu,
  isRecording = false,
  isScheduled = false,
  isCatchupAvailable = false,
}: ProgramBlockProps) {
  useTranslation();
  const style = useMemo(
    () => getProgramStyle(program, windowStart, windowEnd, pixelsPerHour),
    [program, windowStart, windowEnd, pixelsPerHour]
  );

  // Check if this program contains "now"
  const now = new Date();
  const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
  const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
  const isCurrent = progStartMs <= now.getTime() && progEndMs > now.getTime();
  const isPast = progEndMs < now.getTime();

  const epgClockFormat = useEpgClockFormat();

  // Format time for tooltip
  const formatEpgTime = (date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    return formatTime(d, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
  };

  const handleProgramClick = () => {
    // If program is in the past or current and catchup is available, play catchup
    if ((isPast || isCurrent) && isCatchupAvailable && onPlayCatchup && channel) {
      const durationMins = Math.round((progEndMs - progStartMs) / 60000);
      const rawStartMs = program.raw_start 
        ? new Date(program.raw_start).getTime() 
        : progStartMs;
      onPlayCatchup(channel, program.title, rawStartMs, durationMins, program.description);
    } else if (onClick) {
      onClick(); // Default (plays live channel)
    }
  };

  if (!style.visible) {
    return null;
  }

  // Determine if we should show second line (only if block is wide enough)
  const showSecondLine = style.width > 200;
  const hasSubtitle = !!program.subtitle;

  // Determine if we should show the recording indicator (need enough space)
  const showRecordingIndicator = isRecording && style.width > 60;
  const showScheduledIndicator = isScheduled && !isRecording && style.width > 60;

  return (
    <div
      className={`program-block ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''} ${isRecording ? 'is-recording' : ''} ${isScheduled ? 'is-scheduled' : ''} ${isCatchupAvailable && (isPast || isCurrent) ? 'catchup-available' : ''}`}
      style={{
        left: `${style.left}px`,
        width: `${style.width}px`,
        cursor: (isCatchupAvailable && (isPast || isCurrent)) || isCurrent ? 'pointer' : 'default'
      }}
      onClick={handleProgramClick}
      onContextMenu={onContextMenu}
      title={`${program.title}${program.subtitle ? `\n${program.subtitle}` : ''}\n${formatEpgTime(program.start)} - ${formatEpgTime(program.end)}${program.description ? `\n\n${program.description}` : ''}${isCatchupAvailable && (isPast || isCurrent) ? '\n\n' + i18n.t('epg:clickPlayCatchup') : ''}`}
    >
      {showRecordingIndicator && (
        <div className="program-recording-indicator">
          <RecordingIndicator size="small" variant="recording" />
        </div>
      )}
      {showScheduledIndicator && (
        <div className="program-scheduled-indicator">
          <RecordingIndicator size="small" variant="scheduled" />
        </div>
      )}
      <span className="program-block-title">{program.title}</span>
      {showSecondLine && hasSubtitle && (
        <span className="program-block-title">{program.subtitle}</span>
      )}
      {showSecondLine && !hasSubtitle && program.description && (
        <span className="program-block-desc">{program.description}</span>
      )}
    </div>
  );
});

// Empty state for channels with no EPG data
export const EmptyProgramBlock = memo(function EmptyProgramBlock({ pixelsPerHour, visibleHours }: { pixelsPerHour: number; visibleHours: number }) {
  const { t } = useTranslation('epg');
  const width = pixelsPerHour * visibleHours;

  return (
    <div
      className="program-block empty"
      style={{
        left: 0,
        width: `${width}px`,
      }}
    >
      <span className="program-block-title">{t('noEpgData')}</span>
    </div>
  );
});
