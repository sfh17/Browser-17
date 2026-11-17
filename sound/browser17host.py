#!/usr/bin/env python3
"""Browser-17 sound host.

Browser-17 runs on its own, but its sound works exactly like the browser inside Player-17:
this host uses the player's own code (player17core.py = a copy of Player-17's app.py) as a
library and keeps, without a window of its own:
  - WebSound: the browser's sound chain — Plugins 17 (Prism EQ / Simple, saturator, OTT,
    limiter), its VST3 chain, the volume, revival after sleep;
  - the Plugins window and the Color and background window, the same as in the player.

Settings: ~/.config/browser-17/sound.json. On the first start they are taken over from
Player-17 (~/.config/player-17/settings.json): the browser's chain, presets, colors and themes
come back by themselves. After that the player and the browser never touch each other's file.

Talks to Browser-17 (main.js / standalone.js) through stdin / stdout, one JSON object per line:
  in:  the page's events {"ev": "playing" | "title" | "volume" | "plugins" | "colors-open" | "quit"}
  out: {"page": {...}}  a command for the page (colors, notice, js)
       {"ev": "status", "ok": bool, "text": ""}
"""
import ctypes as _ctypes


def _name_me():
    """"Browser-17" in System Monitor, not "python3" (15 = PR_SET_NAME; Linux keeps 15 letters).
    Started through the "Browser-17-Sound" link, System Monitor then shows that full name."""
    try:
        _ctypes.CDLL(None).prctl(15, _ctypes.c_char_p(b"Browser-17"), 0, 0, 0)
    except Exception:
        pass


_name_me()   # straight away, before the slow imports
import json
import os
import re
import shutil
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN_PID = int(os.environ.get("BROWSER17_MAIN_PID") or 0)

# stdout is the line to Browser-17 (JSON only). The player's code prints its errors with print()
# ("GStreamer error: ..."): they went into that line and Browser-17 dropped them, so nothing ever
# showed in the terminal. Now every print goes to stderr (the terminal), JSON keeps its own line.
JSON_OUT = sys.stdout
sys.stdout = sys.stderr

# Python packages the player ships (pedalboard for VST3): the same folders, if they are there.
# pedalboard has a compiled part made for ONE Python version (cpython-312 = Python 3.12). The
# package now brings it for several versions, each in its own folder (site/py312, site/py314...):
# the host takes the one of the Python it runs on, so a newer Python (Ubuntu 26.04 = 3.14) finds
# its own copy instead of the 3.12 one it cannot load.
def site_dirs(base):
    if not os.path.isdir(base):
        return []
    mine = os.path.join(base, f"py{sys.version_info[0]}{sys.version_info[1]}")
    if os.path.isdir(mine):
        return [mine]
    if any(n.startswith("py3") and os.path.isdir(os.path.join(base, n)) for n in os.listdir(base)):
        return []   # copies for other Pythons only: none of them would load here
    return [base]   # an older package: one flat folder


if not (os.environ.get("PLAYER_SITE") or os.environ.get("PLYER_SITE")):
    found = [d for b in ("/usr/lib/browser-17/site", "/usr/lib/player-17/site",
                         "/usr/lib/player-17/python", "/usr/lib/player-17/site-packages") for d in site_dirs(b)]
    if found:
        os.environ["PLAYER_SITE"] = os.pathsep.join(found)

# GStreamer keeps a list of its plugins in ~/.cache/gstreamer-1.0. The home folder is shared by
# every system that uses it (distrobox containers, a second distro on the same /home): one
# system's list then hides the other's plugins ("No such element: playbin" in Fedora after Zorin
# wrote the list) and the sound host could not start. Each system gets its own list.
if not os.environ.get("GST_REGISTRY"):
    def _os_tag():
        info = {}
        try:
            with open("/etc/os-release", encoding="utf-8") as f:
                for line in f:
                    k, _, v = line.strip().partition("=")
                    info[k] = v.strip('"')
        except OSError:
            pass
        tag = f"{info.get('ID', 'linux')}-{info.get('VERSION_ID', '')}-{os.uname().machine}"
        return "".join(c if c.isalnum() or c in "-._" else "_" for c in tag)
    _cache = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    _reg_dir = os.path.join(_cache, "browser-17", "gstreamer")
    try:
        os.makedirs(_reg_dir, exist_ok=True)
        os.environ["GST_REGISTRY"] = os.path.join(_reg_dir, f"registry-{_os_tag()}.bin")
    except OSError:
        pass   # no cache folder: GStreamer uses its usual list

