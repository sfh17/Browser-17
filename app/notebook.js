// Notebook 17: notes and passwords, one encrypted file shared by Browser-17 and the browser
// inside Player-17 ($XDG_DATA_HOME/notebook-17/notebook.enc).
//  - the key lives in the system keyring (notebook-key.py, libsecret), never next to the file;
//  - the file is AES-256-GCM: {"v":1,"iv","tag","data"} (base64), written whole and atomically;
//  - a copied password leaves the clipboard after 30 s (if nothing else was copied meanwhile).
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { namedPython } = require("./procname.js");

const DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const DIR = path.join(DATA, "notebook-17");
const FILE = path.join(DIR, "notebook.enc");
const EMPTY = () => ({ v: 1, notes: [], logins: [] });

let key = null;   // Buffer, once read from the keyring

function getKey() {
  if (key) return Promise.resolve(key);
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "notebook-key.py");
    execFile(namedPython(), [script], { timeout: 60000 }, (err, out, errText) => {
      if (err) { reject(new Error("keyring: " + ((errText || "").trim() || err.message))); return; }
      const k = Buffer.from(String(out).trim(), "base64");
      if (k.length !== 32) { reject(new Error("keyring: bad key")); return; }
      key = k;
      resolve(k);
    });
  });
}

/** The old key of the first builds (see notebook-key.py "legacy"), or null. */
function legacyKey() {
  return new Promise((resolve) => {
    execFile(namedPython(), [path.join(__dirname, "notebook-key.py"), "legacy"], { timeout: 60000 }, (err, out) => {
      const k = err ? null : Buffer.from(String(out).trim(), "base64");
      resolve(k && k.length === 32 ? k : null);
    });
  });
}

function encrypt(obj, k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64") });
}

function decrypt(text, k) {
  const f = JSON.parse(text);
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64"));
  const out = Buffer.concat([d.update(Buffer.from(f.data, "base64")), d.final()]);
  return JSON.parse(out.toString("utf8"));
}

/** {ok, book} or {ok:false, error}. */
async function load() {
  try {
    const k = await getKey();
    if (!fs.existsSync(FILE)) return { ok: true, book: EMPTY() };
    const text = fs.readFileSync(FILE, "utf8");
    let book;
    try {
      book = decrypt(text, k);
    } catch (e) {
      // saved with the old key of a first build: opened with it, then saved again with the shared key
      const old = await legacyKey();
      try { book = decrypt(text, old || Buffer.alloc(32)); } catch (e2) { book = null; }
      if (!book) return { ok: false, error: "wrong-key" };
      await save(book);
    }
    if (!Array.isArray(book.notes)) book.notes = [];
    if (!Array.isArray(book.logins)) book.logins = [];
    return { ok: true, book };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function save(book) {
  try {
    const k = await getKey();
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, encrypt(book, k), { mode: 0o600 });
    fs.renameSync(tmp, FILE);   // never a half-written file
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** A notebook that no key opens: put aside (never deleted), a new one starts. */
function reset() {
  try {
    if (fs.existsSync(FILE)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(FILE, FILE + ".unreadable-" + stamp);
    }
    return { ok: true, book: EMPTY() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

let clearTimer = null;
function copy(clipboard, text, secret) {
  clipboard.writeText(String(text || ""));
  clearTimeout(clearTimer);
  if (secret) {
    clearTimer = setTimeout(() => {
      if (clipboard.readText() === String(text)) clipboard.writeText("");
    }, 30000);
  }
}

/** Wires the page's calls (preload: p17.nb). */
function attach(ipcMain, clipboard) {
  ipcMain.handle("nb-load", () => load());
  ipcMain.handle("nb-save", (_e, book) => save(book));
  ipcMain.handle("nb-reset", () => reset());
  ipcMain.on("nb-copy", (_e, d) => { if (d) copy(clipboard, d.text, !!d.secret); });
}

module.exports = { attach, load, save };
