# ynoTV 📺

[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-AGPL%20v3-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()

A modern, cross-platform IPTV player built with **Tauri v2** and **React**. Features stunning glassmorphism UI, DVR recording, comprehensive EPG guide, VOD support, TMDB integration, and watchlist management.


<div align="center">
<img width="100%" alt="ynoTV Interface" src="https://github.com/user-attachments/assets/bfaed9ac-86d7-4394-b0cb-22ac7d6d059e" />
</div>

---

## ✨ What Makes ynoTV Special

### 🎨 Visual Excellence
- **40+ Beautiful Themes**: Dark, light, glassmorphism, solid gradients, and vibrant neon themes
- **Miami Vice, Neon Collection**: Hot pink, electric blue, lime, and more neon accent themes
- **Glassmorphism UI**: Frosted glass effects with blur, transparency, and depth
- **Customizable Interface**: Font sizes, sidebar visibility, channel sorting

### 📡 Advanced IPTV Support
- **Multiple Source Types**: Xtream Codes API, Stalker Portal, M3U/M3U8 playlists
- **MAC Stalker Support**: Full support for MAC-based Stalker portals with backup MACs
- **Smart Subcategories**: Each source maintains its own main category structure
- **Custom User Agents**: Per-source user agent configuration for compatibility
- **Expiration Tracking**: Displays expiration dates for Stalker and Xtream sources
- **Connection Monitoring**: Shows current/max connections for Xtream portals

### 📺 Live TV & EPG
- **Traditional EPG View**: Browse like classic IPTV players
- **Time Shifting**: Configurable EPG timezone offsets per source
- **Single-Click Preview**: Quick preview with double-click fullscreen
- **Smart Title Scrolling**: Channel names scroll when highlighted
- **Category Management**: Reorder, hide/show, and organize categories
- **Favorites System**: Quick access to most-watched channels
- **Channel Ordering**: Sort by provider numbers or alphabetically

### 🎥 Video & Playback
- **mpv Integration**: Powerful, hardware-accelerated video playback
- **Stream Stats**: Detailed stream information and diagnostics
- **Audio/Subtitle Tracks**: Easy track switching on the fly
- **Fallback Streams**: Automatic fallback when primary stream fails
- **HTTP Error Reporting**: Shows error codes instead of blank screens

### 📼 DVR (Digital Video Recording)
- **Schedule Recordings**: Record live TV programs
- **Series Recording**: Auto-record by title pattern
- **Storage Management**: Configurable storage location
- **Recording Library**: Browse and manage recorded content
- **Thumbnail Previews**: Automatic thumbnail generation for recordings

### 🎬 Watchlist & VOD
- **TMDB Integration**: Enhanced metadata, posters, backdrops
- **Watchlist Management**: Track movies and series you want to watch
- **Genre Browsing**: Discover movies and series by genre
- **Poster Overlays**: Rating badges via RPDB integration
- **Recently Added**: Track new VOD content

### ⚡ Power User Features
- **Customizable Shortcuts**: Fully configurable keyboard hotkeys
- **Import/Export**: Backup and restore settings, sources, favorites
- **Debug Logging**: Comprehensive logs for troubleshooting
- **Single Provider Resync**: Update specific sources without full refresh
- **Quick Provider Switching**: Swap credentials for rapid account changes

---

## 📥 Installation

### Download Pre-built Binaries

Get the latest release from the [Releases](../../releases) page.

| Platform | Download | Notes |
|----------|----------|-------|
| **Windows** | `.exe` (Installer & Portable) | mpv & FFmpeg included |
| **macOS** | `.dmg` | Requires mpv via Homebrew |
| **Linux** | `.AppImage` / `.deb` / `.rpm` | Requires mpv installed |

### Windows

**Using Installer:**
1. Download `ynoTV-setup.exe`
2. Run the installer (Windows SmartScreen may warn - click "More info" → "Run anyway")
3. Launch from Start Menu or Desktop

**Portable Version:**
1. Download `ynoTV-portable.exe`
2. Extract to any folder
3. Run `ynoTV.exe` - no installation needed!

### macOS

**Prerequisites:**
```bash
# Install mpv and FFmpeg via Homebrew
brew install mpv ffmpeg
```

**Installation:**
1. Download `ynoTV.dmg`
2. Mount the DMG and drag ynoTV to Applications
3. Remove quarantine flag:
```bash
xattr -dr com.apple.quarantine /Applications/ynoTV.app
```

### Linux

**Install mpv and FFmpeg:**
```bash
# Ubuntu/Debian
sudo apt install mpv ffmpeg

# Fedora
sudo dnf install mpv ffmpeg

# Arch Linux
sudo pacman -S mpv ffmpeg
```

**AppImage (Recommended):**
```bash
chmod +x ynoTV.AppImage
./ynoTV.AppImage
```

**Ubuntu/Debian:**
```bash
sudo dpkg -i ynoTV_amd64.deb
sudo apt-get install -f
```

**Fedora/RHEL:**
```bash
sudo rpm -i ynoTV.x86_64.rpm
```

---

## 🛠️ Building from Source

### Prerequisites

- **Node.js**: 20.x or higher
- **pnpm**: 10.x or higher (`npm install -g pnpm`)
- **Rust**: Latest stable (for Tauri backend)
- **Git**: For cloning

**Platform-specific requirements:**

**Windows:**
- Visual Studio 2022 with C++ build tools
- Windows 10 SDK

**macOS:**
- Xcode Command Line Tools (`xcode-select --install`)
- mpv: `brew install mpv`
- FFmpeg: `brew install ffmpeg`

**Linux:**
```bash
# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf mpv ffmpeg

# Fedora
sudo dnf install gtk3-devel webkit2gtk4-devel libappindicator-gtk3-devel mpv ffmpeg

# Arch Linux
sudo pacman -S webkitgtk-4.1 libappindicator-gtk3 librsvg mpv ffmpeg
```

### Build Instructions

**1. Clone Repository:**
```bash
git clone https://github.com/yourusername/ynotv.git
cd ynotv
```

**2. Install Dependencies:**
```bash
pnpm install
```

**3. Setup Sidecars (mpv & FFmpeg binaries):**
```bash
# Download mpv for all platforms
bash scripts/download-mpv-tauri.sh

# Download FFmpeg for all platforms
cd packages/app
node scripts/download-ffmpeg.js
cd ../..
```

**4. Development Mode:**
```bash
# Start development server with hot reload
pnpm dev
# or
pnpm tauri dev
```

**5. Build for Production:**
```bash
pnpm tauri build
```

**Output location:**
```
packages/app/src-tauri/target/release/bundle/
```

### Platform-specific Builds

```bash
# Windows (x64)
pnpm tauri build --target x86_64-pc-windows-msvc

# macOS (Apple Silicon)
pnpm tauri build --target aarch64-apple-darwin

# macOS (Intel)
pnpm tauri build --target x86_64-apple-darwin

# Linux (x64)
pnpm tauri build --target x86_64-unknown-linux-gnu
```

### Development Tips

**Type Checking:**
```bash
cd packages/ui
pnpm run typecheck
```

**Code Linting:**
```bash
pnpm run lint
```

---

## 📁 Data Location

### Configuration & Settings

**Windows:**
```
%APPDATA%\com.ynotv.app\
├── settings.json          # Sources, shortcuts, preferences
└── .windows-state.json    # Window state
```

**macOS:**
```
~/Library/Application Support/com.ynotv.app/
├── settings.json
└── .window-state.json
```

**Linux:**
```
~/.config/com.ynotv.app/
├── settings.json
└── .window-state.json
```

### Database (SQLite)

**Location:** `app.db`

**Windows:**
```
%LOCALAPPDATA%\com.ynotv.app\app.db
```

**macOS:**
```
~/Library/Application Support/com.ynotv.app/app.db
```

**Linux:**
```
~/.local/share/com.ynotv.app/app.db
```

**Database contains:**
- Channels and categories
- EPG programs (7-day window)
- VOD movies and series
- Watchlist and reminders
- DVR schedules and recordings
- Channel metadata (resolution, fps, audio)
- Source sync timestamps

### Logs

**Enable Debug Logging:**
Settings → Debug → Enable debug logging

**Log Locations:**

**Windows:**
```
%APPDATA%\com.ynotv.app\logs\app.log
```

**macOS:**
```
~/Library/Logs/com.ynotv.app/app.log
```

**Linux:**
```
~/.local/share/com.ynotv.app/logs/app.log
```

### DVR Recordings

Default: Configurable in Settings → DVR

**Windows:**
```
%USERPROFILE%\Videos\ynoTV Recordings\
```

**macOS:**
```
~/Movies/ynoTV Recordings/
```

**Linux:**
```
~/Videos/ynoTV Recordings/
```

---

## 🎮 Keyboard Shortcuts

Fully customizable in Settings → Shortcuts

### Playback Controls
| Action | Default Shortcut |
|--------|-----------------|
| Play/Pause | `Space` |
| Mute/Unmute | `M` |
| Volume Up | `↑` |
| Volume Down | `↓` |
| Seek Forward | `→` |
| Seek Backward | `←` |
| Fullscreen | `F` |

### Navigation
| Action | Default Shortcut |
|--------|-----------------|
| Toggle Guide | `G` |
| Toggle Categories | `C` |
| Toggle Live TV | `L` |
| Toggle DVR | `D` |
| Toggle Watchlist | `W` |
| Toggle Settings | `,` |
| Focus Search | `/` |
| Close Window | `Esc` |

### Stream Controls
| Action | Default Shortcut |
|--------|-----------------|
| Cycle Audio Track | `A` |
| Cycle Subtitle Track | `S` |
| Toggle Stats | `I` |

---

## 🐛 Troubleshooting

### Video Not Playing

**Symptoms:** Black screen, loading spinner

**Solutions:**
1. Check stream URL validity (test in external player)
2. Verify source credentials in Settings → Sources
3. Try different User-Agent in source settings
4. Enable debug logging and check logs
5. Check if mpv is properly installed (macOS/Linux)

### EPG Not Showing

**Symptoms:** "No EPG Data" message

**Solutions:**
1. Verify EPG URL in source settings
2. Check that `epg_channel_id` matches provider's `tvg-id`
3. Force EPG sync from Settings → Sources → Sync
4. Adjust EPG timeshift hours for timezone
5. Check if EPG source is accessible

### Channels Not Loading

**Symptoms:** Empty channel list

**Solutions:**
1. Check network connectivity
2. Verify source is enabled
3. Test source connection in Settings → Sources
4. Check credentials (username/password/MAC)
5. Try manual sync with debug logging enabled

### Sync Failures

**Symptoms:** Sync hangs or fails

**Solutions:**
1. Check API rate limiting
2. Verify source credentials
3. Check for very large EPG files (>50MB)
4. Review debug logs for specific errors
5. Try syncing individual sources instead of all

### DVR Not Recording

**Symptoms:** Recordings fail to start

**Solutions:**
1. Verify FFmpeg is installed (macOS/Linux): `ffmpeg -version`
2. Check DVR storage location has free space
3. Enable debug logging to check FFmpeg path detection
4. On macOS/Linux, ensure FFmpeg is in PATH or bundled

### macOS: Video Separate Window

**Note:** This is a known limitation. macOS builds currently play video in a separate window due to Tauri platform constraints.

### Getting Help

1. **Enable Debug Logging:** Settings → Debug
2. **Check Logs:** See [Data Location](#-data-location) section
3. **Open Issue:** [GitHub Issues](../../issues)
4. **Provide:** Platform, version, logs, steps to reproduce


---

## ⚠️ Disclaimer

This application is a **media player only** and does not provide any content. Users must provide their own IPTV service credentials from legitimate providers. The developers are not responsible for how this software is used or for any content accessed through it.

This product uses the TMDB API but is not endorsed or certified by TMDB.

---

## 🙏 Credits

**ynoTV** builds upon excellent open-source projects:

- **[sbtlTV](https://github.com/thesubtleties/sbtlTV)** - Foundation
- **[Tauri](https://tauri.app)** - Desktop application framework
- **[mpv](https://mpv.io)** - Video playback engine
- **[FFmpeg](https://ffmpeg.org)** - Recording and thumbnail generation
- **[React](https://react.dev)** - UI library
- **[TMDB](https://www.themoviedb.org)** - Movie/series metadata

---

## 📄 License

[GNU Affero General Public License v3.0](LICENSE)

---

<div align="center">

Made with ❤️ for IPTV enthusiasts

**[⭐ Star this repo](https://github.com/tbeezy/ynotv)** if you find it useful!

</div>
