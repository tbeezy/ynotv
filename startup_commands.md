# Startup commands (dev environment)

Quick cheat sheet for coming back to ynoTV after a long break. Paths assume the repo is at `G:\GitHub\ynotv` — adjust if yours differs.

---

## One-time prerequisites (Windows)

Install these only if this machine does not already have them:

| Tool | Why | How |
|------|-----|-----|
| **Node.js 20+** | JS tooling | [nodejs.org](https://nodejs.org) |
| **pnpm 9.x** | Package manager (this repo uses pnpm, not npm) | `npm install -g pnpm` |
| **Rust (stable)** | Tauri / Cargo backend | `winget install Rustlang.Rustup` or [rustup.rs](https://rustup.rs) — then **open a new terminal** |
| **VS 2022 C++ tools + Windows SDK** | Compile the desktop shell | Visual Studio Installer → “Desktop development with C++” |
| **WebView2** | Tauri UI host | Usually already on Win10/11 |
| **Git** + **Git Bash** (or WSL) | Clone + run bash download scripts | Git for Windows |
| **7-Zip** | Needed by the mpv download script on Windows | [7-zip.org](https://www.7-zip.org/) |

Check versions after install:

```powershell
node -v
pnpm -v
cargo --version
rustc --version
```

---

## First setup on a machine (or after a fresh clone)

```powershell
cd G:\GitHub\ynotv
pnpm install
```

Download the **mpv** sidecar (and yt-dlp) — required for playback. From **Git Bash**:

```bash
cd /g/GitHub/ynotv
bash scripts/download-mpv-tauri.sh
```

Download **libmpv** (Windows DLL used by the app):

```powershell
cd G:\GitHub\ynotv
pnpm setup:libmpv
```

*(Optional)* Pre-download FFmpeg manually (also runs automatically on app `prebuild`):

```powershell
cd G:\GitHub\ynotv\packages\app
node scripts/download-ffmpeg.js
cd ..\..
```

---

## Everyday: start development

```powershell
cd G:\GitHub\ynotv
pnpm dev
```

This starts:

1. Vite UI on `http://localhost:5173`
2. The Tauri desktop window once Vite is up

Leave the terminal open while you work. Close the app window or press `Ctrl+C` to stop.

### Port stuck / zombie processes

```powershell
pnpm dev:clean
```

Or only kill leftovers:

```powershell
pnpm kill-port
```

---

## Useful checks

```powershell
# Typecheck + CSS audits (repo-wide)
pnpm typecheck

# UI package only
pnpm --filter @ynotv/ui typecheck

# local-adapter unit tests
pnpm --filter @ynotv/local-adapter test
```

---

## Where data lives (so you don’t panic)

| What | Path |
|------|------|
| Settings / sources | `%APPDATA%\com.ynotv.app\.settings.dat` |
| SQLite DB | `%APPDATA%\com.ynotv.app\ynotv.db` (+ `ynotv.db-wal` / `ynotv.db-shm` if present) |
| Window state | `%APPDATA%\com.ynotv.app\.windows-state.json` |
| Logs (if Debug enabled) | `%LOCALAPPDATA%\com.ynotv.app\logs\` |

---

## Reset to a fresh environment (for testing)

Use this when you want the **dev app** to behave like a first launch: no sources, no channels/EPG/VOD cache, default settings.

**Close the ynoTV window first** (and stop `pnpm dev` with `Ctrl+C` if it is still running).

### Full wipe (recommended for clean testing)

Deletes settings, sources, database, and local logs:

```powershell
# Kill leftover Vite/Tauri processes if needed
pnpm kill-port

# Remove app data (Roaming = settings + DB; Local = logs/cache)
Remove-Item -Recurse -Force "$env:APPDATA\com.ynotv.app" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.ynotv.app" -ErrorAction SilentlyContinue
```

Then start again:

```powershell
cd G:\GitHub\ynotv
pnpm dev
```

You will need to re-add sources (e.g. Dispatcharr) and sync from scratch.

### Database only (keep sources & settings)

Clears channels / EPG / VOD cache but leaves your configured sources and preferences:

```powershell
# Close the app first
Remove-Item -Force "$env:APPDATA\com.ynotv.app\ynotv.db" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:APPDATA\com.ynotv.app\ynotv.db-wal" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:APPDATA\com.ynotv.app\ynotv.db-shm" -ErrorAction SilentlyContinue
```

Then `pnpm dev` and **Sync** your sources again.

---

## Related docs

- Full “Building from Source” section → [README.md](./README.md)
- Windows installer / shareable `.exe` → [docs/build-windows-installer.md](./docs/build-windows-installer.md)
- Dispatcharr Direct Connect manual tests → [docs/dispatcharr-testing.md](./docs/dispatcharr-testing.md)
