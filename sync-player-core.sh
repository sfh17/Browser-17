#!/bin/sh
# Takes the sound code from Player-17 into Browser-17 (the copy Browser-17 uses as a library).
# Run after app.py changed:  ./sync-player-core.sh /path/to/Player-17/app.py
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HOME/Documents/build17/Player-17-release-flathub/app.py}"
if [ ! -f "$SRC" ]; then
  echo "app.py not found: $SRC"
  echo "Usage: $0 /path/to/Player-17/app.py"
  exit 1
fi
cp "$SRC" "$HERE/sound/player17core.py" && echo "Browser-17 now uses: $SRC"
