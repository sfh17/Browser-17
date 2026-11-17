# Browser-17

A web browser for Linux with its own sound chain — Prism EQ, limiter, VST3 — and Shield 17 against ads and trackers.

Browser-17 is the browser from [Player-17](https://github.com/sfh17/Player-17), made into a standalone app.
A fresh Chromium engine (Electron) with all codecs, plus the player's sound: everything you hear
in the browser goes through your own effects.

- **Plugins 17:** Prism EQ (or Simple), saturator, OTT and limiter, plus a VST3 chain
- **Shield 17:** blocks ads, trackers and cookies; block lists update by themselves
- Tabs with pinning, an editable start page, extensions from the Chrome Web Store
- The engine updates itself in the background (security fixes), with a safe fallback
- Your own colors and transparency, the same design as Player-17

## Install

Download the package for your system from **[Releases](https://github.com/sfh17/Browser-17/releases)**
(on the right of this page). Open the folder with the file (usually Downloads), right-click on an
empty space, choose "Open in Terminal" and copy the command. Close Browser-17 before reinstalling
or removing it.

**Flatpak — any distro**

    flatpak install --user ./Browser-17.flatpak                # install / update
    flatpak uninstall --user io.github.sfh17.Browser-17        # remove

**Ubuntu / Zorin / Debian (.deb)**

    sudo apt install ./browser-17_*_amd64.deb                  # install
    sudo apt install --reinstall ./browser-17_*_amd64.deb      # reinstall / update
    sudo apt remove browser-17                                 # remove

**Fedora (.rpm)**

    sudo dnf install ./browser-17-*.rpm                        # install
    sudo dnf reinstall ./browser-17-*.rpm                      # reinstall
    sudo dnf remove browser-17                                 # remove

**Arch / Manjaro**

    sudo pacman -U ./browser-17-*.pkg.tar.zst                  # install / update
    sudo pacman -R browser-17                                  # remove

## Build from source

    packaging/build.sh            # .deb, .rpm, Arch package and Browser-17.flatpak -> dist/

More about the folders, settings and the engine updates: [DEVELOPING.md](DEVELOPING.md).

## Feedback

Found a bug or have an idea? Open an [issue](https://github.com/sfh17/Browser-17/issues).

## License

Open source, [GPL-3.0](LICENSE). Made by sfh17.
