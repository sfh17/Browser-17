// Browser-17 on its own (without Player-17): this module plays the part the player plays otherwise.
//  - keeps the settings (~/.config/browser-17/settings.json);
//  - starts the sound host (browser17host.py): the browser's sound goes through the same chain as
//    inside Player-17 (Plugins 17, VST3, volume), with the player's own Plugins and
//    Color and background windows;
//  - opens Player-17 from the "places" menu when it is installed.
// The page talks to it with the same events it sends to the player ({ev: "set", ...}).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const HOME = os.homedir();
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "browser-17");
const SETTINGS = path.join(CONFIG_DIR, "settings.json");

// Every sound stream of this browser carries this mark: the helper finds them by it (as the
// player does with player17.web). Set before Chromium starts its audio process, which inherits it.
const MARK = 'browser17.web="1"';
if (!(process.env.PULSE_PROP || "").includes(MARK)) {
  process.env.PULSE_PROP = ((process.env.PULSE_PROP || "") + " " + MARK).trim();
}
// ...and it starts right in the browser's virtual output (the sound chain), not on the speakers:
// moved there only afterwards, the first moment of every new sound stuttered (it played, was cut,
// and played again). If that output is missing, the sound server plays it on the speakers.
const SINK = "browser17_web";
// BROWSER17_DIRECT_SOUND=1 (for testing): no sound helper, the sound goes straight to the
// speakers, like in any other browser
const DIRECT = process.env.BROWSER17_DIRECT_SOUND === "1";
if (!DIRECT) process.env.PULSE_SINK = SINK;
// programs this browser starts are not its sound
function ownEnv() {
  const env = Object.assign({}, process.env);
  env.PULSE_PROP = (env.PULSE_PROP || "").replace(MARK, "").trim();
  if (!env.PULSE_PROP) delete env.PULSE_PROP;
  if (env.PULSE_SINK === SINK) delete env.PULSE_SINK;
  return env;
}

// the browser's colors, as in Player-17 (#rrggbbaa = with opacity)
const DEFAULT_COLORS = {
  bg: "#000000", text: "#0a84ff", title: "#ffffff", lines: "#ff0080",
  glow_text: "#0a84ff00", glow_title: "#ffffff00", glow_lines: "#ff008000", frame: "#ff0080",
};

let settings = {};
let saveTimer = null;

function load() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")) || {}; } catch (e) { settings = {}; }
  settings.colors = Object.assign({}, DEFAULT_COLORS, settings.colors || {});
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = SETTINGS + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 1));
    fs.renameSync(tmp, SETTINGS);   // never a half-written file
  } catch (e) {
    console.error("[browser-17] settings:", e.message);
  }
}

function which(cmd) {
  try { return execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim() || null; }
  catch (e) { return null; }
}

const PLAYER = which("player-17");

// Player-17 by D-Bus: inside Flatpak the browser can't see player-17 on the PATH, but the player
// (its Flatpak or its .deb) is a D-Bus service the session bus starts on request.
const PLAYER_ID = "io.github.sfh17.Player-17";
const PLAYER_PATH = "/io/github/sfh17/Player_17";
function gdbus(args) {
  return execFileSync("gdbus", ["call", "--session"].concat(args), { encoding: "utf8", timeout: 3000 });
}
function playerOnBus() {
  try {
    const bus = ["--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method"];
    return gdbus(bus.concat("org.freedesktop.DBus.ListActivatableNames")).includes(`'${PLAYER_ID}'`) ||
      gdbus(bus.concat("org.freedesktop.DBus.NameHasOwner", PLAYER_ID)).includes("true");
  } catch (e) { return false; }
}
const PLAYER_BUS = !PLAYER && playerOnBus();

function openPlayer() {
  if (PLAYER) {
    try { spawn(PLAYER, [], { detached: true, stdio: "ignore", env: ownEnv() }).unref(); } catch (e) {}
  } else {
    // org.freedesktop.Application.Activate: starts it if it isn't running, or shows its window
    const p = spawn("gdbus", ["call", "--session", "--dest", PLAYER_ID, "--object-path", PLAYER_PATH,
      "--method", "org.freedesktop.Application.Activate", "{}"], { stdio: "ignore" });
    p.on("error", () => {});
  }
}

