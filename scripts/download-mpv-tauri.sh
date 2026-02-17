#!/bin/bash
# Download mpv binaries for Tauri sidecar
# Run this script from the repository root

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_BIN_DIR="$REPO_ROOT/packages/app/src-tauri/bin"

mkdir -p "$TAURI_BIN_DIR"

# Detect OS and Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "Downloading mpv for Windows (Tauri Sidecar)..."
    TARGET="x86_64-pc-windows-msvc"
    
    # Fetch latest release download URL (shinchiro builds)
    MPV_URL=$(curl -s https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest \
      | grep "browser_download_url.*mpv-x86_64.*.7z" \
      | head -n 1 \
      | cut -d '"' -f 4)
    
    if [ -z "$MPV_URL" ]; then
      echo "Failed to find MPV download URL from GitHub API"
      exit 1
    fi
    
    echo "URL: $MPV_URL"
    TEMP_DIR=$(mktemp -d)
    curl -L -o "$TEMP_DIR/mpv.7z" "$MPV_URL"

    # Extract
    7z x "$TEMP_DIR/mpv.7z" -o"$TEMP_DIR/mpv-extract" -y

    # Move and Rename for Tauri Sidecar
    cp "$TEMP_DIR/mpv-extract/mpv.exe" "$TAURI_BIN_DIR/mpv-$TARGET.exe"
    cp "$TEMP_DIR/mpv-extract/"*.dll "$TAURI_BIN_DIR/" 2>/dev/null || true

    rm -rf "$TEMP_DIR"
    echo "mpv for Windows (Tauri) setup at $TAURI_BIN_DIR/mpv-$TARGET.exe"
    ;;

  Darwin)
    echo "Downloading mpv for macOS..."
    # Determine Arch
    if [ "$ARCH" = "arm64" ]; then
      TARGET="aarch64-apple-darwin"
      # Stolendata builds for Apple Silicon
      MPV_URL="https://laboratory.stolendata.net/~djinn/mpv_osx/mpv-latest.tar.gz"
    else
      TARGET="x86_64-apple-darwin"
      # Need x86_64 build source, usually Homebrew or other
      echo "Warning: Automated x86_64 download not fully implemented, using placeholder."
      exit 1
    fi

    echo "URL: $MPV_URL"
    TEMP_DIR=$(mktemp -d)
    curl -L -o "$TEMP_DIR/mpv.tar.gz" "$MPV_URL"
    
    tar -xzf "$TEMP_DIR/mpv.tar.gz" -C "$TEMP_DIR"
    
    # Extract binary from .app bundle
    MPV_APP=$(find "$TEMP_DIR" -maxdepth 2 -name "*.app" -type d | head -1)
    if [ -n "$MPV_APP" ]; then
        cp "$MPV_APP/Contents/MacOS/mpv" "$TAURI_BIN_DIR/mpv-$TARGET"
        chmod +x "$TAURI_BIN_DIR/mpv-$TARGET"
        echo "mpv for macOS setup at $TAURI_BIN_DIR/mpv-$TARGET"
    else
        echo "Failed to find mpv.app in download"
        exit 1
    fi
    rm -rf "$TEMP_DIR"
    ;;

  Linux)
    echo "Setting up mpv for Linux..."
    TARGET="x86_64-unknown-linux-gnu"
    
    # Linux: Use system mpv (distribution packages are the standard way)
    # Static mpv builds for Linux are unreliable, so we rely on the user
    # having mpv installed via their package manager
    if command -v mpv &> /dev/null; then
        echo "Using system mpv: $(command -v mpv)"
        # Create a wrapper script that calls the system mpv
        # Tauri sidecars need to be in the bin directory
        cat > "$TAURI_BIN_DIR/mpv-$TARGET" << 'EOF'
#!/bin/bash
# Wrapper script to use system mpv
exec /usr/bin/mpv "$@"
EOF
        chmod +x "$TAURI_BIN_DIR/mpv-$TARGET"
        echo "mpv wrapper for Linux setup at $TAURI_BIN_DIR/mpv-$TARGET"
    else
        echo "ERROR: mpv not found in system PATH"
        echo "Please install mpv using your package manager:"
        echo "  Ubuntu/Debian: sudo apt install mpv"
        echo "  Fedora: sudo dnf install mpv"
        echo "  Arch: sudo pacman -S mpv"
        exit 1
    fi
    ;;

  *)
    echo "Unknown platform: $OS"
    exit 1
    ;;
esac

echo "MPV download complete for $OS"
