// Extensions (a trial): Chrome extensions in the browser's pages, shared by Browser-17 and the
// browser inside Player-17 ($XDG_DATA_HOME/extensions-17/<id>/, the list in extensions.json).
//  - Electron runs a part of the Chrome extension API: what changes pages (content scripts,
//    storage, messages) mostly works; ad blockers on declarativeNetRequest don't;
//  - an extension's own window (its toolbar popup) is shown by the page in an island;
//  - from the Chrome Web Store: the .crx is downloaded, its header cut off, the zip unpacked
//    (python3 zipfile, paths checked); or a folder with a manifest.json is copied.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { namedPython } = require("./procname.js");

const DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const DIR = path.join(DATA, "extensions-17");
const LIST = path.join(DIR, "extensions.json");

let ses = null;
let state = {};          // id -> { enabled, from }
const loaded = new Map(); // id -> Electron extension id (the same as the folder name for store ones)

const api = () => ses.extensions || ses;   // newer Electron: session.extensions

function readState() {
  try { state = JSON.parse(fs.readFileSync(LIST, "utf8")) || {}; } catch (e) { state = {}; }
}
function writeState() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LIST + ".tmp", JSON.stringify(state, null, 1));
  fs.renameSync(LIST + ".tmp", LIST);
}

function manifestOf(id) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, id, "manifest.json"), "utf8")); } catch (e) { return null; }
}

// "__MSG_appName__" names: from _locales (en, or the default locale)
function localized(id, m, text) {
  const k = /^__MSG_(.+)__$/.exec(text || "");
  if (!k) return text || "";
  for (const loc of ["en", "en_US", m.default_locale].filter(Boolean)) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(DIR, id, "_locales", loc, "messages.json"), "utf8"));
      const hit = Object.keys(msgs).find((n) => n.toLowerCase() === k[1].toLowerCase());
      if (hit) return msgs[hit].message;
    } catch (e) {}
  }
  return k[1];
}

async function loadOne(id) {
  if (loaded.has(id)) return;
  try {
    const ext = await api().loadExtension(path.join(DIR, id), { allowFileAccess: true });
    loaded.set(id, ext.id);
  } catch (e) {
    console.error("[extensions] " + id + ":", e.message);
    state[id] = Object.assign(state[id] || {}, { error: String(e.message || e).slice(0, 200) });
  }
}

function unloadOne(id) {
  const eid = loaded.get(id);
  if (!eid) return;
  try { api().removeExtension(eid); } catch (e) {}
  loaded.delete(id);
}