// The sound chain's sample rate: "auto" (as the output device) or one of these.
const RATES = ["auto", "44100", "48000", "96000"];
function sampleRate() {
  const r = String(settings.sample_rate || "auto");
  return RATES.includes(r) ? r : "auto";
}

/** What the page gets at start (the same names as from the player, plus a few of its own). */
function init() {
  load();
  const s = settings;
  const openTabs = Array.isArray(s.open_tabs) ? s.open_tabs : [];
  delete s.open_tabs;   // used once (after a restart)
  saveSoon();
  return {
    standalone: true,
    has_player: !!PLAYER || PLAYER_BUS,
    colors: s.colors,
    frame: s.frame !== false,
    volume: typeof s.volume === "number" ? s.volume : 1,
    route: true,                    // the helper tells later if the sound route works
    pinned: s.pinned, sites: s.sites, pinned_tabs: s.pinned_tabs, open_tabs: openTabs,
    engine: s.engine, tabs_shown: s.tabs_shown, one_player: s.one_player,
    links_new_tab: s.links_new_tab, site_theme: s.site_theme,
    download_dir: s.download_dir,
    sample_rate: sampleRate(),
    about: {   // Preferences → About Browser-17
      version: (() => { try { return require("./package.json").version; } catch (e) { return ""; } })(),
      electron: process.versions.electron, chrome: process.versions.chrome,
    },
  };
}

// ---------------- the sound helper ----------------
let helper = null;
let helperBuf = "";
let helperStarts = [];
let toPage = () => {};
let quitting = false;

// "Browser-17-Sound" in System Monitor instead of "python3": Linux names a process after the
// file it started, so python3 is started through a link with that name, kept in the user's
// own runtime folder (private to him). If the link can't be made, plain python3 it is.
function namedPython(python) {
  try {
    const real = python.includes("/") ? python : which(python);
    if (!real) return python;
    const dir = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache"), "browser-17");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const link = path.join(dir, "Browser-17-Sound");
    try { fs.unlinkSync(link); } catch (e) {}
    fs.symlinkSync(real, link);
    return link;
  } catch (e) { return python; }
}