sys.path.insert(0, str(HERE))
import player17core as P  # noqa: E402  (the Player-17 code, as a library)
from player17core import Adw, Gio, GLib, Gtk  # noqa: E402
_name_me()   # again: the player's code may name the process "Player-17" when it loads

# Space / media keys in the Plugins window: the player's code would play / pause its music
# window, but here "music_window" is the hidden host window, which has no on_play_pause ->
# AttributeError and the whole sound host crashed (Ubuntu showed "Browser-17 has closed
# unexpectedly"). There is no music to pause here: Space stays a normal Space.
P.media_play_pause = lambda: False

APP_ID = "io.github.sfh17.Browser-17"
CONFIG = Path(GLib.get_user_config_dir()) / "browser-17"
SETTINGS = CONFIG / "sound.json"
PLAYER_SETTINGS = Path(GLib.get_user_config_dir()) / "player-17" / "settings.json"
SINK = "browser17_web"          # its own virtual output (the player's browser has "player17_web")
MARK_KEY = "browser17.web"      # its own mark on the browser's sound streams


def out(obj):
    try:
        JSON_OUT.write(json.dumps(obj) + "\n")
        JSON_OUT.flush()
    except (BrokenPipeError, OSError):
        os._exit(0)   # Browser-17 is gone


def log(*args):
    print("[browser-17 host]", *args, file=sys.stderr, flush=True)


# ---------------- its own settings (taken over from Player-17 once) ----------------
def take_over_player_settings():
    """First start: the whole Player-17 settings file is the starting point (the browser's chain
    web_*, the VST3 chain, presets, colors, themes, plugin folders...). Only once."""
    if SETTINGS.exists():
        return
    CONFIG.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(PLAYER_SETTINGS.read_text())
        if isinstance(data, dict):
            SETTINGS.write_text(json.dumps(data, indent=2))
            log("settings taken over from Player-17")
            return
    except (OSError, ValueError):
        pass
    SETTINGS.write_text("{}")


P.settings_file = lambda: SETTINGS   # every load / save of the shared code goes here now
P.WEB_SINK = SINK                    # the virtual output (WebAudioRoute uses this name)


def wanted_rate(choice):
    """The sample rate for the browser's menu choice: "auto" (as the output device), or a number."""
    if str(choice) in {str(r) for r in P.WEB_RATES}:
        return int(choice)
    return P.device_rate()


