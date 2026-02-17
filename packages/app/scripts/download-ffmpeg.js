#!/usr/bin/env node

/**
 * Download FFmpeg binaries for the current platform
 * Runs automatically during prebuild to ensure FFmpeg is available for bundling
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FFMPEG_VERSION = '7.0.2'; // Update as needed

//Platform-specific download URLs
const DOWNLOAD_URLS = {
    win32: {
        url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z',
        fileName: 'ffmpeg-essentials.7z',
        extractPath: 'ffmpeg-7.0.2-essentials_build/bin/ffmpeg.exe',
        outputName: 'ffmpeg.exe'
    },
    darwin: {
        url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/7z',
        fileName: 'ffmpeg.7z',
        extractPath: 'ffmpeg',
        outputName: 'ffmpeg'
    },
    linux: {
        url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
        fileName: 'ffmpeg-linux.tar.xz',
        extractPath: 'ffmpeg-*-amd64-static/ffmpeg',
        outputName: 'ffmpeg'
    }
};

const platform = os.platform();
const binDir = path.join(__dirname, '..', 'src-tauri', 'bin');

// Tauri expects specific naming: {name}-{target triple}
// We'll detect the target from environment or use default
function getTargetName() {
    // Check for Tauri's target environment variable
    const targetArch = process.env.TAURI_ENV_TARGET_TRIPLE;
    if (targetArch) {
        return `ffmpeg-${targetArch}${platform === 'win32' ? '.exe' : ''}`;
    }

    // Default target for Windows
    if (platform === 'win32') {
        return 'ffmpeg-x86_64-pc-windows-msvc.exe';
    } else if (platform === 'darwin') {
        return 'ffmpeg-x86_64-apple-darwin';
    } else {
        return 'ffmpeg-x86_64-unknown-linux-gnu';
    }
}

const targetName = getTargetName();
const targetPath = path.join(binDir, targetName);

console.log('[FFmpeg Downloader] Target platform:', platform);
console.log('[FFmpeg Downloader] Binary directory:', binDir);

// Check if FFmpeg already exists
if (fs.existsSync(targetPath)) {
    console.log('[FFmpeg Downloader] ✓ FFmpeg already exists at:', targetPath);
    process.exit(0);
}

// Ensure bin directory exists
if (!fs.existsSync(binDir)) {
    console.log('[FFmpeg Downloader] Creating bin directory...');
    fs.mkdirSync(binDir, { recursive: true });
}

const config = DOWNLOAD_URLS[platform];
if (!config) {
    console.error(`[FFmpeg Downloader] ❌ Unsupported platform: ${platform}`);
    console.error('[FFmpeg Downloader] Please download FFmpeg manually and place it in:', binDir);
    process.exit(1);
}

const downloadPath = path.join(binDir, config.fileName);

console.log('[FFmpeg Downloader] Downloading from:', config.url);
console.log('[FFmpeg Downloader] This may take a few minutes (~50MB)...');

// Download file
const file = fs.createWriteStream(downloadPath);
https.get(config.url, (response) => {
    // Handle redirects
    if (response.statusCode === 301 || response.statusCode === 302) {
        https.get(response.headers.location, (redirectResponse) => {
            redirectResponse.pipe(file);
            file.on('finish', () => {
                file.close();
                extractFFmpeg();
            });
        });
    } else {
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            extractFFmpeg();
        });
    }
}).on('error', (err) => {
    fs.unlinkSync(downloadPath);
    console.error('[FFmpeg Downloader] ❌ Download failed:', err.message);
    process.exit(1);
});

function extractFFmpeg() {
    console.log('[FFmpeg Downloader] Download complete. Extracting...');

    try {
        // Use 7z for Windows, tar for Linux/Mac
        if (platform === 'win32') {
            // Try to use 7z if available, otherwise provide instructions
            try {
                execSync(`7z x "${downloadPath}" -o"${binDir}" -y`, { stdio: 'inherit' });

                // Find and move ffmpeg.exe to bin root
                const extractedPath = path.join(binDir, config.extractPath);
                if (fs.existsSync(extractedPath)) {
                    fs.renameSync(extractedPath, targetPath);
                    console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);

                    // Cleanup
                    cleanup();
                } else {
                    throw new Error('FFmpeg not found in extracted archive');
                }
            } catch (e) {
                console.error('[FFmpeg Downloader] ❌ 7z not found. Please install 7-Zip or extract manually:');
                console.error(`  1. Extract ${downloadPath}`);
                console.error(`  2. Copy ffmpeg.exe to ${targetPath}`);
                process.exit(1);
            }
        } else if (platform === 'darwin') {
            execSync(`7z x "${downloadPath}" -o"${binDir}" -y`, { stdio: 'inherit' });
            const extractedPath = path.join(binDir, config.extractPath);
            if (fs.existsSync(extractedPath)) {
                fs.renameSync(extractedPath, targetPath);
                fs.chmodSync(targetPath, 0o755); // Make executable
                console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);
                cleanup();
            }
        } else if (platform === 'linux') {
            execSync(`tar -xf "${downloadPath}" -C "${binDir}"`, { stdio: 'inherit' });

            // Find ffmpeg in extracted directory
            const files = fs.readdirSync(binDir);
            const extractedDir = files.find(f => f.startsWith('ffmpeg-') && f.includes('-amd64-static'));

            if (extractedDir) {
                const extractedPath = path.join(binDir, extractedDir, 'ffmpeg');
                if (fs.existsSync(extractedPath)) {
                    fs.renameSync(extractedPath, targetPath);
                    fs.chmodSync(targetPath, 0o755); // Make executable
                    console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);

                    // Cleanup extracted directory
                    fs.rmSync(path.join(binDir, extractedDir), { recursive: true, force: true });
                }
            }

            cleanup();
        }
    } catch (err) {
        console.error('[FFmpeg Downloader] ❌ Extraction failed:', err.message);
        console.error('[FFmpeg Downloader] Please extract manually:', downloadPath);
        process.exit(1);
    }
}

function cleanup() {
    // Remove downloaded archive
    try {
        if (fs.existsSync(downloadPath)) {
            fs.unlinkSync(downloadPath);
            console.log('[FFmpeg Downloader] Cleaned up temporary files');
        }
    } catch (e) {
        console.warn('[FFmpeg Downloader] Warning: Could not clean up temporary files');
    }

    console.log('[FFmpeg Downloader] ✅ FFmpeg ready for bundling!');
}
