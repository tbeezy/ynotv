#!/usr/bin/env node

/**
 * Setup libmpv wrapper library for macOS
 * This script downloads the libmpv-wrapper library needed for embedded video playback
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Only run on macOS
if (os.platform() !== 'darwin') {
  console.log('[libmpv setup] Skipping - not macOS');
  process.exit(0);
}

const srcTauriDir = path.join(__dirname, '..', 'src-tauri');
const wrapperPath = path.join(srcTauriDir, 'libmpv-wrapper.dylib');

// Check if already exists
if (fs.existsSync(wrapperPath)) {
  console.log('[libmpv setup] libmpv-wrapper.dylib already exists');
  process.exit(0);
}

console.log('[libmpv setup] Downloading libmpv-wrapper for macOS...');

try {
  // Download directly from GitHub releases
  const downloadUrl = 'https://github.com/nini22P/libmpv-wrapper/releases/download/v0.1.1/libmpv-wrapper-macos-aarch64.zip';
  
  execSync(`curl -L -o libmpv-wrapper.zip "${downloadUrl}"`, {
    stdio: 'inherit',
    cwd: srcTauriDir
  });
  
  execSync('unzip libmpv-wrapper.zip && rm libmpv-wrapper.zip', {
    stdio: 'inherit',
    cwd: srcTauriDir
  });
  
  if (fs.existsSync(wrapperPath)) {
    console.log('[libmpv setup] ✓ libmpv-wrapper downloaded successfully');
  } else {
    throw new Error('dylib not found after extraction');
  }
} catch (error) {
  console.error('[libmpv setup] ❌ Failed to download libmpv-wrapper:', error.message);
  process.exit(1);
}
