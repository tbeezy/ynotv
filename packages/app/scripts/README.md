# FFmpeg Auto-Download for DVR

## How It Works

The app now automatically downloads FFmpeg during the build process:

1. **Before each build**, the script `packages/app/scripts/download-ffmpeg.js` runs
2. **Detects your platform** (Windows/Mac/Linux)
3. **Downloads FFmpeg** from official sources (~50MB)
4. **Extracts** the binary to `packages/app/src-tauri/bin/`
5. **Tauri bundles** it with your installer

## For Developers

### First Build
```bash
# The prebuild script will automatically download FFmpeg
pnpm run build
```

### Manual Download (if needed)
```bash
cd packages/app
node scripts/download-ffmpeg.js
```

### Skip Download (if already exists)
The script checks if FFmpeg already exists and skips download if found.

## For CI/CD

GitHub Actions and other CI systems will automatically download FFmpeg during the build process. No manual setup required!

## Download Sources

- **Windows**: https://www.gyan.dev/ffmpeg/builds/ (gyan.dev essentials build)
- **Mac**: https://evermeet.cx/ffmpeg/ (evermeet static builds)
- **Linux**: https://johnvansickle.com/ffmpeg/ (static builds)

## Requirements

### Windows
- **7-Zip** is required for extraction. Install via:
  ```powershell
  choco install 7zip
  ```
  Or download from: https://www.7-zip.org/

### Mac/Linux
- Built-in `tar` or `7z` command

## Troubleshooting

### "7z not found" error (Windows)
Install 7-Zip:
```powershell
choco install 7zip
```

### Manual extraction
If automatic extraction fails:
1. The downloaded archive will be in `packages/app/src-tauri/bin/`
2. Extract it manually
3. Copy `ffmpeg.exe` (or `ffmpeg` on Mac/Linux) to `packages/app/src-tauri/bin/`

### Update FFmpeg version
Edit `packages/app/scripts/download-ffmpeg.js` and change the `FFMPEG_VERSION` constant.