class Route(P.WebAudioRoute):
    """The player's route, but for Browser-17: its own mark, and its processes are the ones
    started by Browser-17's main process (this host is one of its children too).

    Two safety nets (the browser must never stay silent):
      - the host's own output (the chain -> speakers) is watched: own_seen_at = when it was last
        seen on a real output. If it ever lands in browser17_web (a loop), it is sent back out.
      - bypass: when the chain cannot play, the browser's streams go straight to the speakers
        (the volume slider then sets their volume directly)."""

    def __init__(self):
        super().__init__()
        self.bypass = False
        self.bypass_volume = 1.0
        self._vol_applied = {}
        self.own_seen_at = 0.0

    def _browser_stream(self, props, pids):
        return props.get(MARK_KEY) == "1" or (MAIN_PID and any(descends_from(p, MAIN_PID) for p in pids))

    def _bypass_round(self, ours):
        real = P.keep_default_real()
        text = P.pactl("list", "sink-inputs") or ""
        seen = set()
        for block in text.split("Sink Input #")[1:]:
            ident = block.split("\n", 1)[0].strip()
            sink = re.search(r"^\s*Sink:\s*(\d+)", block, re.M)
            props = dict(re.findall(r'^\s*([\w.]+) = "(.*)"$', block, re.M))
            pids = [int(props[k]) for k in ("pipewire.sec.pid", "application.process.id")
                    if props.get(k, "").isdigit()]
            on_ours = ours is not None and bool(sink and sink.group(1) == ours)
            if os.getpid() in pids or not self._browser_stream(props, pids):
                if on_ours and real:   # nobody hears anything in browser17_web while bypassing
                    P.pactl("move-sink-input", ident, real)
                continue
            seen.add(ident)
            if on_ours and real:
                P.pactl("move-sink-input", ident, real)
            vol = self.bypass_volume
            if self._vol_applied.get(ident) != vol:
                if P.pactl("set-sink-input-volume", ident, f"{round(vol * 100)}%") is not None:
                    self._vol_applied[ident] = vol
        self._vol_applied = {k: v for k, v in self._vol_applied.items() if k in seen}

    def _move_streams(self):
        try:
            sinks = P.pactl("list", "short", "sinks")
            if sinks is None:
                return
            ours = next((l.split("\t")[0] for l in sinks.splitlines() if l.split("\t")[1:2] == [SINK]), None)
            if self.bypass:
                self._bypass_round(ours)
                return
            if ours is None:
                if time.monotonic() - self._lost_at < 3:
                    return
                self._lost_at = time.monotonic()
                log("the virtual output was lost, making it again")
                GLib.idle_add(lambda: self.on_lost() or False)
                return
            # WirePlumber 0.5 (Ubuntu 26.04) could make browser17_web the default output: then
            # Player-17 (and any other program) played into it and nobody heard it.
            real = P.keep_default_real()
            text = P.pactl("list", "sink-inputs") or ""
            for block in text.split("Sink Input #")[1:]:
                ident = block.split("\n", 1)[0].strip()
                sink = re.search(r"^\s*Sink:\s*(\d+)", block, re.M)
                on_ours = bool(sink and sink.group(1) == ours)
                props = dict(re.findall(r'^\s*([\w.]+) = "(.*)"$', block, re.M))
                pids = [int(props[k]) for k in ("pipewire.sec.pid", "application.process.id")
                        if props.get(k, "").isdigit()]
                if os.getpid() in pids:
                    # the host's own sound (the chain's output to the speakers)
                    if on_ours:
                        log("the chain's output was in browser17_web (a loop): back to the speakers")
                        if real:
                            P.pactl("move-sink-input", ident, real)
                    else:
                        self.own_seen_at = time.monotonic()
                    continue
                if self._browser_stream(props, pids):
                    if not on_ours:
                        P.pactl("move-sink-input", ident, SINK)
                    continue
                # Not the browser's: Player-17 or any other program. It must never stay in
                # browser17_web (that was the bug: Player-17's time ran, its sound was gone).
                if on_ours and real:
                    log(f"another program's sound was in browser17_web "
                        f"({props.get('application.name', '?')}): back to {real}")
                    P.pactl("move-sink-input", ident, real)
        finally:
            self._busy = False


