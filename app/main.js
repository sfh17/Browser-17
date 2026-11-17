// Browser-17 on Electron: the main process. One code for two ways of running:
//  - inside Player-17: started by the player, talks to it through stdin / stdout, one JSON object
//    per line (the same commands and events as the other engines);
//  - on its own (Browser-17): standalone.js keeps the settings and runs the sound helper.
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, session, shell, webContents } = require("electron");
// (the "screen" module may be touched only after the app is ready: taken where it is used)
const screen = () => require("electron").screen;
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

// Only the browser's own page (header, tabs, menus) may talk to the main process. Sites live in
// <webview>s without the bridge, but this is checked anyway: a message from anywhere else is dropped.
{
  const fromUs = (e) => {
    try {
      return !!win && !win.isDestroyed() && e.sender === win.webContents &&
        (!e.senderFrame || e.senderFrame === win.webContents.mainFrame);
    } catch (err) { return false; }
  };
  const on = ipcMain.on.bind(ipcMain), handle = ipcMain.handle.bind(ipcMain);
  ipcMain.on = (ch, fn) => on(ch, (e, ...a) => {
    if (fromUs(e)) return fn(e, ...a);
    if (e.returnValue === undefined) e.returnValue = null;   // (a sendSync must still get an answer)
  });
  ipcMain.handle = (ch, fn) => handle(ch, (e, ...a) => (fromUs(e) ? fn(e, ...a) : Promise.reject(new Error("not allowed"))));
}

const STANDALONE = !process.env.PLAYER_BROWSER_INIT;
const host = STANDALONE ? require("./standalone.js") : null;   // sets the sound mark before Chromium starts
const INIT = STANDALONE ? host.init() : JSON.parse(process.env.PLAYER_BROWSER_INIT || "{}");
const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");
app.setPath("userData", path.join(DATA, STANDALONE ? "browser-17" : "player-17", "electron-web"));
if (STANDALONE) {
  app.setName("Browser-17");
  // one window: a second start shows the open one
  if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
}
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Smooth scrolling, and the graphics card for drawing pages. Chromium keeps a "blocklist" of Linux
// drivers (NVIDIA among them) and quietly falls back to drawing with the processor: scrolling and
// YouTube's moving pictures then step along at a low frame rate. PLAYER_BROWSER_GPU=0 player-17
// leaves all of this out (for testing).
app.commandLine.appendSwitch("enable-smooth-scrolling");
if (process.env.PLAYER_BROWSER_GPU !== "0") {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  // (no "zero-copy": with the NVIDIA driver it made the graphics part of Chromium crash after a
  // moment, and Chromium then went back to the processor for good)
}
// A plain Chrome name: some sites refuse browsers that call themselves Electron.
app.userAgentFallback = app.userAgentFallback.replace(/\s(?:player17-browser|browser-17|Browser-17|Electron)\/\S+/gi, "");
const CHROME_UA = app.userAgentFallback;
// Google refuses to sign in inside embedded browsers ("This browser may not be secure").
// Its sign-in pages get a Firefox name instead (the same trick qutebrowser uses), and the
// "client hints" that would still say "Chromium, embedded" are switched off.
const FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const isSignIn = (url) => {
  try { return new URL(url).hostname === "accounts.google.com"; } catch (e) { return false; }
};
app.commandLine.appendSwitch("disable-features", "UserAgentClientHint");

const THEMES = { auto: "system", dark: "dark", light: "light" };
nativeTheme.themeSource = THEMES[INIT.site_theme] || "system";

// EPIPE: the player's end of the pipe is already closed (the player quit or crashed while windows
// were closing). A write then fails LATER, as an "error" event, not inside the try below, and with
// nobody listening Electron showed "A JavaScript error occurred in the main process: write EPIPE"
// (seen on Ubuntu). Such errors are swallowed now: the player is gone, so the browser just closes.
let playerGone = false;
const isPipeError = (err) => !!err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED" ||
  err.code === "ECONNRESET" || /EPIPE|write after end/i.test(String(err.message || "")));
