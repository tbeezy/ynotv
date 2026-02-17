/**
 * Constants for Stalker Portal Client
 */

// Retry and timeout configuration
export const STALKER_MAX_RETRIES = 3;
export const STALKER_TIMEOUT_MS = 60000; // 60 seconds
export const STALKER_RETRY_BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s exponential backoff

// Token management
export const STALKER_TOKEN_VALIDITY_SECONDS = 3600; // 1 hour

// Request limits (from working player behavior)
export const STALKER_MAX_HANDSHAKE_ATTEMPTS = 3;
export const STALKER_HANDSHAKE_RETRY_DELAY_MS = 500;
