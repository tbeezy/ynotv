#!/bin/bash
# Download mpv binaries for bundling with the app
# Run this script from the repository root
#
# Sources (both listed on https://mpv.io/installation/):
# - Windows: SourceForge mpv-player-windows (official community builds)
# - macOS: stolendata builds (arm64 only, macOS 14+)

set -e

# =============================================================================
# Checksums - UPDATE THESE when changing mpv versions
# To get checksum: curl -L <url> | sha256sum
# =============================================================================
MPV_SHA256_WINDOWS="8cf5ce27d21490c24eedf91e0ac2bc4a748ba8f4eb20cb7c1fc9442d2d580008"
MPV_SHA256_MACOS="3170fb709defebaba33e9755297d70dc3562220541de54fc3d494a8309ef1260"

# Verify checksum of downloaded file
# Usage: verify_checksum <file> <expected_sha256>
verify_checksum() {
  local file="$1"
  local expected="$2"

  if [ "$expected" = "SKIP" ]; then
    echo "⚠️  Checksum verification SKIPPED (set MPV_SHA256_* to enable)"
    return 0
  fi

  echo "Verifying checksum..."
  local actual
  if command -v sha256sum &> /dev/null; then
    actual=$(sha256sum "$file" | cut -d' ' -f1)
  elif command -v shasum &> /dev/null; then
    actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
  else
    echo "⚠️  No sha256sum or shasum found, skipping verification"
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    echo "❌ Checksum mismatch!"
    echo "   Expected: $expected"
    echo "   Actual:   $actual"
    echo "   This could indicate a corrupted download or supply chain attack."
    exit 1
  fi

  echo "✓ Checksum verified"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$REPO_ROOT/packages/electron/mpv-bundle"

mkdir -p "$BUNDLE_DIR"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "Downloading mpv for Windows (latest from shinchiro/mpv-winbuild-cmake)..."
    
    # Fetch latest release download URL
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

    # Skip checksum for rolling release
    verify_checksum "$TEMP_DIR/mpv.7z" "SKIP"

    # Extract with 7z (available in GitHub Actions Windows runners)
    7z x "$TEMP_DIR/mpv.7z" -o"$TEMP_DIR/mpv-extract" -y

    # Copy only what we need
    cp "$TEMP_DIR/mpv-extract/mpv.exe" "$BUNDLE_DIR/"
    cp "$TEMP_DIR/mpv-extract/"*.dll "$BUNDLE_DIR/" 2>/dev/null || true

    rm -rf "$TEMP_DIR"
    echo "mpv for Windows downloaded to $BUNDLE_DIR"
    ;;

  Darwin)
    echo "Downloading mpv for macOS..."
    # stolendata builds - arm64 only (Apple Silicon, macOS 14+)
    # https://laboratory.stolendata.net/~djinn/mpv_osx/
    # Note: Intel Mac users will need to install mpv via Homebrew
    MPV_URL="https://laboratory.stolendata.net/~djinn/mpv_osx/mpv-arm64-0.40.0.tar.gz"
    TEMP_DIR=$(mktemp -d)
    curl -L -o "$TEMP_DIR/mpv.tar.gz" "$MPV_URL"

    verify_checksum "$TEMP_DIR/mpv.tar.gz" "$MPV_SHA256_MACOS"

    # Extract
    tar -xzf "$TEMP_DIR/mpv.tar.gz" -C "$TEMP_DIR"

    # Find the .app bundle (name may vary)
    MPV_APP=$(find "$TEMP_DIR" -maxdepth 2 -name "*.app" -type d | head -1)
    if [ -z "$MPV_APP" ]; then
      echo "❌ Could not find .app bundle in archive"
      ls -la "$TEMP_DIR"
      exit 1
    fi
    echo "Found app bundle: $MPV_APP"

    # Copy mpv binary and dylibs preserving relative path structure
    # stolendata builds have libs in MacOS/lib/, not Frameworks/
    mkdir -p "$BUNDLE_DIR/MacOS"
    cp "$MPV_APP/Contents/MacOS/mpv" "$BUNDLE_DIR/MacOS/"
    # Copy dylibs (in MacOS/lib/ for stolendata builds)
    if [ -d "$MPV_APP/Contents/MacOS/lib" ]; then
      cp -R "$MPV_APP/Contents/MacOS/lib" "$BUNDLE_DIR/MacOS/"
    fi
    # Also check Frameworks (other builds may use this)
    if [ -d "$MPV_APP/Contents/Frameworks" ]; then
      cp -R "$MPV_APP/Contents/Frameworks" "$BUNDLE_DIR/"
    fi

    rm -rf "$TEMP_DIR"
    echo "mpv for macOS (Apple Silicon) downloaded to $BUNDLE_DIR"
    ;;

  Linux)
    echo "Linux does not bundle mpv - users should install via package manager"
    # Create empty marker file so electron-builder doesn't fail
    touch "$BUNDLE_DIR/.linux-no-bundle"
    ;;

  *)
    echo "Unknown platform: $(uname -s)"
    exit 1
    ;;
esac

echo "Done!"
