#!/bin/bash
# Browser-17: build the packages — .deb (Ubuntu / Zorin), .rpm (Fedora...), Arch / Manjaro.
#
#   packaging/build.sh            all the packages this computer can build
#   packaging/build.sh deb        only the .deb   (also: rpm, arch, flatpak)
#   ELECTRON_VERSION=v45.2.1 packaging/build.sh   a fixed engine version
#
# What goes in:
#   - the browser (app/), the sound host + Player-17's code (sound/), the sound core built
#     already (libp17dsp.so), pedalboard for VST3 (if pip is there);
#   - Electron (the newest stable one, checked against its SHA-256): the browser works right
#     after installing; newer engines of the same major version then come by themselves.
# The packages land in dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packaging"
DIST="$ROOT/dist"
WORK="$ROOT/.build"
NAME="browser-17"
APP_ID="io.github.sfh17.Browser-17"
VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$ROOT/app/package.json")"
WANT="${1:-all}"

# Packages of older versions move to dist/old-builds/, so only the current ones sit in dist/
# (the same version is simply rebuilt over itself).
if [ -d "$DIST" ]; then
  mkdir -p "$DIST/old-builds"
  for f in "$DIST"/browser-17_*.deb "$DIST"/browser-17-*.rpm "$DIST"/browser-17-*.pkg.tar.* "$DIST"/browser-17_*.flatpak "$DIST"/browser-17-*-arch-src.tar.gz; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in
      browser-17_"$VERSION"_*|browser-17-"$VERSION"-*) ;;
      *) mv -f "$f" "$DIST/old-builds/" && echo "older build moved: dist/old-builds/$(basename "$f")" ;;
    esac
  done
  rmdir "$DIST/old-builds" 2>/dev/null || true
fi

case "$(uname -m)" in
  x86_64) EARCH=x64; DEBARCH=amd64; RPMARCH=x86_64 ;;
  aarch64) EARCH=arm64; DEBARCH=arm64; RPMARCH=aarch64 ;;
  *) echo "Unsupported machine: $(uname -m)"; exit 1 ;;
esac

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

# Flatpak: built with flatpak-builder from packaging/flatpak/, then packed as ONE file next to
# the other packages: dist/browser-17_<version>_<arch>.flatpak (install: flatpak install --user <file>).
# Its own runtime brings everything, so it doesn't need the Electron download below.
build_flatpak() {
  if ! command -v flatpak-builder >/dev/null; then
    echo "flatpak-builder isn't installed: sudo apt install flatpak-builder (skipping the Flatpak)"
    return 0
  fi
  say "Flatpak $VERSION"
  local FW="$WORK/flatpak"
  mkdir -p "$FW" "$DIST"
  flatpak-builder --user --install-deps-from=flathub --force-clean --disable-rofiles-fuse \
    --state-dir="$FW/state" --repo="$FW/repo" "$FW/build" "$PKG/flatpak/$APP_ID.yml"
  # always the same simple name, so one install command fits every version
  rm -f "$DIST/Browser-17.flatpak"
  flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo \
    "$FW/repo" "$DIST/Browser-17.flatpak" "$APP_ID"
  echo "-> dist/Browser-17.flatpak"
}

# ---------------- Electron: the newest stable version (or ELECTRON_VERSION) ----------------
latest_electron() {
  python3 - <<'PY'
import json, re, urllib.request
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Browser-17 build"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()
ok = lambda v: re.fullmatch(r"v\d+\.\d+\.\d+", v)
key = lambda v: tuple(int(x) for x in v[1:].split("."))
for src in ("electron", "github", "atom"):
    try:
        if src == "electron":
            vs = ["v" + r["version"].lstrip("v") for r in json.loads(get("https://releases.electronjs.org/releases.json"))]
        elif src == "github":
            vs = [r["tag_name"] for r in json.loads(get("https://api.github.com/repos/electron/electron/releases?per_page=60"))
                  if not r["prerelease"] and not r["draft"]]
        else:
            vs = re.findall(r"releases/tag/(v\d+\.\d+\.\d+)<", get("https://github.com/electron/electron/releases.atom"))
        vs = [v for v in vs if ok(v)]
        if vs:
            print(max(vs, key=key)); break
    except Exception:
        pass
PY
}

