#!/bin/sh
# Browser-17: start from this folder (for testing, before the .deb).
# Uses the Electron that Player-17 already downloaded (~/.local/share/player-17/electron),
# or another one given in ELECTRON=/path/to/electron.
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
ELECTRON="${ELECTRON:-$DATA/player-17/electron/electron}"

if [ ! -x "$ELECTRON" ]; then
  echo "Electron not found: $ELECTRON"
  echo "Open the browser once in Player-17 (it downloads Electron), or set ELECTRON=/path/to/electron"
  exit 1
fi

# Chromium's sandbox helper must belong to root with the setuid bit (Player-17 asks for this once)
SANDBOX="$(dirname "$ELECTRON")/chrome-sandbox"
if [ -e "$SANDBOX" ] && ! { [ "$(stat -c %u "$SANDBOX")" = 0 ] && [ -u "$SANDBOX" ]; }; then
  echo "The Electron sandbox needs root once:"
  echo "  sudo chown root:root \"$SANDBOX\" && sudo chmod 4755 \"$SANDBOX\""
  exit 1
fi

# no PLAYER_BROWSER_INIT = Browser-17 runs on its own
unset PLAYER_BROWSER_INIT
exec "$ELECTRON" "$HERE/app" "$@"
