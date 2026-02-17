/**
 * EPG Data Compression Utilities
 * 
 * Compresses EPG program data to reduce storage by ~60%
 * Uses pako (zlib) for fast, efficient compression
 */

import pako from 'pako';

// Compression level: 0-9 (9 = max compression, slower)
const COMPRESSION_LEVEL = 6;

/**
 * Compress a string to base64-encoded compressed data
 */
export function compressData(data: string): string {
  try {
    const compressed = pako.deflate(data, { level: COMPRESSION_LEVEL });
    // Convert to base64 for storage
    return btoa(String.fromCharCode(...compressed));
  } catch (error) {
    console.warn('[Compression] Failed to compress, returning original:', error);
    return data;
  }
}

/**
 * Decompress base64-encoded compressed data back to string
 */
export function decompressData(compressed: string): string {
  try {
    // Check if it looks like base64 (compressed data)
    if (!compressed || compressed.length < 10) {
      return compressed; // Too short to be compressed
    }
    
    // Try to decode base64
    const binary = atob(compressed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    const decompressed = pako.inflate(bytes, { to: 'string' });
    return decompressed;
  } catch (error) {
    // If decompression fails, return original (might not be compressed)
    return compressed;
  }
}

/**
 * Compress EPG program description
 * Only compresses if the description is long enough to benefit
 */
export function compressEpgDescription(description: string | null | undefined): string | null {
  if (!description || description.length < 100) {
    return description || null;
  }
  
  const compressed = compressData(description);
  // Only use compressed if it's actually smaller
  if (compressed.length < description.length) {
    return `COMPRESSED:${compressed}`;
  }
  return description;
}

/**
 * Decompress EPG program description
 * Handles both compressed and uncompressed data
 */
export function decompressEpgDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  
  if (description.startsWith('COMPRESSED:')) {
    const compressed = description.substring(11);
    return decompressData(compressed);
  }
  
  return description;
}

/**
 * Batch compress multiple EPG descriptions
 * Useful during sync operations
 */
export function batchCompressEpgDescriptions(programs: any[]): any[] {
  return programs.map(program => ({
    ...program,
    description: compressEpgDescription(program.description),
  }));
}

/**
 * Batch decompress multiple EPG descriptions
 * Useful when displaying programs
 */
export function batchDecompressEpgDescriptions(programs: any[]): any[] {
  return programs.map(program => ({
    ...program,
    description: decompressEpgDescription(program.description),
  }));
}