ELECTRON_VERSION="${ELECTRON_VERSION:-$(latest_electron)}"
if [ -z "$ELECTRON_VERSION" ] && command -v git >/dev/null; then
  ELECTRON_VERSION="$(git ls-remote --tags --refs https://github.com/electron/electron 'v*' | awk '{print $2}' |
    sed 's#refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1)"
fi
[ -n "$ELECTRON_VERSION" ] || { echo "Could not find the Electron version (offline?). Set ELECTRON_VERSION=vX.Y.Z"; exit 1; }

say "Browser-17 $VERSION, engine Electron $ELECTRON_VERSION ($EARCH)"
if [ "$WANT" = "flatpak" ]; then build_flatpak; say "Done: $DIST"; ls -la "$DIST"; exit 0; fi
mkdir -p "$WORK" "$DIST"
ZIP="$WORK/electron-$ELECTRON_VERSION-linux-$EARCH.zip"
BASE="https://github.com/electron/electron/releases/download/$ELECTRON_VERSION"
if [ ! -f "$ZIP" ]; then
  curl -fL --retry 3 -o "$ZIP.part" "$BASE/electron-$ELECTRON_VERSION-linux-$EARCH.zip"
  mv "$ZIP.part" "$ZIP"
fi
curl -fsSL --retry 3 -o "$WORK/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
WANT_SUM="$(grep "electron-$ELECTRON_VERSION-linux-$EARCH.zip" "$WORK/SHASUMS256.txt" | grep -v symbols | awk '{print $1}' | head -n1)"
GOT_SUM="$(sha256sum "$ZIP" | awk '{print $1}')"
if [ "$WANT_SUM" != "$GOT_SUM" ]; then
  rm -f "$ZIP"
  echo "Electron checksum does not match — the download was removed, try again."
  exit 1
fi
echo "Electron checksum OK"

# ---------------- the installed tree ----------------
STAGE="$WORK/stage"
rm -rf "$STAGE"
LIB="$STAGE/usr/lib/$NAME"
mkdir -p "$LIB" "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
         "$STAGE/usr/share/icons/hicolor/scalable/apps" "$STAGE/usr/share/doc/$NAME"

say "The browser and the sound host"
cp -a "$ROOT/app" "$LIB/app"
rm -f "$LIB/app/main.player.js"
mkdir -p "$LIB/sound"
cp "$ROOT/sound/browser17host.py" "$ROOT/sound/player17core.py" "$LIB/sound/"
# Readable for everyone, whatever the source files had (a file saved as "owner only" made the
# installed browser fail: EACCES on /usr/lib/browser-17/app/main.js).
chmod -R u=rwX,go=rX "$LIB/app" "$LIB/sound"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d['version']=sys.argv[2]; json.dump(d,open(sys.argv[1],'w'),indent=1)" \
  "$LIB/app/package.json" "$VERSION"

say "The sound core (libp17dsp.so), built now so users need no compiler"
python3 - "$ROOT/sound/player17core.py" "$WORK/p17dsp.c" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "P17DSP_C":
        open(sys.argv[2], "w").write(node.value.value)
        break
else:
    sys.exit("P17DSP_C not found in player17core.py")
PY
gcc -O2 -shared -fPIC -o "$LIB/sound/libp17dsp.so" "$WORK/p17dsp.c" -lm
strip --strip-unneeded "$LIB/sound/libp17dsp.so" 2>/dev/null || true

