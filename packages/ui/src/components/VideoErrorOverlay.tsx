import './VideoErrorOverlay.css';

interface VideoErrorOverlayProps {
    error: string;
    onDismiss?: () => void;
    isSmall?: boolean;
}

export function VideoErrorOverlay({ error, onDismiss, isSmall = false }: VideoErrorOverlayProps) {
    console.log('[VideoErrorOverlay] Rendering with error:', error, 'isSmall:', isSmall);
    // Parse error for common HTTP codes
    let title = 'Playback Error';
    let message = error;
    let icon = '⚠️';
    let advice = '';

    if (error.includes('401')) {
        title = 'Unauthorized Access';
        advice = 'Your session may have expired or your credentials are invalid.';
        icon = '🔒';
    } else if (error.includes('403')) {
        title = 'Access Forbidden';
        advice = 'You do not have permission to view this content. Your provider may be blocking this stream or your IP.';
        icon = '🚫';
    } else if (error.includes('404')) {
        title = 'Stream Not Found';
        advice = 'The requested channel or video is no longer available.';
        icon = '🔍';
    } else if (error.includes('network') || error.includes('connection')) {
        title = 'Connection Error';
        advice = 'Failed to connect to the server. Please check your internet connection.';
        icon = '📡';
    }

    // specific override: if we have a detected HTTP error code, prioritize showing that over the generic message
    const isSpecificHttpError = error.includes('HTTP Error');
    if (isSpecificHttpError) {
        message = error;
    }

    return (
        <div className={`video-error-overlay ${isSmall ? 'small' : ''}`}>
            <div className="video-error-content">
                <div className="video-error-icon">{icon}</div>
                <h3 className="video-error-title">{title}</h3>
                <p className="video-error-message">{message}</p>
                {advice && <p className="video-error-advice">{advice}</p>}

                {/* Only show raw details if it's different from the main message (and we are not small) */}
                {!isSmall && message !== error && (
                    <div className="video-error-raw">Error details: {error}</div>
                )}

                {onDismiss && (
                    <button className="video-error-dismiss" onClick={onDismiss}>
                        Dismiss
                    </button>
                )}
            </div>
        </div>
    );
}
