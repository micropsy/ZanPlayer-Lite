#!/usr/bin/env bash
set -euo pipefail

# Stages the system LibVLC (libvlc.dylib + libvlccore.dylib + the full plugin
# tree) from the installed VLC.app into src-tauri/vendor/vlc, from where the
# macOS bundler copies them into the app at
# Contents/Resources/vendor/vlc/{lib,plugins}. The shipped app then runs its
# OWN bundled libvlc — no system VLC.app required on the end-user's Mac.
#
# Usage (from project root, like release.yml):
#   bash scripts/bundle-vlc.sh            # /Applications/VLC.app
#   VLC_PREFIX=/path/to/lib bash scripts/bundle-vlc.sh
#
# The staged tree is gitignored; it is regenerated per build/CI run so the
# bundled libvlc + plugins always match arch/version of the build machine.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR=""
if [[ -n "${VLC_PREFIX:-}" ]]; then
  if [[ -f "$VLC_PREFIX/libvlc.dylib" ]]; then
    LIB_DIR="$VLC_PREFIX"
  else
    LIB_DIR="$VLC_PREFIX/lib"
  fi
elif [[ -d "/Applications/VLC.app/Contents/MacOS/lib" ]]; then
  LIB_DIR="/Applications/VLC.app/Contents/MacOS/lib"
fi

if [[ -z "$LIB_DIR" || ! -f "$LIB_DIR/libvlc.dylib" ]]; then
  echo "error: libvlc not found — install VLC.app or set VLC_PREFIX" >&2
  exit 1
fi

PLUGIN_DIR="$(dirname "$LIB_DIR")/plugins"
if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "error: VLC plugins not found next to $LIB_DIR" >&2
  exit 1
fi

VENDOR="$ROOT/src-tauri/vendor/vlc"
rm -rf "$VENDOR"
mkdir -p "$VENDOR"
cp -R "$LIB_DIR" "$VENDOR/lib"
cp -R "$PLUGIN_DIR" "$VENDOR/plugins"

echo "Staged LibVLC into $VENDOR:"
du -sh "$VENDOR" "$VENDOR/lib" "$VENDOR/plugins"