say "pedalboard for VST3 (one copy per Python version)"
# pedalboard's compiled part works only with the Python version it was made for. Built on Zorin
# (Python 3.12), the package carried only the 3.12 copy, and on Ubuntu 26.04 (Python 3.14) VST3
# disappeared. Now every Python a distro may have gets its own folder: site/py310 ... site/py314.
# The sound host picks the folder of the Python it runs on.
PB_PYS="${PB_PYS:-3.10 3.11 3.12 3.13 3.14 3.15}"
case "$EARCH" in x64) PB_PLAT=x86_64 ;; arm64) PB_PLAT=aarch64 ;; esac
rm -rf "$LIB/site"; mkdir -p "$LIB/site"
if python3 -m pip --version >/dev/null 2>&1; then
  got=""
  for v in $PB_PYS; do
    d="$LIB/site/py${v/./}"
    if python3 -m pip install --quiet --no-deps --only-binary=:all: --target "$d" \
         --python-version "$v" --implementation cp \
         --platform "manylinux2014_$PB_PLAT" --platform "manylinux_2_28_$PB_PLAT" \
         --break-system-packages pedalboard 2>/dev/null ||
       python3 -m pip install --quiet --no-deps --only-binary=:all: --target "$d" \
         --python-version "$v" --implementation cp \
         --platform "manylinux2014_$PB_PLAT" --platform "manylinux_2_28_$PB_PLAT" pedalboard 2>/dev/null; then
      got="$got $v"
    else
      rm -rf "$d"
    fi
  done
  if [ -n "$got" ]; then
    echo "pedalboard: in the package for Python$got"
  else
    echo "pedalboard could not be fetched: VST3 needs  pip install pedalboard  on the computer"
    rm -rf "$LIB/site"
  fi
else
  echo "no pip here: VST3 needs  pip install pedalboard  on the computer (Plugins 17 work anyway)"
  rm -rf "$LIB/site"
fi

say "Electron"
mkdir -p "$LIB/electron"
python3 - "$ZIP" "$LIB/electron" <<'PY'
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for info in z.infolist():
    target = z.extract(info, sys.argv[2])
    mode = (info.external_attr >> 16) & 0o755
    if mode and not info.is_dir():
        os.chmod(target, mode)
PY
echo "${ELECTRON_VERSION#v}" > "$LIB/electron/version"
chmod 4755 "$LIB/electron/chrome-sandbox"   # (root owns it in the packages)

say "Launcher, menu entry, icon, AppArmor"
install -m 755 "$PKG/browser-17" "$STAGE/usr/bin/browser-17"
install -m 644 "$ROOT/$APP_ID.desktop" "$STAGE/usr/share/applications/$APP_ID.desktop"
install -m 644 "$PKG/icon.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/$APP_ID.svg"
# the same icon under the process names: System Monitor looks the icon up by the process name
for n in Browser-17 Browser-17-Sound; do
  install -m 644 "$PKG/icon.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/$n.svg"
done
# AppStream: without this file GNOME Software / KDE Discover do not list the app at all
# (Player-17, Pad-17 and Ripper-17 have it, Browser-17 had it only for Flatpak)
mkdir -p "$STAGE/usr/share/metainfo"
install -m 644 "$PKG/flatpak/$APP_ID.metainfo.xml" "$STAGE/usr/share/metainfo/$APP_ID.metainfo.xml"
mkdir -p "$LIB/apparmor"
install -m 644 "$PKG/apparmor-browser-17" "$LIB/apparmor/browser-17"
install -m 644 "$ROOT/README.md" "$STAGE/usr/share/doc/$NAME/README.md"
[ -f "$ROOT/LICENSE" ] && install -m 644 "$ROOT/LICENSE" "$STAGE/usr/share/doc/$NAME/LICENSE"
find "$LIB" -name __pycache__ -prune -exec rm -rf {} +
# Permissions: the build folder may be group-writable (umask 002 = 775); in the packages every
# folder must be 755 and no file writable by others, or pacman / rpm warn about /usr, /usr/bin...
# (and a group-writable /usr/lib/browser-17 would be a security hole)
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod go-w {} +
chmod 4755 "$LIB/electron/chrome-sandbox"

