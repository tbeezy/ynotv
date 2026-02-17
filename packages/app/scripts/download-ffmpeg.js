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

const FFMPEG_VERSION = '7.0.2';

// Platform-specific download URLs
const DOWNLOAD_URLS = {
    win32: {
        // Use GitHub release for Windows static builds (more reliable)
        url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
        fileName: 'ffmpeg-win64.zip',
        extractPath: null,  // Will be detected dynamically
        outputName: 'ffmpeg.exe'
    },
    darwin: {
        // macOS: Use local/system FFmpeg (installed via Homebrew in CI)
        // No download needed - we'll copy from system
        url: null,
        fileName: null,
        extractPath: null,
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
const arch = os.arch();
const binDir = path.join(__dirname, '..', 'src-tauri', 'bin');

console.log('[FFmpeg Downloader] Platform:', platform, 'Arch:', arch);
console.log('[FFmpeg Downloader] Binary directory:', binDir);

// Detect target triple based on platform and architecture
function getTargetName() {
    // Check for Tauri's target environment variable (set during build)
    const targetArch = process.env.TAURI_ENV_TARGET_TRIPLE;
    if (targetArch) {
        const name = `ffmpeg-${targetArch}${platform === 'win32' ? '.exe' : ''}`;
        console.log('[FFmpeg Downloader] Using TAURI_ENV_TARGET_TRIPLE:', name);
        return name;
    }

    // Detect based on os.arch()
    if (platform === 'win32') {
        return 'ffmpeg-x86_64-pc-windows-msvc.exe';
    } else if (platform === 'darwin') {
        // macOS: detect arm64 vs x64
        if (arch === 'arm64') {
            return 'ffmpeg-aarch64-apple-darwin';
        } else {
            return 'ffmpeg-x86_64-apple-darwin';
        }
    } else {
        // Linux is typically x86_64
        return 'ffmpeg-x86_64-unknown-linux-gnu';
    }
}

const targetName = getTargetName();
const targetPath = path.join(binDir, targetName);

console.log('[FFmpeg Downloader] Target file:', targetName);

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
    console.error('[FFmpeg Downloader] Expected filename:', targetName);
    process.exit(1);
}

// macOS: Copy from system instead of downloading
if (platform === 'darwin') {
    console.log('[FFmpeg Downloader] Using system FFmpeg for macOS');

    // Common FFmpeg locations on macOS
    const ffmpegPaths = [
        '/opt/homebrew/bin/ffmpeg',      // Apple Silicon Homebrew
        '/usr/local/bin/ffmpeg',         // Intel Homebrew
        '/usr/bin/ffmpeg',               // System (rare)
    ];

    let ffmpegPath = null;
    for (const testPath of ffmpegPaths) {
        if (fs.existsSync(testPath)) {
            ffmpegPath = testPath;
            console.log('[FFmpeg Downloader] Found FFmpeg at:', ffmpegPath);
            break;
        }
    }

    if (!ffmpegPath) {
        console.error('[FFmpeg Downloader] ❌ FFmpeg not found on system.');
        console.error('[FFmpeg Downloader] Please install FFmpeg: brew install ffmpeg');
        console.error('[FFmpeg Downloader] Or download manually and place at:', targetPath);
        process.exit(1);
    }

    // Copy to bin directory with correct name
    fs.copyFileSync(ffmpegPath, targetPath);
    fs.chmodSync(targetPath, 0o755);
    console.log('[FFmpeg Downloader] ✓ FFmpeg copied to:', targetPath);
    console.log('[FFmpeg Downloader] ✅ FFmpeg ready for bundling!');
    process.exit(0);
}

const downloadPath = path.join(binDir, config.fileName);

console.log('[FFmpeg Downloader] Downloading from:', config.url);
console.log('[FFmpeg Downloader] This may take a few minutes (~50MB)...');

// Download file with redirect handling
function downloadFile(url, dest, callback) {
    const file = fs.createWriteStream(dest);

    https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            console.log('[FFmpeg Downloader] Following redirect...');
            file.close();
            fs.unlinkSync(dest);
            downloadFile(redirectUrl, dest, callback);
            return;
        }

        if (response.statusCode !== 200) {
            file.close();
            console.error('[FFmpeg Downloader] ❌ Download failed with status:', response.statusCode);
            process.exit(1);
            return;
        }

        response.pipe(file);

        file.on('finish', () => {
            file.close(() => {
                const fileSize = fs.statSync(downloadPath).size;
                console.log('[FFmpeg Downloader] Download complete, size:', fileSize, 'bytes');

                // Validate file size (should be at least 1MB for FFmpeg)
                if (fileSize < 1000000) {
                    console.error('[FFmpeg Downloader] ❌ Downloaded file is too small - likely an error page');
                    console.error('[FFmpeg Downloader] URL:', url);
                    fs.unlinkSync(downloadPath);
                    process.exit(1);
                }

                callback();
            });
        });

        file.on('error', (err) => {
            fs.unlinkSync(dest);
            console.error('[FFmpeg Downloader] ❌ File write error:', err.message);
            process.exit(1);
        });
    }).on('error', (err) => {
        fs.unlinkSync(dest);
        console.error('[FFmpeg Downloader] ❌ Download failed:', err.message);
        process.exit(1);
    });
}

