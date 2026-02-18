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

const libDir = path.join(__dirname, '..', 'src-tauri', 'lib');
const wrapperPath = path.join(libDir, 'libmpv-wrapper.dylib');

// Check if already exists
if (fs.existsSync(wrapperPath)) {
  console.log('[libmpv setup] libmpv-wrapper.dylib already exists');
  process.exit(0);
}

// Ensure lib directory exists
if (!fs.existsSync(libDir)) {
  console.log('[libmpv setup] Creating lib directory...');
  fs.mkdirSync(libDir, { recursive: true });
}

console.log('[libmpv setup] Downloading libmpv-wrapper for macOS...');

try {
  // Run the setup-lib command from tauri-plugin-libmpv-api
  execSync('npx tauri-plugin-libmpv-api setup-lib', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  
  console.log('[libmpv setup] ✓ libmpv-wrapper downloaded successfully');
} catch (error) {
  console.error('[libmpv setup] ❌ Failed to download libmpv-wrapper:', error.message);
  console.error('[libmpv setup] Please ensure you have tauri-plugin-libmpv-api installed');
  process.exit(1);
}
