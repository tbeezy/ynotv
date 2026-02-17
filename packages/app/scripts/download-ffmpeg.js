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
        url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z',
        fileName: 'ffmpeg-essentials.7z',
        extractPath: 'ffmpeg-7.0.2-essentials_build/bin/ffmpeg.exe',
        outputName: 'ffmpeg.exe'
    },
    darwin: {
        url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/link',
        fileName: 'ffmpeg.zip',
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

const downloadPath = path.join(binDir, config.fileName);

console.log('[FFmpeg Downloader] Downloading from:', config.url);
console.log('[FFmpeg Downloader] This may take a few minutes (~50MB)...');

// Download file
const file = fs.createWriteStream(downloadPath);
https.get(config.url, (response) => {
    // Handle redirects
    if (response.statusCode === 301 || response.statusCode === 302) {
        console.log('[FFmpeg Downloader] Following redirect to:', response.headers.location);
        https.get(response.headers.location, (redirectResponse) => {
            redirectResponse.pipe(file);
            file.on('finish', () => {
                file.close();
                console.log('[FFmpeg Downloader] Download complete, size:', fs.statSync(downloadPath).size, 'bytes');
                extractFFmpeg();
            });
        }).on('error', (err) => {
            console.error('[FFmpeg Downloader] ❌ Redirect download failed:', err.message);
            process.exit(1);
        });
    } else {
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log('[FFmpeg Downloader] Download complete, size:', fs.statSync(downloadPath).size, 'bytes');
            extractFFmpeg();
        });
    }
}).on('error', (err) => {
    fs.unlinkSync(downloadPath);
    console.error('[FFmpeg Downloader] ❌ Download failed:', err.message);
    process.exit(1);
});

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
    // Try to find 7z in common locations
    const sevenZipPaths = [
        '7z',  // In PATH
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
        console.error('[FFmpeg Downloader] ❌ 7z not found. Tried:', sevenZipPaths);
        console.error('[FFmpeg Downloader] Please install 7-Zip or extract manually:');
        console.error(`  1. Extract ${downloadPath}`);
        console.error(`  2. Copy ffmpeg.exe to ${targetPath}`);
        process.exit(1);
    }

    // Extract
    execSync(`"${sevenZip}" x "${downloadPath}" -o"${binDir}" -y`, { stdio: 'inherit' });

    // Find extracted ffmpeg directory (version may vary)
    const files = fs.readdirSync(binDir);
    const ffmpegDir = files.find(f => f.startsWith('ffmpeg-') && f.includes('-essentials_build'));

    if (ffmpegDir) {
        const extractedPath = path.join(binDir, ffmpegDir, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(extractedPath)) {
            fs.renameSync(extractedPath, targetPath);
            console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);

            // Cleanup extracted directory
            fs.rmSync(path.join(binDir, ffmpegDir), { recursive: true, force: true });
            cleanup();
        } else {
            throw new Error(`FFmpeg not found at ${extractedPath}`);
        }
    } else {
        throw new Error('Could not find extracted ffmpeg directory');
    }
}

function extractMacOS() {
    // macOS has unzip built-in
    execSync(`unzip -o "${downloadPath}" -d "${binDir}"`, { stdio: 'inherit' });

    const extractedPath = path.join(binDir, config.extractPath);
    if (fs.existsSync(extractedPath)) {
        fs.renameSync(extractedPath, targetPath);
        fs.chmodSync(targetPath, 0o755);
        console.log('[FFmpeg Downloader] ✓ FFmpeg extracted to:', targetPath);
        cleanup();
    } else {
        throw new Error(`FFmpeg not found at ${extractedPath}`);
    }
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
