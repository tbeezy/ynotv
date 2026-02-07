# 🎬 ynoTV

> A desktop IPTV player built with Electron and mpv

A personal fork of [sbtlTV](https://github.com/thesubtleties/sbtlTV) with added features I wanted in an IPTV player for my personal use.

<div align="center">![ynoTV Screenshot] (assets/ss1.png)</div>
---

## ✨ Added Features in ynoTV

**ynoTV** extends sbtlTV with powerful new capabilities built for IPTV enthusiasts:

- **MAC Stalker Support** - Full support for MAC-based Stalker portals
- **Intelligent Subcategories** - Each source maintains its own main category instead of mixing all channels together
- **Favorites System** - Quickly access your most-watched channels
- **Custom User Agent** - Set custom user agents per source
- **Stream Stats** - View detailed stream information and diagnostics
- **Advanced Playback Control** - Swap subtitles and audio tracks on the fly
- **Playlist Management** - Enable/disable individual playlists seamlessly
- **Single Provider Resync** - Update specific sources without full refresh
- **Expiration Tracking** - Displays expiration dates for Stalker and Xtream sources
- **Connection Monitoring** - Shows current and maximum connections for Xtream portals
- **Category Manager** - Organize and reorder Live TV categories, hide unwanted ones
- **Quick Provider Switching** - Swap username, password, and MAC address for rapid switching between accounts
- **EPG Enhancements** - EPG Shift Offset for timezone adjustments
- **Traditional EPG View** - Browse like classic IPTV players with single-click preview and double-click fullscreen
- **Customizable Shortcuts** - Configure keybinds to your preferences
- **Smart Title Scrolling** - Highlighting a channel displays and scrolls the full name
- **Import/Export Configuration** - Backup and transfer your Sources, Shortcuts, Favorites, and Managed Categories
- **Better Error Reporting** - Shows HTTP error codes when streams fail instead of blank screens

### Known Issues

- Stalker portal Serie fetching is currently broken
- Some Stalker portals may not work correctly

---

## 🚀 Features

- **Live TV with EPG** - Browse channels by category with a full program guide
- **Movies & Series** - Browse your VOD library with poster art and metadata
- **TMDB Integration** - Suggested, popular, and genre-based browsing for movies and series
- **Poster Overlays** - Optional rating badges on posters via RPDB
- **Multi-source Support** - Connect via Xtream Codes API or M3U playlists
- **EPG from Multiple Sources** - Fetch guide data from your provider or external URLs
- **Channel Ordering** - Sort channels by provider numbers or alphabetically
- **Offline Storage** - Channels, EPG, and catalog cached locally for fast browsing

---

## 📥 Installation

Download the latest release from the [Releases](../../releases) page:

| Platform | Notes |
|----------|-------|
| **Windows** | mpv included |
| **Linux** | Requires mpv installed separately |
| **macOS** | Requires mpv installed via Homebrew |

### Windows Users

Windows SmartScreen may block the app on first run. Click **More info** → **Run anyway** to proceed.

### macOS Users

mpv must be installed via Homebrew:

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install mpv
brew install mpv
```

On first run, macOS may block the app. Remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/ynoTV.app
```

### Linux Users

mpv must be installed separately:

```bash
# Ubuntu/Debian
sudo apt install mpv

# Fedora
sudo dnf install mpv

# Arch
sudo pacman -S mpv
```

---

## 🔨 Building from Source

### Prerequisites

- Node.js 20+
- pnpm 10+
- mpv installed

### Development

```bash
pnpm install
pnpm build
pnpm dev
```

### Building Distributables

```bash
# Download mpv for bundling (Windows)
bash scripts/download-mpv.sh

# Build for current platform
pnpm dist

# Platform-specific
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

---

## ⚙️ Configuration

### Adding a Source

1. Open Settings (gear icon)
2. Go to Sources tab
3. Add your Xtream Codes credentials (server URL, username, password) or Stalker MAC credentials
4. Click Sync to fetch channels and content

### TMDB Integration

Movie and series metadata comes from [The Movie Database](https://www.themoviedb.org/). Basic matching works automatically.

For genre browsing and suggested/popular lists, add a TMDB Access Token:

1. Create an account at [themoviedb.org](https://www.themoviedb.org/signup)
2. Get an API Read Access Token from [API settings](https://www.themoviedb.org/settings/api)
3. Add it in Settings → TMDB

*This product uses the TMDB API but is not endorsed or certified by TMDB.*

### Poster Overlays (RPDB)

Add rating badges to posters with an [RPDB](https://ratingposterdb.com/) API key in Settings → Poster DB.

### Debug Logging

Enable logging in Settings → Debug for troubleshooting. Logs are saved to your app data folder with automatic rotation.

### Data Location

- **Windows**: `%APPDATA%/ynoTV`
- **macOS**: `~/Library/Application Support/ynoTV`
- **Linux**: `~/.config/ynoTV`

---

## ⚠️ Disclaimer

This application is a media player only and does not provide any content. Users must provide their own IPTV service credentials from a legitimate provider. The developers are not responsible for how this software is used or for any content accessed through it.

---

## 🙏 Credits

**ynoTV** builds upon the excellent work of:

- [sbtlTV](https://github.com/thesubtleties/sbtlTV) - The foundation for this project
- [IPTV-MAC-STALKER-PLAYER-BY-MY-1](https://github.com/Cyogenus/IPTV-MAC-STALKER-PLAYER-BY-MY-1) - Stalker implementation

Video playback powered by [mpv](https://mpv.io/).

---

## 📄 License

[GNU Affero General Public License v3.0](LICENSE)

---

<div align="center">

Made with ❤️ for IPTV enthusiasts

</div>