say "Libraries check"
python3 "$PKG/check-libs.py" "$STAGE"

# ---------------- .deb ----------------
build_deb() {
  command -v dpkg-deb >/dev/null || { echo "(no dpkg-deb: the .deb is skipped)"; return; }
  say ".deb"
  local D="$WORK/deb"
  rm -rf "$D"; cp -a "$STAGE" "$D"; mkdir -p "$D/DEBIAN"
  local SIZE; SIZE="$(du -sk "$D" | awk '{print $1}')"
  cat > "$D/DEBIAN/control" <<EOF
Package: $NAME
Version: $VERSION
Architecture: $DEBARCH
Maintainer: sfh17
Installed-Size: $SIZE
Section: web
Priority: optional
Depends: python3, python3-gi, python3-gi-cairo, python3-gst-1.0, python3-numpy, libatomic1, gir1.2-gtk-4.0, gir1.2-adw-1, gir1.2-gstreamer-1.0, gir1.2-secret-1,
 gstreamer1.0-plugins-base, gstreamer1.0-plugins-good, gstreamer1.0-pulseaudio, pulseaudio-utils,
 libnss3, libgbm1, libdrm2, libxkbcommon0, libgtk-3-0t64 | libgtk-3-0, libasound2t64 | libasound2,
 libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libcups2t64 | libcups2
Description: Browser-17 — a web browser with its own sound chain
 The Player-17 browser on its own: Plugins 17 (Prism EQ, saturator, OTT, limiter), VST3,
 Color and background. Its engine (Electron / Chromium) updates itself within its major version.
EOF
  cat > "$D/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
# Chromium's sandbox helper: owned by root with the setuid bit
chown root:root /usr/lib/browser-17/electron/chrome-sandbox
chmod 4755 /usr/lib/browser-17/electron/chrome-sandbox
# Ubuntu 24.04+: let the engines the browser updates by itself use the sandbox
if [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
  cp /usr/lib/browser-17/apparmor/browser-17 /etc/apparmor.d/browser-17
  apparmor_parser -r -T -W /etc/apparmor.d/browser-17 || true
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
exit 0
EOF
  cat > "$D/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if [ -e /etc/apparmor.d/browser-17 ]; then
    command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R /etc/apparmor.d/browser-17 2>/dev/null || true
    rm -f /etc/apparmor.d/browser-17
  fi
fi
exit 0
EOF
  chmod 755 "$D/DEBIAN/postinst" "$D/DEBIAN/postrm"
  dpkg-deb --root-owner-group -Zxz --build "$D" "$DIST/${NAME}_${VERSION}_${DEBARCH}.deb" >/dev/null
  echo "-> dist/${NAME}_${VERSION}_${DEBARCH}.deb"
}

# ---------------- .rpm ----------------
build_rpm() {
  command -v rpmbuild >/dev/null || { echo "(no rpmbuild: the .rpm is skipped — sudo apt install rpm)"; return; }
  say ".rpm"
  local R="$WORK/rpm"
  rm -rf "$R"; mkdir -p "$R"/{BUILD,RPMS,SPECS,SOURCES,SRPMS}
  cat > "$R/SPECS/$NAME.spec" <<EOF
Name: $NAME
Version: $VERSION
Release: 1
Summary: Browser-17 — a web browser with its own sound chain
License: see /usr/share/doc/$NAME
AutoReqProv: no
Requires: python3, python3-gobject, python3-cairo, python3-gstreamer1, python3-numpy, libatomic, gtk4, libadwaita, libsecret, gstreamer1-plugins-base, gstreamer1-plugins-good, pulseaudio-utils, nss, mesa-libgbm, alsa-lib, gtk3
%description
The Player-17 browser on its own: Plugins 17, VST3, Color and background. Its engine updates itself.
%install
cp -a "$STAGE"/. %{buildroot}/
rm -rf %{buildroot}/usr/lib/$NAME/apparmor
%files
/usr/bin/browser-17
/usr/lib/$NAME
%attr(4755, root, root) /usr/lib/$NAME/electron/chrome-sandbox
/usr/share/applications/$APP_ID.desktop
/usr/share/icons/hicolor/scalable/apps/$APP_ID.svg
/usr/share/icons/hicolor/scalable/apps/Browser-17*.svg
/usr/share/metainfo/$APP_ID.metainfo.xml
/usr/share/doc/$NAME
EOF
  rpmbuild --quiet --define "_topdir $R" --define "_build_id_links none" --define "__strip /bin/true" \
           --target "$RPMARCH" -bb "$R/SPECS/$NAME.spec"
  cp "$R"/RPMS/*/*.rpm "$DIST/"
  echo "-> dist/$(basename "$R"/RPMS/*/*.rpm)"
}