/** What the page shows. */
function list() {
  return Object.keys(state).map((id) => {
    const m = manifestOf(id) || {};
    const action = m.action || m.browser_action || {};
    const icons = m.icons || {};
    const icon = icons["48"] || icons["32"] || icons["128"] || icons["16"] || "";
    const eid = loaded.get(id);
    return {
      id, name: localized(id, m, m.name) || id, version: m.version || "",
      description: localized(id, m, m.description || ""), enabled: !!state[id].enabled,
      error: state[id].error || "", mv: m.manifest_version || 2,
      popup: eid && action.default_popup ? `chrome-extension://${eid}/${action.default_popup.replace(/^\//, "")}` : "",
      options: eid && (m.options_ui || {}).page ? `chrome-extension://${eid}/${m.options_ui.page}` :
        eid && m.options_page ? `chrome-extension://${eid}/${m.options_page}` : "",
      icon: icon ? "data:image/png;base64," + safeRead(path.join(DIR, id, icon)) : "",
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function safeRead(file) {
  try { return fs.readFileSync(file).toString("base64"); } catch (e) { return ""; }
}

// ---- installing

// python3: unpack a zip into a folder, refusing paths that leave it
const UNZIP_PY = `
import sys, zipfile, os
src, dest = sys.argv[1], os.path.realpath(sys.argv[2])
with zipfile.ZipFile(src) as z:
    for n in z.namelist():
        p = os.path.realpath(os.path.join(dest, n))
        if not (p == dest or p.startswith(dest + os.sep)):
            sys.exit("bad path in the archive: " + n)
    z.extractall(dest)
`;

function unzip(zipFile, dest) {
  return new Promise((resolve, reject) => {
    execFile(namedPython(), ["-I", "-c", UNZIP_PY, zipFile, dest], { timeout: 120000 }, (err, _o, errText) => {
      if (err) reject(new Error((errText || "").trim() || err.message)); else resolve();
    });
  });
}

/** CRX2/CRX3 → the zip inside. */
function crxToZip(buf) {
  if (buf.slice(0, 4).toString("binary") === "PK\u0003\u0004") return buf;
  if (buf.slice(0, 4).toString("binary") !== "Cr24") throw new Error("not an extension file");
  const ver = buf.readUInt32LE(4);
  const start = ver === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  return crxToZip(buf.slice(start));   // (some CRX3 hold a CRX2)
}

/** A Chrome Web Store link (or a bare id) → the extension's id, or "". */
function storeId(text) {
  const m = /([a-p]{32})/.exec(String(text || ""));
  return m ? m[1] : "";
}

async function installFromStore(net, text, chromeVersion) {
  const id = storeId(text);
  if (!id) throw new Error("Not a Chrome Web Store link");
  const url = "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3" +
    `&prodversion=${encodeURIComponent(chromeVersion)}&x=id%3D${id}%26uc`;
  const res = await net.fetch(url);
  if (!res.ok) throw new Error("The store answered " + res.status);
  const zip = crxToZip(Buffer.from(await res.arrayBuffer()));
  return installZip(id, zip, "store");
}

async function installZip(id, zip, from) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmpZip = path.join(DIR, id + ".zip.tmp");
  const tmpDir = path.join(DIR, id + ".new");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.writeFileSync(tmpZip, zip);
  try {
    fs.mkdirSync(tmpDir);
    await unzip(tmpZip, tmpDir);
  } finally {
    fs.rmSync(tmpZip, { force: true });
  }
  if (!fs.existsSync(path.join(tmpDir, "manifest.json"))) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error("No manifest.json inside");
  }
  return putInPlace(id, tmpDir, from);
}

async function installFolder(folder) {
  const m = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  const id = "local-" + String(m.name || path.basename(folder)).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const tmpDir = path.join(DIR, id + ".new");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.cpSync(folder, tmpDir, { recursive: true });
  return putInPlace(id, tmpDir, "folder");
}

async function putInPlace(id, tmpDir, from) {
  unloadOne(id);
  const dest = path.join(DIR, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmpDir, dest);
  state[id] = { enabled: true, from };
  await loadOne(id);
  writeState();
  return id;
}

async function setEnabled(id, on) {
  if (!state[id]) return;
  state[id].enabled = !!on;
  delete state[id].error;
  if (on) await loadOne(id); else unloadOne(id);
  writeState();
}

function remove(id) {
  if (!state[id]) return;
  unloadOne(id);
  delete state[id];
  fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
  writeState();
}

/** Once the app is ready: loads the switched-on extensions, wires the page's calls. */
async function attach({ ipcMain, session, net, dialog, getWindow }) {
  ses = session.defaultSession;
  readState();
  for (const id of Object.keys(state)) {
    if (!fs.existsSync(path.join(DIR, id, "manifest.json"))) { delete state[id]; continue; }
    if (state[id].enabled) await loadOne(id);
  }
  const reply = async (fn) => {
    try { const r = await fn(); return { ok: true, list: list(), id: r }; }
    catch (e) { return { ok: false, error: String(e.message || e), list: list() }; }
  };
  ipcMain.handle("ext-list", () => list());
  ipcMain.handle("ext-store", (_e, text) => reply(() => installFromStore(net, text, process.versions.chrome)));
  ipcMain.handle("ext-folder", () => reply(async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: "A folder with an extension (manifest.json)", properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return "";
    return installFolder(r.filePaths[0]);
  }));
  ipcMain.handle("ext-enable", (_e, id, on) => reply(() => setEnabled(id, on)));
  ipcMain.handle("ext-remove", (_e, id) => reply(() => remove(id)));
}

module.exports = { attach, crxToZip, storeId };