def descends_from(pid, root):
    seen = 0
    while pid and pid > 1 and seen < 16:
        if pid == root:
            return True
        try:
            with open(f"/proc/{pid}/stat") as fh:
                pid = int(fh.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            return False
        seen += 1
    return False


class BrowserLink:
    """What the player's code calls "the browser process": here it is Browser-17 itself."""
    transparent = None   # the window is always see-through: no restart for the opacity

    def running(self):
        return True

    def send(self, **cmd):
        if cmd.get("cmd") == "colors":   # also kept by Browser-17 for its next start
            out({"page": cmd, "keep": "colors"})
        else:
            out({"page": cmd})


class HostWindow(Adw.ApplicationWindow):
    """Never shown. Plays the part of the player's music window for the shared code: the owner of
    the browser's sound (WebSound) and the parent of the Plugins / Color and background windows."""

    def __init__(self, app):
        super().__init__(application=app, title="Browser-17")
        self.settings = P.shared_settings()
        self.browser = BrowserLink()
        self.web_route = Route()
        self.colors_window = None
        self.prefs_popover = None

    def flash_title(self, text):
        self.browser.send(cmd="notice", text=text)

    # the sample rate: shown in the browser's Plugins window next to the tabs
    def get_sample_rate_choice(self):
        return getattr(self.get_application(), "rate_choice", "auto")

    def set_sample_rate_choice(self, choice):
        """Chosen in the Plugins window: applied, and the browser's menu (and its settings) follow."""
        choice = str(choice or "auto")
        if choice not in {key for key, _name in P.HUB_RATES}:
            choice = "auto"
        self.get_application().set_rate(choice)
        out({"page": {"cmd": "rate", "value": choice}})

    def open_colors(self):
        if self.colors_window is None:
            self.colors_window = P.ColorsWindow(self)
        P.bring_to_front(self.colors_window)


class HostApp(P.PlayerApp):
    def __init__(self):
        Adw.Application.__init__(self, application_id=APP_ID + ".Sound",
                                 flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.music_window = None    # = the host window (the Color and background window finds the browser here)
        self.video_window = None
        self.web_sound = None
        self._styled = False
        self.host = None

    def do_activate(self):
        if self.host is not None:
            return
        self.hold()   # runs without a visible window
        self.setup_style()   # the saved colors + the player's stylesheet
        self.host = HostWindow(self)
        self.music_window = self.host
        # the sample rate chosen in the browser's menu (Browser-17 passes it at start)
        self.rate_choice = os.environ.get("BROWSER17_RATE") or "auto"
        log(f"sample rate: {P.set_web_rate(wanted_rate(self.rate_choice))} Hz ({self.rate_choice})")
        ok = self.host.web_route.setup()
        self.web_sound = P.WebSound(self.host)
        # The chain's output must have a name of its own. It was called "Browser-17", like the
        # browser's own streams, and the sound server remembers outputs by that name
        # ("sink-input-by-application-name:Browser-17" -> browser17_web): every new start the
        # chain's output was put back into browser17_web by the server itself = a loop, silence.
        sink = getattr(self.web_sound.player, "sink", None)
        if sink is not None:
            try:
                sink.set_property("client-name", "Browser-17 Sound")
            except TypeError:
                pass
        self._bad_since = None
        self._fails = []
        prev_error = self.web_sound.player.on_error

        def on_error(text):
            log("the chain's player stopped with an error:", text)
            if self._bad_since is None:
                self._bad_since = time.monotonic() - 10   # checked on the next tick, no waiting
            if prev_error is not None:
                prev_error(text)

        self.web_sound.player.on_error = on_error
        if ok:
            GLib.timeout_add(1000, self.watch_chain)
        out({"page": {"cmd": "colors", "colors": {k: P.COLORS[k] for k in P.BROWSER_COLOR_KEYS},
                      "frame": P.FRAME_ON[0]}, "keep": "colors"})
        if ok:
            out({"ev": "status", "ok": True})
        else:
            out({"ev": "status", "ok": False,
                 "text": "Volume and Plugins need pactl:  sudo apt install pulseaudio-utils"})
        threading.Thread(target=self.read_stdin, daemon=True).start()

    # ---- the watchdog: the browser never stays silent ----
    GRACE = 4.0   # seconds the chain may take to open its output after the page starts playing

    def watch_chain(self):
        route, sound = self.host.web_route, self.web_sound
        if route.bypass or sound is None:
            return False
        now = time.monotonic()
        playing = sound.page_playing and sound.live
        if not playing:
            self._bad_since = None
            return True
        if now - route.own_seen_at < 2.5:
            self._bad_since = None   # the chain's output is there: all good
            return True
        if self._bad_since is None:
            self._bad_since = now
            return True
        if now - self._bad_since < self.GRACE:
            return True
        self._bad_since = None
        self.chain_failed()
        return not route.bypass

    def chain_failed(self):
        route, sound = self.host.web_route, self.web_sound
        now = time.monotonic()
        self._fails = [t for t in self._fails if now - t < 90] + [now]
        try:
            state = sound.player.pipe.get_state(0)[1].value_nick
        except Exception:
            state = "?"
        cap = "reading" if route.capture is not None else "not reading"
        log(f"the chain plays nothing to the speakers (player: {state}, browser17_web: {cap})")
        if len(self._fails) == 1:
            log("building the sound path again")
            sound.revive()
            return
        # second time: the browser plays straight to the speakers, without the chain
        log("giving up on the chain for now: the browser plays directly (restart the browser to retry)")
        route.bypass_volume = float(getattr(self, "_volume", 1.0))
        route.bypass = True
        sound.stop()
        sound.page_playing = False
        out({"page": {"cmd": "notice",
                      "text": "Plugins could not start: the sound plays directly, without Plugins"}})

    def set_rate(self, choice):
        """A new sample rate from the browser's menu: the sound path is built again at it
        (the virtual output too: it is made at the chain's rate). A moment of silence, then
        the page plays on by itself."""
        self.rate_choice = str(choice or "auto")
        rate = wanted_rate(self.rate_choice)
        if rate == P.WEB_RATE:
            return
        P.set_web_rate(rate)
        log(f"sample rate: {rate} Hz ({self.rate_choice})")
        route, sound = self.host.web_route, self.web_sound
        if route.bypass or sound is None:
            return   # nothing goes through the chain now; the next start uses it
        route.stop_capture()
        route._lost_at = time.monotonic()   # its own watcher must not "find it lost" and rebuild twice
        # the old virtual output goes (also one left from an earlier start), the new one has the new rate
        for line in (P.pactl("list", "short", "modules") or "").splitlines():
            parts = line.split("\t")
            if len(parts) >= 3 and parts[1] == "module-null-sink" and \
                    re.search(rf"(^|\s)sink_name={SINK}(\s|$)", parts[2]):
                P.pactl("unload-module", parts[0])
        route.module = None
        sound.revive()

    def pause_others(self, source):
        pass   # no music / video windows here

    def quit_if_nothing_open(self):
        pass

    # ---- the page's events, as the player handles them ----
    def on_event(self, ev):
        kind = ev.get("ev")
        sound = self.web_sound
        route = self.host.web_route if self.host is not None else None
        if kind == "volume":
            try:
                self._volume = max(0.0, min(1.0, float(ev.get("value"))))
            except (TypeError, ValueError):
                pass
        if kind == "quit":
            self.shutdown_all()
        elif kind == "rate":   # from the browser's menu: the Plugins window follows
            self.set_rate(ev.get("value"))
            if self.web_sound is not None:
                self.web_sound.refresh_rate()
        elif route is not None and route.bypass:
            if kind == "volume":
                route.bypass_volume = getattr(self, "_volume", 1.0)   # set on the next round
            elif kind in ("plugins", "colors-open"):
                if kind == "colors-open":
                    self.host.open_colors()
                else:
                    out({"page": {"cmd": "notice", "text": "Plugins are off: they could not start (restart the browser)"}})
        elif sound is None:
            return
        elif kind == "playing":
            sound.on_playing(bool(ev.get("on")))
        elif kind == "title":
            sound.title = ev.get("text") or ""
        elif kind == "plugins":
            sound.open_hub("p17")
        elif kind == "colors-open":
            self.host.open_colors()
        elif kind == "volume":
            try:
                sound.set_master_volume(max(0.0, min(1.0, float(ev.get("value")))))
            except (TypeError, ValueError):
                pass

    def read_stdin(self):
        for line in sys.stdin:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            GLib.idle_add(lambda e=ev: self.on_event(e) or False)
        GLib.idle_add(lambda: self.shutdown_all() or False)   # Browser-17 closed

    def shutdown_all(self):
        try:
            if self.web_sound is not None:
                self.web_sound.stop()
                if getattr(self.web_sound, "_save_pending", False):
                    self.web_sound.flush_eq_save()
            if self.host is not None:
                self.host.web_route.close()   # the browser's streams go back to the speakers
        finally:
            self.release()
            self.quit()


def report_core():
    """One line at start when the own effects (Plugins 17 sound core) are missing, with the reason:
    without it the limiter asks for LSP / Calf and the saturator gets no sound."""
    if getattr(P, "P17DSP", None) is not None:
        return
    if P.GstBase is None:
        log("Plugins 17 are off: GstBase (GStreamer's introspection data) is missing")
        return
    import ctypes
    for path in (HERE / "libp17dsp.so", Path("/usr/lib/player-17/libp17dsp.so")):
        if path.exists():
            try:
                lib = ctypes.CDLL(str(path))
                lib.p17dsp_version.restype = ctypes.c_char_p
                log(f"Plugins 17 are off: {path} is version {lib.p17dsp_version().decode()}, "
                    f"the code wants {P.P17DSP_VERSION}")
            except (OSError, AttributeError) as err:
                log(f"Plugins 17 are off: {path} does not load: {err}")
            return
    log("Plugins 17 are off: libp17dsp.so not found and could not be built (no gcc?)")


if __name__ == "__main__":
    report_core()
    take_over_player_settings()
    GLib.set_prgname(APP_ID)
    GLib.set_application_name("Browser-17")
    Gtk.Window.set_default_icon_name(APP_ID)
    HostApp().run([sys.argv[0]])