# ---------------- Arch / Manjaro ----------------
build_arch() {
  say "Arch / Manjaro"
  local A="$WORK/arch"
  rm -rf "$A"; mkdir -p "$A"
  tar -C "$STAGE" -czf "$A/$NAME-$VERSION-stage.tar.gz" .
  cat > "$A/PKGBUILD" <<EOF
pkgname=$NAME
pkgver=$VERSION
pkgrel=1
pkgdesc="Browser-17 — a web browser with its own sound chain (Plugins 17, VST3)"
arch=('$(uname -m)')
url="https://github.com/sfh17"
license=('custom')
depends=('python' 'python-gobject' 'python-cairo' 'gst-python' 'python-numpy' 'gtk4' 'libadwaita' 'libsecret' 'gst-plugins-base' 'gst-plugins-good'
         'libpulse' 'nss' 'mesa' 'alsa-lib' 'gtk3')
options=('!strip' '!debug')
source=("$NAME-$VERSION-stage.tar.gz")
sha256sums=('SKIP')
noextract=("$NAME-$VERSION-stage.tar.gz")
package() {
  tar -C "\$pkgdir" -xzf "\$srcdir/$NAME-$VERSION-stage.tar.gz"
  rm -rf "\$pkgdir/usr/lib/$NAME/apparmor"
  chmod 4755 "\$pkgdir/usr/lib/$NAME/electron/chrome-sandbox"
}
EOF
  if command -v makepkg >/dev/null; then
    (cd "$A" && makepkg -f --noconfirm >/dev/null && cp ./*.pkg.tar.* "$DIST/")
    echo "-> dist/$(cd "$A" && ls ./*.pkg.tar.* | head -n1)"
  else
    # No makepkg (Ubuntu / Fedora): build the ready package ourselves, the same way makepkg does.
    local S="$A/pkgroot"
    mkdir -p "$S"
    cp -a "$STAGE/." "$S/"
    rm -rf "$S/usr/lib/$NAME/apparmor"
    chmod 4755 "$S/usr/lib/$NAME/electron/chrome-sandbox"
    rm -f "$DIST/$NAME-$VERSION"-*.pkg.tar.* "$DIST/$NAME-$VERSION-arch-src.tar.gz"
    python3 "$PKG/mkarchpkg.py" "$S" "$DIST" "$NAME" "$VERSION" "$(uname -m)" \
      "Browser-17 — a web browser with its own sound chain (Plugins 17, VST3)" "https://github.com/sfh17" \
      python python-gobject python-cairo gst-python python-numpy gtk4 libadwaita gst-plugins-base \
      gst-plugins-good libpulse nss mesa alsa-lib gtk3
    # the recipe too, for whoever wants to build it with makepkg on Arch
    tar -C "$A" --exclude=./pkgroot -czf "$DIST/$NAME-$VERSION-arch-src.tar.gz" .
  fi
}

case "$WANT" in
  deb) build_deb ;;
  rpm) build_rpm ;;
  arch) build_arch ;;
  all) build_deb; build_rpm; build_arch; build_flatpak ;;
  *) echo "Usage: $0 [all|deb|rpm|arch|flatpak]"; exit 1 ;;
esac
say "Done: $DIST"
ls -la "$DIST"
