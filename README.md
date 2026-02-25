# ynoTV

[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-AGPL%20v3-green.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue)](./README.md)
[![Chat Server](https://img.shields.io/badge/chat-discord-7289da.svg)](https://discord.gg/e5eGa5QETB)

A feature-rich, open source IPTV player for Windows built on [Tauri v2](https://tauri.app) and [mpv](https://mpv.io). Was made for my personal use with features I wanted.
Built with the help of AI.

[Documentation](https://tbeezy.github.io/ynotvdoc)

[![Watch the video](https://i.imgur.com/mmkM4mX.png)](https://streamable.com/jxjq9n)

[Video Demonstration](https://streamable.com/jxjq9n)

---

## Table of Contents

- [Features](#features)
- [Building from Source](#building-from-source)
- [Data & File Locations](#data--file-locations)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Disclaimer](#disclaimer)
- [Credits](#credits)
- [License](#license)

---

## Features

### Playlist Management

ynoTV supports M3U/M3U8 playlists, Xtream Codes API, and Stalker Portal integration out of the box. Each source can be configured with its own user agent for maximum compatibility, and backup MAC addresses or credentials can be attached to any provider with one-click switching between them.

The source overview displays channel, movie, and series counts per playlist at a glance, alongside real-time connection monitoring showing active/max connections and expiration dates. Playlists and categories can be enabled, disabled, and reordered freely.

Built-in EPG support allows a separate EPG source to be configured independently of your playlist provider.

### Playback

Video playback is powered by mpv, providing broad format compatibility and hardware acceleration. The interface supports single-click to watch and double-click for fullscreen, with one-click favorites and the ability to create custom channel groups.

### Search

Channel and EPG program search is backed by SQLite for fast, responsive results across large playlists.

### Watchlist and Reminders

Programs can be added to a watchlist directly from the EPG guide. Popup reminders fire at a configurable lead time before a program begins, with an option to automatically switch to the channel when the program starts.

### DVR Recording

Recordings can be started instantly on the currently playing channel, scheduled for a specific time on any channel, or set directly from the EPG guide. All recordings are available for in-app playback without leaving the application.

### Sports Hub

Live scoreboards display real-time scores for major sports leagues with detailed game information. Each match shows the associated channel source, with a direct search to find and tune to it immediately.

### TV Calendar

Shows are tracked through the [TVMaze](https://www.tvmaze.com) database. Upcoming episodes appear on a monthly calendar with show posters and episode details, automatically synced daily. Shows can be linked to an IPTV channel for one-click watching, and future episodes can be automatically added to the watchlist with configurable reminder and auto-switch settings.

### Multiview

ynoTV supports picture-in-picture mode and up to four simultaneous streams in a 2x2 grid. Each stream has independent volume and mute controls, and feeds can be swapped between windows at any time.

### Themes and Personalization

Over 40 built-in themes are included, spanning dark, light, glassmorphism, gradient, and neon styles. All settings, including keyboard shortcuts, can be exported and restored via a backup file.

### Known Bugs

Currently dragging the window with multiview on will cause video to bug, press any hotkey to fix

---

<details>
<summary>## Building from Source</summary>

### Prerequisites

- Node.js 20.x or higher
- pnpm 10.x or higher — install with `npm install -g pnpm`
- Rust (latest stable) — required for the Tauri backend
- Git

**Windows additional requirements:**
- Visual Studio 2022 with C++ build tools
- Windows 10 SDK

### Instructions

**1. Clone the repository**

```bash
git clone https://github.com/tbeezy/ynotv.git
cd ynotv
```

**2. Install dependencies**

```bash
pnpm install
```

**3. Download mpv and FFmpeg sidecars**

```bash
# Download mpv binaries
bash scripts/download-mpv-tauri.sh

# Download FFmpeg binaries
cd packages/app
node scripts/download-ffmpeg.js
cd ../..
```

**4. Run in development mode**

```bash
pnpm tauri dev
```

**5. Build for production**

```bash
pnpm tauri build
```

Build output is located at:

```
packages/app/src-tauri/target/release/bundle/
```

</details>

---

<details>
<summary>## Data & File Locations</summary>

### Configuration

```
%APPDATA%\com.ynotv.app\
├── settings.json          # Sources, shortcuts, and preferences
└── .windows-state.json    # Window size and position
```

### Database (SQLite)

```
%LOCALAPPDATA%\com.ynotv.app\app.db
```

The database stores channels, categories, EPG programs (7-day window), VOD movies and series, watchlist entries, reminders, DVR schedules and recordings, channel metadata, and source sync timestamps.

### Logs

Debug logging can be enabled in Settings > Debug. Log output is written to:

```
%APPDATA%\com.ynotv.app\logs\app.log
```

### DVR Recordings

The recording directory is configurable in Settings > DVR. The default location is:

```
%USERPROFILE%\Videos\ynoTV Recordings\
```

</details>

---

## Keyboard Shortcuts

All shortcuts are fully customizable in Settings > Shortcuts.

### Playback

| Action | Default |
|---|---|
| Play / Pause | `Space` |
| Mute / Unmute | `M` |
| Seek Forward | `Right Arrow` |
| Seek Backward | `Left Arrow` |
| Toggle Fullscreen | `F` |

### Navigation

| Action | Default |
|---|---|
| Channel Up | `Up Arrow` |
| Channel Down | `Down Arrow` |

### Interface

| Action | Default |
|---|---|
| Toggle Live TV | `L` |
| Toggle EPG Guide | `G` |
| Toggle Categories | `C` |
| Toggle TV Calendar | `T` |
| Toggle DVR | `R` |
| Toggle Sports Hub | `U` |
| Toggle Settings | `,` |
| Toggle Playback Stats | `I` |
| Focus Search | `S` |
| Close / Back | `Esc` |

### Layout Modes

| Layout | Default |
|---|---|
| Single main view | `1` |
| Picture-in-picture | `2` |
| Main + bottom bar | `3` |
| 2x2 grid multiview | `4` |

### Audio and Subtitles

| Action | Default |
|---|---|
| Audio track selection | `A` |
| Subtitle track selection | `J` |

---

## Disclaimer

ynoTV is a media player only. It does not provide, host, distribute, or facilitate access to any streaming services, broadcast content, channel lists, or IPTV subscriptions of any kind.

All content, streams, and playlists are sourced, configured, and managed solely by the end user. The developers have no knowledge of, control over, or responsibility for any third-party content accessed through the application.

Users are solely responsible for ensuring that any content they access complies with the laws and regulations applicable in their jurisdiction. The developers do not condone or support the use of this application to access unlicensed or unauthorized content.

Metadata displayed within the application is sourced from publicly available third-party databases including TVMaze and TMDB. ynoTV does not claim ownership of this metadata.

---

## Credits

ynoTV builds on the following open source projects and services:

- [sbtlTV](https://github.com/thesubtleties/sbtlTV) — original foundation
- [Tauri](https://tauri.app) — desktop application framework
- [mpv](https://mpv.io) — video playback engine
- [FFmpeg](https://ffmpeg.org) — recording and thumbnail generation
- [React](https://react.dev) — UI library
- [TVMaze](https://www.tvmaze.com) — TV schedule and show metadata
- [TMDB](https://www.themoviedb.org) — movie and series metadata

---

## License

[GNU Affero General Public License v3.0](./LICENSE)