function lostPlayer() {
  if (playerGone) return;
  playerGone = true;
  setImmediate(() => { try { app.quit(); } catch (e) {} });
}
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => { if (!STANDALONE && isPipeError(err) && stream === process.stdout) lostPlayer(); });
}
process.on("uncaughtException", (err) => {
  if (isPipeError(err)) { lostPlayer(); return; }
  try { console.error("[browser]", err && err.stack ? err.stack : err); } catch (e) {}
});
process.on("unhandledRejection", (err) => {
  if (isPipeError(err)) return;
  try { console.error("[browser] (promise)", err && err.stack ? err.stack : err); } catch (e) {}
});

function send(event) {
  if (STANDALONE) {   // no player: the browser's own host takes the event
    host.handle(event, { relaunch: () => { app.relaunch(); app.exit(0); } });
    return;
  }
  if (playerGone || !process.stdout.writable) return;
  try {
    process.stdout.write(JSON.stringify(event) + "\n");
  } catch (e) {
    if (isPipeError(e)) lostPlayer();
  }
}

function downloadsDir() {
  const dir = INIT.download_dir;
  return dir && fs.existsSync(dir) ? dir : path.join(HOME, "Downloads");
}

// The Downloads list (the page shows it in its Downloads island): the last 100, kept between runs.
const downloads = {
  list: [],
  items: new Map(),   // id -> DownloadItem, while it goes
  timer: null,
  file: () => path.join(app.getPath("userData"), "downloads.json"),
  load() {
    try { this.list = JSON.parse(fs.readFileSync(this.file(), "utf8")).filter((d) => d && d.id); }
    catch (e) { this.list = []; }
    for (const d of this.list) if (d.state === "progressing" || d.state === "paused") d.state = "interrupted";
  },
  save() {
    try { fs.writeFileSync(this.file(), JSON.stringify(this.list.slice(0, 100))); } catch (e) {}
  },
  // to the page at most ~4 times a second; to the disk when something ends
  changed(now) {
    if (now) this.save();
    if (this.timer && !now) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; toPage("downloads", this.list); }, now ? 0 : 250);
  },
};
ipcMain.handle("dl-list", () => downloads.list);
// the memory of a tab's page process, in MB (shown on the tab's card)
ipcMain.handle("tab-mem", (_e, id) => {
  try {
    const pid = webContents.fromId(id).getOSProcessId();
    const m = app.getAppMetrics().find((p) => p.pid === pid);
    return m ? Math.round(m.memory.workingSetSize / 1024) : 0;
  } catch (e) { return 0; }
});
ipcMain.on("dl-do", (_e, a) => {
  if (!a) return;
  const d = downloads.list.find((x) => x.id === a.id);
  const item = a.id ? downloads.items.get(a.id) : null;
  if (a.act === "cancel" && item) item.cancel();
  else if (a.act === "pause" && item) item.pause();
  else if (a.act === "resume" && item && item.canResume()) item.resume();
  else if (a.act === "open" && d && fs.existsSync(d.file)) {
    // something that would RUN (a script, a launcher, a program): shown in its folder instead,
    // so it can't start from a click in the browser
    if (/\.(desktop|sh|bash|run|bin|appimage|py|pl|jar|exe|msi|bat|cmd|ps1|command)$/i.test(d.file)) shell.showItemInFolder(d.file);
    else shell.openPath(d.file);
  }
  else if (a.act === "show" && d) fs.existsSync(d.file) ? shell.showItemInFolder(d.file) : shell.openPath(path.dirname(d.file));
  else if (a.act === "remove" && d && !item) { downloads.list = downloads.list.filter((x) => x !== d); downloads.changed(true); }
  else if (a.act === "clear") { downloads.list = downloads.list.filter((x) => downloads.items.has(x.id)); downloads.changed(true); }
});

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

// ---------------- the window's size and place ----------------
// The first start: a compact window in the middle of the screen. After that the browser opens the
// size (and, where the system allows it, the place) it was closed with, maximized if it was.
// The first size stays well under 80% of the screen: GNOME maximizes any new window bigger than
// that by itself (on a laptop screen 1040x740 was already "almost the whole screen").
const WINDOW_STATE = () => path.join(app.getPath("userData"), "window-state.json");
const MIN_W = 480, MIN_H = 320;

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE(), "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch (e) { return null; }
}