function helperPath() {
  const candidates = [
    process.env.BROWSER17_HOST || "",                            // (for testing)
    path.join(__dirname, "..", "sound", "browser17host.py"),    // from the source folder
    "/usr/lib/browser-17/sound/browser17host.py",               // installed
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[1];
}

/** The sound host is gone (crashed, or the browser closes without it): its virtual output
 *  browser17_web is removed, so the browser's sound goes straight back to the speakers instead
 *  of into an output nobody reads (that was the "no sound at all"). The host makes it again
 *  when it starts. */
function freeSound() {
  try {
    const mods = execFileSync("pactl", ["list", "short", "modules"],
      { encoding: "utf8", timeout: 3000, env: Object.assign({}, process.env, { LC_ALL: "C" }) });
    for (const line of mods.split("\n")) {
      const [id, name, args] = line.split("\t");
      if (name === "module-null-sink" && /(^|\s)sink_name=browser17_web(\s|$)/.test(args || "")) {
        execFileSync("pactl", ["unload-module", id], { timeout: 3000 });
        console.error("[browser-17] the sound host is gone: browser17_web removed, sound goes to the speakers");
      }
    }
  } catch (e) { /* no pactl: nothing was moved either */ }
}

function toHelper(cmd) {
  if (!helper || !helper.stdin.writable) return;
  try { helper.stdin.write(JSON.stringify(cmd) + "\n"); } catch (e) {}
}

function startHelper() {
  if (quitting) return;
  if (DIRECT) {
    freeSound();
    toPage("cmd", { cmd: "sound", ok: false, text: "Test mode: sound straight to the speakers, no Plugins" });
    return;
  }
  const now = Date.now();
  helperStarts = helperStarts.filter((t) => now - t < 60000);
  if (helperStarts.length >= 3) {
    freeSound();
    toPage("cmd", { cmd: "sound", ok: false, text: "The sound helper keeps stopping — the browser plays without Plugins" });
    return;
  }
  helperStarts.push(now);
  // the helper's own output must NOT carry the mark (it would be pulled back into the browser's
  // virtual output: an endless loop)
  const env = Object.assign(ownEnv(), { BROWSER17_MAIN_PID: String(process.pid),
    BROWSER17_RATE: sampleRate() });
  // the system python (GTK, GStreamer and the player's packages are there), not -I: pedalboard
  // for VST3 may sit in the user's own packages
  const python = namedPython(fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : (which("python3") || "python3"));
  try {
    helper = spawn(python, [helperPath()], { env, stdio: ["pipe", "pipe", "inherit"] });
  } catch (e) {
    helper = null;
    freeSound();   // its output must not stay: the browser's sound would go into it, unheard
    toPage("cmd", { cmd: "sound", ok: false, text: "No python3: the browser plays without Plugins" });
    return;
  }
  const me = helper;
  helperBuf = "";
  me.stdout.setEncoding("utf8");
  me.stdout.on("data", (chunk) => {
    helperBuf += chunk;
    let i;
    while ((i = helperBuf.indexOf("\n")) >= 0) {
      const line = helperBuf.slice(0, i);
      helperBuf = helperBuf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      if (ev.ev === "status") toPage("cmd", { cmd: "sound", ok: !!ev.ok, text: ev.text || "" });
      else if (ev.page) {
        toPage("cmd", ev.page);
        if (ev.page.cmd === "rate") {   // chosen in the Plugins window: kept for the next start
          settings.sample_rate = RATES.includes(String(ev.page.value)) ? String(ev.page.value) : "auto";
          saveSoon();
        }
        if (ev.keep === "colors" && ev.page.colors) {   // the colors of the next start (no flash)
          settings.colors = Object.assign({}, DEFAULT_COLORS, ev.page.colors);
          if (ev.page.frame !== undefined) settings.frame = !!ev.page.frame;
          saveSoon();
        }
      }
    }
  });
  // the host starts with the page's volume (the same slider)
  toHelper({ ev: "volume", value: typeof settings.volume === "number" ? settings.volume : 1 });
  me.on("exit", (code) => {
    if (helper === me) helper = null;
    freeSound();   // never leave the browser's sound in an output nobody reads
    if (!quitting) {
      console.error(`[browser-17] the sound host stopped (${code}), starting it again`);
      setTimeout(startHelper, 1500);
    }
  });
  me.stdin.on("error", () => {});
}

/** The page's events (the same ones the player gets). */
function handle(ev, ctx) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.ev) {
    case "set": {
      const key = String(ev.key || "").replace(/^web_/, "");
      if (!key) return;
      if (ev.value === null || ev.value === undefined) delete settings[key];
      else settings[key] = ev.value;
      saveSoon();
      break;
    }
    case "volume":
      settings.volume = Math.max(0, Math.min(1, Number(ev.value) || 0));
      saveSoon();
      toHelper(ev);
      break;
    case "rate":   // the sample rate from the menu: kept, and the sound host rebuilds its path
      settings.sample_rate = RATES.includes(String(ev.value)) ? String(ev.value) : "auto";
      saveSoon();
      toHelper({ ev: "rate", value: settings.sample_rate });
      break;
    case "playing": case "title": case "plugins": case "colors-open":
      toHelper(ev);   // the sound host: the same handling as in Player-17
      break;
    case "goto":
      // Player-17 has no command-line options yet: it simply opens (music, video and radio are inside)
      openPlayer();
      break;
    case "restart":  // the window is made again (keeps the open tabs)
      settings.open_tabs = Array.isArray(ev.tabs) ? ev.tabs : [];
      saveNow();
      ctx.relaunch();
      break;
    default:
      break;   // playing, title, visible, closed: nothing to do without the player
  }
}

function attach(opts) {
  toPage = opts.toPage;
  startHelper();
  // the engine (Electron): a newer one of the same major version is fetched in the background
  // (not in Flatpak: there the engine is part of the package and comes with its updates)
  if (process.env.FLATPAK_ID) return;
  const engine = require("./engine.js");
  engine.start(settings, (text) => toPage("cmd", { cmd: "notice", text }));
  // still running after 20 s with the window up: this engine is good (the launcher keeps it)
  setTimeout(() => engine.markGood(), 20000);
}

function shutdown() {
  quitting = true;
  saveNow();
  if (helper) {
    toHelper({ ev: "quit" });
    const h = helper;
    setTimeout(() => { try { h.kill(); } catch (e) {} }, 800);
  } else {
    freeSound();   // the host was already gone: clean up its output now
  }
}

module.exports = { init, handle, attach, shutdown, saveNow };