downloadFile(config.url, downloadPath, extractFFmpeg);

function extractFFmpeg() {
    console.log('[FFmpeg Downloader] Extracting...');

    try {
        if (platform === 'win32') {
            extractWindows();
        } else if (platform === 'darwin') {
            extractMacOS();
        } else if (platform === 'linux') {
            extractLinux();
        }
    } catch (err) {
        console.error('[FFmpeg Downloader] ❌ Extraction failed:', err.message);
        console.error('[FFmpeg Downloader] Archive path:', downloadPath);
        console.error('[FFmpeg Downloader] Expected output:', targetPath);
        process.exit(1);
    }
}

function extractWindows() {
    // Use PowerShell Expand-Archive (built into Windows)
    console.log('[FFmpeg Downloader] Extracting with PowerShell...');

    const extractDir = path.join(binDir, 'ffmpeg-extract');

    try {
        // Extract using PowerShell
        execSync(`powershell -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });

        // Find extracted ffmpeg directory
        const files = fs.readdirSync(extractDir);
        const ffmpegDir = files.find(f => f.startsWith('ffmpeg-master') && f.includes('win64'));

        if (ffmpegDir) {
            const extractedPath = path.join(extractDir, ffmpegDir, 'bin', 'ffmpeg.exe');
            if (fs.existsSync(extractedPath)) {
                fs.copyFileSync(extractedPath, targetPath);
                console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);

                // Cleanup extracted directory
                fs.rmSync(extractDir, { recursive: true, force: true });
                cleanup();
            } else {
                throw new Error(`FFmpeg not found at ${extractedPath}`);
            }
        } else {
            // List what we found
            console.error('[FFmpeg Downloader] Contents of extract dir:', files);
            throw new Error('Could not find extracted ffmpeg directory');
        }
    } catch (e) {
        console.error('[FFmpeg Downloader] ❌ Extraction failed:', e.message);
        console.error('[FFmpeg Downloader] Trying with 7z as fallback...');
        extractWindowsWith7z();
    }
}

function extractWindowsWith7z() {
    // Fallback to 7z if PowerShell fails
    const sevenZipPaths = [
        '7z',
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\ProgramData\\chocolatey\\bin\\7z.exe',
        'C:\\tools\\7z\\7z.exe'
    ];

    let sevenZip = null;
    for (const szPath of sevenZipPaths) {
        try {
            execSync(`"${szPath}" -h`, { stdio: 'ignore' });
            sevenZip = szPath;
            console.log('[FFmpeg Downloader] Found 7z at:', sevenZip);
            break;
        } catch (e) {
            // Try next
        }
    }

    if (!sevenZip) {
        console.error('[FFmpeg Downloader] ❌ Neither PowerShell nor 7z worked');
        console.error('[FFmpeg Downloader] Please extract manually:');
        console.error(`  1. Extract ${downloadPath}`);
        console.error(`  2. Copy ffmpeg.exe to ${targetPath}`);
        process.exit(1);
    }

    const extractDir = path.join(binDir, 'ffmpeg-extract');
    execSync(`"${sevenZip}" x "${downloadPath}" -o"${extractDir}" -y`, { stdio: 'inherit' });

    const files = fs.readdirSync(extractDir);
    const ffmpegDir = files.find(f => f.startsWith('ffmpeg-master') && f.includes('win64'));

    if (ffmpegDir) {
        const extractedPath = path.join(extractDir, ffmpegDir, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(extractedPath)) {
            fs.copyFileSync(extractedPath, targetPath);
            console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);
            fs.rmSync(extractDir, { recursive: true, force: true });
            cleanup();
        } else {
            throw new Error(`FFmpeg not found at ${extractedPath}`);
        }
    } else {
        throw new Error('Could not find extracted ffmpeg directory');
    }
}

function extractMacOS() {
    // macOS now copies from system - this function is not used
    // Kept for backwards compatibility if needed in future
    throw new Error('macOS now uses system FFmpeg - this function should not be called');
}

function extractLinux() {
    execSync(`tar -xf "${downloadPath}" -C "${binDir}"`, { stdio: 'inherit' });

    // Find ffmpeg in extracted directory
    const files = fs.readdirSync(binDir);
    const extractedDir = files.find(f => f.startsWith('ffmpeg-') && f.includes('-amd64-static'));

    if (extractedDir) {
        const extractedPath = path.join(binDir, extractedDir, 'ffmpeg');
        if (fs.existsSync(extractedPath)) {
            fs.renameSync(extractedPath, targetPath);
            fs.chmodSync(targetPath, 0o755);
            console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);

            // Cleanup extracted directory
            fs.rmSync(path.join(binDir, extractedDir), { recursive: true, force: true });
            cleanup();
        } else {
            throw new Error(`FFmpeg not found in ${extractedDir}`);
        }
    } else {
        throw new Error('Could not find extracted ffmpeg directory');
    }
}

function cleanup() {
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