function writeWindowState(state) {
  try {
    const file = WINDOW_STATE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(state));
    fs.renameSync(file + ".tmp", file);   // never a half-written file
  } catch (e) { /* not important enough to complain about */ }
}

/** The bounds for a new window: the saved ones when they still fit a screen, else compact. */
function startBounds() {
  const area = screen().getPrimaryDisplay().workArea;
  const compact = {
    width: Math.max(MIN_W, Math.min(1100, Math.round(area.width * 0.72))),
    height: Math.max(MIN_H, Math.min(720, Math.round(area.height * 0.75))),
  };
  const saved = readWindowState();
  if (!saved || !(saved.width >= MIN_W) || !(saved.height >= MIN_H)) {
    return { bounds: compact, maximized: false };
  }
  const bounds = { width: Math.round(saved.width), height: Math.round(saved.height) };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // only where a screen still is (a monitor unplugged since: the system places it)
    const shown = screen().getAllDisplays().some(({ workArea: a }) =>
      saved.x + 80 > a.x && saved.x < a.x + a.width - 80 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 60);
    if (shown) { bounds.x = Math.round(saved.x); bounds.y = Math.round(saved.y); }
  }
  // never bigger than the screen it opens on
  const on = bounds.x !== undefined ? screen().getDisplayMatching({ x: bounds.x, y: bounds.y, width: 1, height: 1 }).workArea : area;
  bounds.width = Math.min(bounds.width, on.width);
  bounds.height = Math.min(bounds.height, on.height);
  return { bounds, maximized: !!saved.maximized };
}

/** Keeps the window's size, place and "maximized" up to date (saved a moment after a change). */
function rememberWindow(w) {
  let timer = null;
  const save = () => {
    timer = null;
    if (!w || w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
    const b = w.getNormalBounds();   // the size it goes back to when unmaximized
    const state = { width: b.width, height: b.height, maximized: w.isMaximized() };
    // On Wayland (Ubuntu's default) programs do not know or choose their place: x / y are then
    // 0, 0 and only the size is kept; the system places the window.
    if (b.x || b.y) { state.x = b.x; state.y = b.y; }
    writeWindowState(state);
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(save, 500); };
  for (const name of ["resize", "move", "maximize", "unmaximize"]) w.on(name, soon);
  w.on("close", () => { clearTimeout(timer); save(); });
}

let win = null;
const toPage = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

// Every page (each tab is a <webview>): new windows open as tabs, our own start-page links are
// caught here, and the browser's shortcuts work even while a page has the keyboard.
const KEYS = new Set(["Ctrl+t", "Ctrl+w", "Ctrl+l", "Ctrl+r", "F5", "Alt+ArrowLeft", "Alt+ArrowRight",
  "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+PageDown", "Ctrl+PageUp", "Ctrl+j", "Ctrl+Shift+k"]);

// The browser's own addresses (https://player17.local/...) are commands. Any site could try to
// open them too, so each one is taken only from the page it belongs to:
//  - start-page tiles (save / remove / unpin): only from the start page;
//  - "Add to Browser-17": only from a Chrome Web Store page, for a Web Store link;
//  - "Translate this page": from any page (it only translates what you see).
const LOCAL = "https://player17.local/";
function localAllowed(url, from) {
  let u, f;
  try { u = new URL(url); } catch (e) { return false; }
  try { f = new URL(from || "about:blank"); } catch (e) { return false; }
  const start = f.protocol === "data:";
  const store = f.protocol === "https:" && (f.hostname === "chromewebstore.google.com" || (f.hostname === "chrome.google.com" && f.pathname.startsWith("/webstore")));
  if (["/save", "/remove", "/unpin"].includes(u.pathname)) return start;
  if (u.pathname === "/translate-page") return true;
  if (u.pathname === "/ext-install") {
    let t;
    try { t = new URL(u.searchParams.get("url") || ""); } catch (e) { return false; }
    return store && t.protocol === "https:" && (t.hostname === "chromewebstore.google.com" || t.hostname === "chrome.google.com");
  }
  return false;
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    // empty pop-ups (ads, trackers) are dropped; real links open as a tab
    if (url && url.startsWith(LOCAL)) { if (localAllowed(url, contents.getURL())) toPage("open-tab", url); }
    else if (url && url !== "about:blank" && !url.startsWith("javascript:")) toPage("open-tab", url);
    return { action: "deny" };
  });
  // the page itself also says "Firefox" on Google's sign-in page (navigator.userAgent)
  // A new name counts only from the next page load, so the very first visit to the sign-in page
  // still looked like Chrome (and Google let you in only after a few tries). Now that first
  // visit is loaded once more, right away, already as Firefox.
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame === false || details.isSameDocument) return;
    const signIn = isSignIn(details.url);
    const want = signIn ? FIREFOX_UA : CHROME_UA;
    if (contents.getUserAgent() === want) return;
    contents.setUserAgent(want);
    if (signIn) setImmediate(() => contents.loadURL(details.url, { userAgent: FIREFOX_UA }).catch(() => {}));
  });
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith(LOCAL)) {
      event.preventDefault();
      if (localAllowed(url, contents.getURL())) toPage("local", url);
    }
  });
  // Right click in a page: the browser's own menu (an island, like its other menus) with Copy,
  // Paste, links, pictures... The page sends what was under the mouse; the menu is drawn by
  // the browser's page and its choice comes back as "ctx-do".
  contents.on("context-menu", (_event, p) => {
    const nav = contents.navigationHistory;
    const can = (what) => {
      try { return nav ? nav[what]() : contents[what](); } catch (e) { return false; }
    };
    toPage("ctx", {
      id: contents.id, x: p.x, y: p.y,
      link: /^(https?|ftp|mailto):/i.test(p.linkURL || "") ? p.linkURL : "",
      src: p.mediaType === "image" && p.srcURL ? p.srcURL : "",
      media: p.mediaType || "none",
      text: String(p.selectionText || "").trim(),
      editable: !!p.isEditable, flags: p.editFlags || {},
      misspelled: p.misspelledWord || "", suggestions: (p.dictionarySuggestions || []).slice(0, 5),
      back: can("canGoBack"), forward: can("canGoForward"), page: contents.getURL(),
    });
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
    const combo = (input.control || input.meta ? "Ctrl+" : "") + (input.alt ? "Alt+" : "") +
      (input.shift ? "Shift+" : "") + key;
    if (KEYS.has(combo)) {
      event.preventDefault();
      toPage("key", combo);
    }
  });
});

