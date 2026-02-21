# ynoTV 📺

[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-AGPL%20v3-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()

A modern, feature-rich FOSS IPTV player built with **Tauri v2** and **React**, delivering a premium viewing experience with an elegant interface. This was made with the help of AI.


<div align="center">
<img width="100%" alt="ynoTV Interface" src="https://github.com/user-attachments/assets/bfaed9ac-86d7-4394-b0cb-22ac7d6d059e" />
</div>

---

## ✨ Features

### 📡 Playlist Management
- **Multi-format Support** — M3U/M3U8 playlists, Xtream Codes API, and Stalker Portal integration
- **EPG Integration** — Built-in EPG support with separate EPG source configuration
- **Backup Credentials** — Add backup MAC addresses or credentials to any provider with one-click switching
- **Custom User Agents** — Per-source user agent configuration for maximum compatibility
- **Source Overview** — View channel, movie, and series counts for each playlist at a glance
- **Connection Monitoring** — Real-time active/max connection status and expiration dates
- **Playlist Control** — Enable, disable, and reorder playlists with ease
- **Category Management** — Enable/disable categories and reorganize your channel list

### 📺 User Interface
- **Full EPG Guide** — Comprehensive electronic program guide with integrated video preview
- **Intuitive Navigation** — Single click to watch, double-click for fullscreen
- **Quick Favorites** — One-click to add any channel to your favorites
- **Custom Groups** — Create personalized channel groups for quick access

### 🔍 Search
- **Lightning Fast** — SQLite-powered search for instant results
- **Comprehensive** — Search across channel names and EPG program data

### ⏰ Watchlist & Reminders
- **EPG Watchlist** — Add any program to your watchlist directly from the guide
- **Smart Notifications** — Popup reminders with customizable timing and auto-tune options
- **Auto Channel Swap** — Can set to automatically switch to the channel when your watchlist program begins

### ⏺️ DVR Recording
- **Quick Record** — One-click recording on the currently playing channel
- **Scheduled Recordings** — Set recordings at specific times for a channel without EPG
- **EPG Recording** — Record programs directly from the guide
- **In-App Playback** — Watch all your recordings without leaving the app

### 🏈 Sports Hub
- **Live Scoreboards** — Real-time scores for major sports leagues with detailed game information
- **Channel Integration** — View the channel source for each match and instantly search for it

### 🖼️ Multiview
- **Flexible Layouts** — Picture-in-picture mode or up to 4 simultaneous streams
- **Quick Swap** — Easily exchange feeds between main and secondary windows
- **Independent Audio** — Control volume and mute for each channel individually

### 🎨 Personalization
- **40+ Built-in Themes** — Dark, light, glassmorphism, gradients, and vibrant neon options for every taste
- **Import/Export** — Backup and restore all your settings with ease

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

Disclaimer
This application is a media player only. It does not provide, host, distribute, or facilitate access to any streaming services, broadcast content, channel lists, or IPTV subscriptions of any kind.
All content, streams, and playlists are sourced, configured, and managed solely by the end user. The developers of this application have no knowledge of, control over, or responsibility for any third-party content accessed through the application.
It is the sole responsibility of the user to ensure that any content they choose to access complies with the laws and regulations applicable in their jurisdiction. The developers do not condone, encourage, or support the use of this application to access unlicensed, unauthorized, or otherwise illegal content.
By using this application, you acknowledge and agree that the developers bear no liability for how the application is used.

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
