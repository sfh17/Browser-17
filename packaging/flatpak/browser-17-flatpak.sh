#!/bin/sh
# Browser-17 launcher inside Flatpak (installed as /app/bin/browser-17).
PYVER=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
export PLAYER_SITE="/app/lib/python$PYVER/site-packages"   # numpy, pedalboard for the sound host
# The same settings as the regular (.deb) install, not a separate copy inside Flatpak: the player's
# own settings (colors, plugin chains, presets, the list of plugins that froze it), and the plugins'
# settings too (LSP keeps its window size, 200 %, in ~/.config/lsp-plugins). The cache stays apart:
# GStreamer's plugin list inside Flatpak is not the system's.
[ -d "$HOME/.config" ] && export XDG_CONFIG_HOME="$HOME/.config"
[ -d "$HOME/.local/share" ] && export XDG_DATA_HOME="$HOME/.local/share"
unset PLAYER_BROWSER_INIT   # Browser-17 on its own (not the browser inside Player-17)
# System Monitor (outside Flatpak) finds a process's icon by the process name, and Flatpak may only
# hand out icons named io.github.sfh17.Browser-17*. So the same icon is copied, under the sound
# host's name, into the user's own icon folder (only when it is missing or has changed).
SRC=/app/share/icons/hicolor/scalable/apps/io.github.sfh17.Browser-17.svg
for n in Browser-17 Browser-17-Sound; do
  DST="$HOME/.local/share/icons/hicolor/scalable/apps/$n.svg"
  [ -f "$SRC" ] && ! cmp -s "$SRC" "$DST" 2>/dev/null && mkdir -p "${DST%/*}" && cp -f "$SRC" "$DST" 2>/dev/null
done
# zypak: Chromium's sandbox inside Flatpak's sandbox
exec /app/bin/zypak-wrapper /app/electron/electron --class=io.github.sfh17.Browser-17 /app/lib/browser-17/app "$@"