// A <webview> is always a plain web page: no bridge, no Node, sandboxed, isolated. Even if
// something tried to make one with more, it is taken away here.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    if (!/^(https?:|data:text\/html|about:blank|chrome-extension:)/i.test(params.src || "about:blank")) event.preventDefault();
  });
});

// ---------------- site permissions ----------------
// Electron itself says yes to everything a site asks (camera, microphone, where you are,
// notifications, MIDI, USB…). Here: harmless things are allowed, the rest is asked once per
// site, and your answer is remembered (site-permissions.json).
const HARMLESS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock", "keyboardLock", "speaker-selection", "window-management"]);
const ASKED = { media: "use your camera or microphone", geolocation: "know where you are", notifications: "show notifications",
  midi: "use MIDI devices", midiSysex: "fully control MIDI devices", "display-capture": "record your screen",
  "clipboard-read": "read your clipboard", "idle-detection": "know when you're away", openExternal: "open another program",
  fileSystem: "save changes to files on your computer", "storage-access": "use its cookies inside other sites", "top-level-storage-access": "use its cookies inside other sites" };
const PERMS_FILE = () => path.join(app.getPath("userData"), "site-permissions.json");
let perms = null;
function permsLoad() {
  if (perms) return perms;
  try { perms = JSON.parse(fs.readFileSync(PERMS_FILE(), "utf8")) || {}; } catch (e) { perms = {}; }
  return perms;
}
function permsSave() { try { fs.writeFileSync(PERMS_FILE(), JSON.stringify(perms)); } catch (e) {} }
const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return ""; } };
const permKey = (perm, details) => perm === "media" && details && details.mediaTypes && details.mediaTypes.length
  ? "media:" + details.mediaTypes.slice().sort().join("+") : perm;

