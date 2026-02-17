import './RecordingIndicator.css';

interface RecordingIndicatorProps {
  size?: 'small' | 'medium';
  variant?: 'recording' | 'scheduled';
  className?: string;
}

export function RecordingIndicator({ size = 'small', variant = 'recording', className = '' }: RecordingIndicatorProps) {
  const isRecording = variant === 'recording';
  return (
    <div
      className={`recording-indicator ${size} ${variant} ${className}`}
      title={isRecording ? 'Recording in progress' : 'Scheduled to record'}
    >
      <div className={`recording-dot ${isRecording ? 'pulse' : ''}`}></div>
      <span className="recording-text">REC</span>
    </div>
  );
}
