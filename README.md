# ynoTV 📺

[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-AGPL%20v3-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue)]()

A modern, feature-rich FOSS IPTV player built with **Tauri v2** and **React**, delivering a premium viewing experience with an elegant interface. This was made with the help of AI.


<div align="center">
<img width="1920" height="1080" alt="93h5U9C" src="https://github.com/user-attachments/assets/f39774fa-eef2-4249-a84f-dbf69d77c755" />

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

### 📅 TV Calendar
- **Show Tracking** — Search and track your favorite TV shows from TVMaze's comprehensive database
- **Episode Calendar** — View upcoming episodes on a monthly calendar with show posters and episode details
- **Smart Sync** — Automatic daily sync keeps episode data fresh with manual sync option
- **Channel Assignment** — Link shows to your IPTV channels for one-click watching
- **Auto-Add to Watchlist** — Future episodes automatically added to your watchlist with custom reminder and auto-switch settings
- **Episode Details** — Click any episode to see full details including summary, air time (timezone-aware), and season/episode info
- **Show Management** — Organize tracked shows by status, channel, or recently synced

### 🖼️ Multiview
- **Flexible Layouts** — Picture-in-picture mode or up to 4 simultaneous streams
- **Quick Swap** — Easily exchange feeds between main and secondary windows
- **Independent Audio** — Control volume and mute for each channel individually

### 🎨 Personalization
- **40+ Built-in Themes** — Dark, light, glassmorphism, gradients, and vibrant neon options for every taste
- **Import/Export** — Backup and restore all your settings with ease

---

## 🎮 Keyboard Shortcuts

<p align="center">
  <em>All shortcuts are fully customizable in Settings → Shortcuts</em>
</p>

### 🎬 Playback Controls
| Action | Default | Description |
|--------|---------|-------------|
| Play / Pause | `Space` | Toggle playback state |
| Mute / Unmute | `M` | Toggle audio mute |
| Seek Forward | `→` | Seek forward in current stream |
| Seek Backward | `←` | Seek backward in current stream |
| Toggle Fullscreen | `F` | Enter or exit fullscreen mode |

### 🧭 Navigation
| Action | Default | Description |
|--------|---------|-------------|
| Channel Up | `↑` | Switch to previous channel |
| Channel Down | `↓` | Switch to next channel |

### 🖥️ Interface Views
| Action | Default | Description |
|--------|---------|-------------|
| Toggle Live TV | `L` | Open/Close Live TV view (Guide + Categories) |
| Toggle Guide | `G` | Show/Hide the EPG guide panel |
| Toggle Categories | `C` | Show/Hide the categories sidebar |
| Toggle TV Calendar | `T` | Open/Close the TV Calendar for tracked shows |
| Toggle DVR | `R` | Open/Close DVR view for recordings |
| Toggle Sports | `U` | Open/Close Sports Hub with live scores |
| Toggle Settings | `,` | Open/Close Settings panel |
| Toggle Stats | `I` | Show/Hide playback statistics overlay |
| Focus Search | `S` | Focus the search input in the title bar |
| Close / Back | `Esc` | Close current view or go back |

### 🎨 Layout Modes
| Action | Default | Description |
|--------|---------|-------------|
| Main View | `1` | Single main channel view |
| Picture in Picture | `2` | Main channel with small secondary window |
| Big + Bottom Bar | `3` | Large main view with horizontal channel bar |
| 2×2 Grid | `4` | Four channel multiview grid |

### 🔊 Audio & Subtitles
| Action | Default | Description |
|--------|---------|-------------|
| Audio Track Menu | `A` | Open audio track selection modal |
| Subtitle Menu | `J` | Open subtitle track selection modal |
| Cycle Audio Track | `A` | Legacy: cycle through audio tracks directly |
| Cycle Subtitle | `J` | Legacy: cycle through subtitle tracks directly |

---

<details>
<summary>## 🛠️ Building from Source</summary>

### Prerequisites

- **Node.js**: 20.x or higher
- **pnpm**: 10.x or higher (`npm install -g pnpm`)
- **Rust**: Latest stable (for Tauri backend)
- **Git**: For cloning

**Platform-specific requirements:**

**Windows:**
- Visual Studio 2022 with C++ build tools
- Windows 10 SDK
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


</details>

---

<details>
<summary>## 📁 Data Location</summary>

### Configuration & Settings

**Windows:**
```
%APPDATA%\com.ynotv.app\
├── settings.json          # Sources, shortcuts, preferences
└── .windows-state.json    # Window state
```


### Database (SQLite)

**Location:** `app.db`

**Windows:**
```
%LOCALAPPDATA%\com.ynotv.app\app.db
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

### DVR Recordings

Default: Configurable in Settings → DVR

**Windows:**
```
%USERPROFILE%\Videos\ynoTV Recordings\
```
</details>

---

## ⚠️ Disclaimer


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
- **[TVMaze](https://www.tvmaze.com)** - TV schedule and show metadata
  
---

## 📄 License

[GNU Affero General Public License v3.0](LICENSE)

---

<div align="center">

Made with ❤️ for IPTV enthusiasts

**[⭐ Star this repo](https://github.com/tbeezy/ynotv)** if you find it useful!

</div>