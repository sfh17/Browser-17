# Browser-17 — for developers

The Player-17 browser on its own. Independent from the player, but with everything the player's
browser had: the same look and code, and the same sound — Plugins 17 (Prism EQ / Simple,
saturator, OTT, limiter), the VST3 chain, the volume — with the player's own Plugins and
Color and background windows.

## Folders

- `app/` — the browser (Electron). **Shared with Player-17**: `main.js` runs both inside the player
  (when the player starts it with `PLAYER_BROWSER_INIT`) and on its own (Browser-17).
  - `main.js` — the main process (both modes)
  - `standalone.js` — Browser-17 on its own: its settings, the sound host, opening Player-17
  - `index.html`, `preload.js`, `standalone-ui.js` — the browser's own page
- `sound/` — the sound host
  - `browser17host.py` — runs the browser's sound chain and the Plugins / Color and background
    windows, using the player's code as a library
  - `player17core.py` — a copy of Player-17's `app.py` (update it with `./sync-player-core.sh`)

## Settings

- `~/.config/browser-17/settings.json` — the browser (tabs, sites, search engine...)
- `~/.config/browser-17/sound.json` — the sound and colors. **On the first start it is taken over
  from Player-17** (`~/.config/player-17/settings.json`): the browser's chain, VST3, presets, colors
  and themes come back by themselves. After that the two never touch each other's settings.
- Browser data: `~/.local/share/browser-17/`

Browser-17 uses its own virtual output (`browser17_web`) and its own sound mark, so it and the
browser inside Player-17 can be open at the same time.

## Run (testing)

Needs what Player-17 needs (GTK 4, libadwaita, GStreamer, pactl, gcc; pedalboard for VST3).
Then:

    ./run.sh

Electron: the one Player-17 already downloaded is used.

## Update the sound code from Player-17

    ./sync-player-core.sh ~/Documents/build17/Player-17-release-flathub/app.py

## Packages (.deb / .rpm / Arch-Manjaro)

    packaging/build.sh          # everything this computer can build -> dist/
    packaging/build.sh deb      # only the .deb (also: rpm, arch)

Close Browser-17 before installing, reinstalling or removing it.

**Ubuntu / Zorin / Debian (.deb)**

    sudo apt install ./dist/browser-17_*.deb                # install
    sudo apt install --reinstall ./dist/browser-17_*.deb    # reinstall / update
    sudo apt remove browser-17                              # remove

**Fedora (.rpm)**

    sudo dnf install ./dist/browser-17-*.rpm                # install
    sudo dnf reinstall ./dist/browser-17-*.rpm              # reinstall (same version)
    sudo dnf remove browser-17                              # remove

**Arch / Manjaro**

`packaging/build.sh` makes a ready package on any computer, Ubuntu included
(`browser-17-*.pkg.tar.zst`, or `.pkg.tar.xz` if the computer has no `zstd`):

    sudo pacman -U ./dist/browser-17-*.pkg.tar.zst          # install / update / reinstall

`dist/` also gets `browser-17-*-arch-src.tar.gz` — the recipe (PKGBUILD), for whoever wants to
build the package with makepkg on Arch itself:

    mkdir browser-17-arch && tar -xzf browser-17-*-arch-src.tar.gz -C browser-17-arch
    cd browser-17-arch && makepkg -si                       # builds and installs

Remove:

    sudo pacman -R browser-17

Note: apt is only for .deb; each distro installs its own package type with its own tool
(apt / dnf / pacman).

The package carries Electron (the newest stable one at build time, checked against its SHA-256),
the sound core already built, and pedalboard for VST3.

## The engine updates itself

Once a day Browser-17 looks for a newer Electron **of the same major version** (Chromium's
security fixes), downloads it in the background, checks its SHA-256 and uses it from the next
start (`~/.local/share/browser-17/engines/`). If a new engine does not start properly, the
launcher goes back to the previous one by itself. A new major version comes with our own release
(after testing). In `~/.config/browser-17/settings.json`:
`"engine_auto": false` switches the updates off, `"engine_track": "latest"` also takes new majors.
