/**
 * EPG Parser Web Worker
 * Handles decompression and parsing of XMLTV data off the main thread
 */

import { parseXmltv, type XmltvProgram } from '@ynotv/local-adapter';

export interface EpgWorkerMessage {
  type: 'parse';
  id: number;
  data?: string;        // Raw XML text or base64 gzipped data
  buffer?: Uint8Array;  // Transferred buffer (for large data)
  isBuffer?: boolean;   // True if using buffer instead of string
  isGzipped: boolean;
}

export interface EpgWorkerResponse {
  type: 'result' | 'error';
  id: number;
  programs?: XmltvProgram[];
  error?: string;
}

// Decompress gzipped data
async function decompressGzip(base64Data: string): Promise<string> {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const ds = new DecompressionStream('gzip');
  const decompressedStream = new Blob([bytes]).stream().pipeThrough(ds);
  const decompressedBlob = await new Response(decompressedStream).blob();
  return await decompressedBlob.text();
}

self.onmessage = async (event: MessageEvent<EpgWorkerMessage>) => {
  const { type, id, data, buffer, isBuffer, isGzipped } = event.data;

  if (type !== 'parse') return;

  try {
    let xmlText: string;

    // Get the data - either from transferred buffer or string
    let inputData: string;
    if (isBuffer && buffer) {
      // Decode transferred buffer back to string
      const decoder = new TextDecoder();
      inputData = decoder.decode(buffer);
    } else if (data) {
      inputData = data;
    } else {
      throw new Error('No data provided');
    }

    if (isGzipped) {
      xmlText = await decompressGzip(inputData);
    } else {
      xmlText = inputData;
    }

    const programs = parseXmltv(xmlText);

    self.postMessage({
      type: 'result',
      id,
      programs,
    } as EpgWorkerResponse);
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      error: err instanceof Error ? err.message : String(err),
    } as EpgWorkerResponse);
  }
};