function guardPermissions(ses) {
  ses.setPermissionRequestHandler((wc, perm, callback, details) => {
    if (HARMLESS.has(perm)) return callback(true);
    const what = ASKED[perm];
    const origin = originOf((details && (details.requestingUrl || details.securityOrigin)) || (wc && wc.getURL()));
    if (!what || !origin || origin === "null") return callback(false);       // anything else: no
    const key = permKey(perm, details);
    const saved = (permsLoad()[origin] || {})[key];
    if (saved === true || saved === false) return callback(saved);
    let host = origin;
    try { host = new URL(origin).host; } catch (e) {}
    const media = perm === "media" && details && details.mediaTypes ? details.mediaTypes : [];
    const text = perm === "media"
      ? `${host} wants to use your ${media.includes("video") && media.includes("audio") ? "camera and microphone" : media.includes("video") ? "camera" : "microphone"}.`
      : `${host} wants to ${what}.`;
    const opts = { type: "question", buttons: ["Block", "Allow"], defaultId: 0, cancelId: 0, title: "Browser-17",
      message: text, checkboxLabel: "Remember for this site", checkboxChecked: true };
    const ask = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    ask.then(({ response, checkboxChecked }) => {
      const yes = response === 1;
      if (checkboxChecked) { (permsLoad()[origin] = permsLoad()[origin] || {})[key] = yes; permsSave(); }
      callback(yes);
    }).catch(() => callback(false));
  });
  // "is it allowed already?" (a site asking before it asks): only what is harmless or already allowed
  ses.setPermissionCheckHandler((wc, perm, origin, details) => {
    if (HARMLESS.has(perm)) return true;
    const o = originOf(origin || (details && details.requestingUrl) || "");
    const p = permsLoad()[o] || {};
    if (perm === "media") return Object.keys(p).some((k) => k.startsWith("media") && p[k] === true);
    return p[perm] === true;
  });
  // USB, serial, HID, Bluetooth devices: never handed to sites
  ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (e, _d, cb) => { e.preventDefault(); cb(""); });
  ses.on("select-serial-port", (e, _d, cb) => { e.preventDefault(); cb(""); });
  ses.on("select-usb-device", (e, _d, cb) => { e.preventDefault(); cb(""); });
}

