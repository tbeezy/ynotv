import { useState, useEffect, useRef, useCallback } from 'react';
import { getScheduledRecordings, type DvrSchedule } from '../db';

export interface RecordingInfo {
  scheduleId: number;
  channelId: string;
  programTitle: string;
  startTime: number;        // Actual recording start (with padding)
  endTime: number;          // Actual recording end (with padding)
  programStartTime: number; // Original program start (without padding)
  programEndTime: number;   // Original program end (without padding)
  isRecording: boolean;
  isScheduled: boolean;
}

export function useActiveRecordings(pollInterval = 5000) {
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRecordings = useCallback(async () => {
    try {
      // Fetch both scheduled and recording items
      const [scheduledData, completedData] = await Promise.all([
        getScheduledRecordings(),
        Promise.resolve([]) // Placeholder for future expansion
      ]);

      // Map scheduled items (includes both 'scheduled' and 'recording' status)
      const mappedRecordings: RecordingInfo[] = scheduledData.map((s: DvrSchedule) => {
        // Calculate original program times by removing padding
        const startPadding = s.start_padding_sec || 0;
        const endPadding = s.end_padding_sec || 0;
        return {
          scheduleId: s.id!,
          channelId: s.channel_id,
          programTitle: s.program_title,
          startTime: s.scheduled_start,
          endTime: s.scheduled_end,
          programStartTime: s.scheduled_start + startPadding, // Remove start padding
          programEndTime: s.scheduled_end - endPadding,       // Remove end padding
          isRecording: s.status === 'recording',
          isScheduled: s.status === 'scheduled',
        };
      });

      setRecordings(mappedRecordings);
    } catch (error) {
      console.error('[useActiveRecordings] Failed to fetch:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    fetchRecordings();

    // Set up polling
    intervalRef.current = setInterval(fetchRecordings, pollInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchRecordings, pollInterval]);

  const isChannelRecording = useCallback((channelId: string): boolean => {
    return recordings.some(r => r.channelId === channelId && r.isRecording);
  }, [recordings]);

  const isProgramRecording = useCallback((channelId: string, programStart: number, programEnd: number): boolean => {
    // Use programStartTime/programEndTime for precise matching (without padding)
    return recordings.some(r =>
      r.channelId === channelId &&
      r.isRecording &&
      r.programStartTime <= programEnd &&
      r.programEndTime >= programStart
    );
  }, [recordings]);

  const getRecordingForChannel = useCallback((channelId: string): RecordingInfo | undefined => {
    return recordings.find(r => r.channelId === channelId && r.isRecording);
  }, [recordings]);

  // Check if any recording is currently active (for title bar indicator)
  const isRecording = recordings.some(r => r.isRecording);

  return {
    recordings,
    loading,
    isRecording,
    refresh: fetchRecordings,
    isChannelRecording,
    isProgramRecording,
    getRecordingForChannel,
  };
}