app.whenReady().then(() => {
  guardPermissions(session.defaultSession);
  downloads.load();
  // Extensions (a trial): the switched-on ones are loaded into the pages' session
  require("./extensions.js").attach({ ipcMain, session, net, dialog, getWindow: () => win })
    .catch((e) => console.error("[extensions]", e.message));
  // the browser's own plugins (Translator 17)
  require("./plugins17.js").attach({ ipcMain, net });
  // Shield 17: ads, trackers and other sites' cookies (its settings are in Preferences)
  let shieldHeaders = () => {};
  try { shieldHeaders = require("./shield17.js").attach({ ipcMain, net, session, webContents }); }
  catch (e) { console.error("[shield17]", e.message); }
  // every request to the sign-in page carries the Firefox name (also the first one)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (isSignIn(details.url)) {
      headers["User-Agent"] = FIREFOX_UA;
      for (const key of Object.keys(headers)) if (/^sec-ch-ua/i.test(key)) delete headers[key];
    }
    try { shieldHeaders(details, headers); } catch (e) {}
    callback({ requestHeaders: headers });
  });
  session.defaultSession.on("will-download", (_event, item) => {
    const dir = downloadsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, uniqueName(dir, item.getFilename()));
    item.setSavePath(file);
    const tell = (state) => toPage("download", { name: path.basename(file), file, state });
    tell("started");
    // the Downloads list: progress while it goes, then completed / cancelled / interrupted
    const d = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: path.basename(file),
      file, url: item.getURL(), state: "progressing", received: 0, total: item.getTotalBytes(), t: Date.now() };
    downloads.list.unshift(d);
    downloads.items.set(d.id, item);
    downloads.changed();
    item.on("updated", (_e, state) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.state = state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing";
      downloads.changed();
    });
    item.once("done", (_e, state) => {
      tell(state);
      d.received = item.getReceivedBytes();
      d.state = state;
      downloads.items.delete(d.id);
      downloads.changed(true);
    });
  });

  // Transparency, like the player: a Background with opacity below 100% makes the window
  // see-through. Electron decides this only when the window is made, so a change between solid
  // and see-through restarts the browser (the player asks for it; the tabs open again).
  // The window is always see-through: the browser draws its own window with the same round
  // corners as the player's (and the Background's opacity simply shows through it).
  const TRANSPARENT = true;
  INIT.transparent = TRANSPARENT;
  const bg = String((INIT.colors || {}).bg || "#000000").slice(0, 7);
  const start = startBounds();
  win = new BrowserWindow({
    ...start.bounds, minWidth: MIN_W, minHeight: MIN_H,
    frame: false, show: false, title: STANDALONE ? "Browser-17" : "Player-17 Browser",
    transparent: TRANSPARENT, backgroundColor: TRANSPARENT ? "#00000000" : bg,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), webviewTag: true },
  });
  win.setMenu(null);
  rememberWindow(win);
  win.loadFile(path.join(__dirname, "index.html"));
  // (maximize() also shows the window: done only once the page is ready, no empty frame first)
  win.once("ready-to-show", () => { if (start.maximized) win.maximize(); win.show(); });
  // A right click on the header or the tab bar (the "drag the window" areas) asked the system for
  // its window menu. With no frame there is nothing to show it on, but GNOME still took the mouse:
  // the browser looked frozen until Super was pressed. That menu is switched off.
  win.on("system-context-menu", (event) => event.preventDefault());
  const tellMaxed = () => toPage("maxed", !!win && (win.isMaximized() || win.isFullScreen()));
  for (const name of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) win.on(name, tellMaxed);
  win.webContents.on("did-finish-load", tellMaxed);
  win.on("show", () => send({ ev: "visible", on: true }));
  win.on("hide", () => send({ ev: "visible", on: false }));
  win.on("closed", () => {
    win = null;
    send({ ev: "closed" });
    if (STANDALONE) host.shutdown();
    app.quit();
  });

  if (STANDALONE) {
    host.attach({ toPage });
    return;   // no player to listen to
  }

  // the player's commands
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (!win) return;
    if (cmd.cmd === "show") {
      win.show();
      win.focus();
    } else if (cmd.cmd === "hide") {
      win.hide();
    } else if (cmd.cmd === "toggle") {
      if (win.isVisible()) win.hide();
      else {
        win.show();
        win.focus();
      }
    } else if (cmd.cmd === "quit") {
      app.quit();
    } else {
      toPage("cmd", cmd);
    }
  });
  input.on("close", lostPlayer); // the player is gone
  process.stdin.on("error", lostPlayer);
});

// Notebook 17: notes and passwords (encrypted; the key is in the system keyring)
require("./notebook.js").attach(ipcMain, clipboard);

ipcMain.on("init", (event) => {
  event.returnValue = INIT;
});
ipcMain.on("to-player", (_event, ev) => {
  if (ev && ev.ev === "set" && ev.key === "web_site_theme") nativeTheme.themeSource = THEMES[ev.value] || "system";
  send(ev);
});
// a choice from the right-click menu: done in that page (or, with no id, in the browser's own page:
// the address field)
ipcMain.on("ctx-do", (event, d) => {
  if (!d || typeof d !== "object") return;
  const wc = d.id ? webContents.fromId(d.id) : event.sender;
  if (!wc || wc.isDestroyed()) return;
  const EDIT = ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "delete"];
  if (EDIT.includes(d.act)) wc[d.act]();
  else if (d.act === "copy-text" && typeof d.text === "string") clipboard.writeText(d.text);
  else if (d.act === "copy-image") wc.copyImageAt(Math.round(d.x), Math.round(d.y));
  else if (d.act === "save" && /^(https?|data|blob):/i.test(d.url || "")) wc.downloadURL(d.url);
  else if (d.act === "replace" && typeof d.word === "string") wc.replaceMisspelling(d.word);
});
ipcMain.on("win", (_event, what) => {
  if (!win) return;
  if (what.action === "close") win.close();
  else if (what.action === "min") win.minimize();
  else if (what.action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (what.action === "downloads") shell.openPath(downloadsDir());
  else if (what.action === "show-file" && what.file) shell.showItemInFolder(what.file);
});

app.on("window-all-closed", () => app.quit());
