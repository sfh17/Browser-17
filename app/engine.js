// Browser-17: the browser engine (Electron = Chromium) updates itself.
//
// - The package carries an Electron, so the browser works right after installing.
// - Once a day (and a minute after start) a newer Electron of the SAME major version is looked
//   for (39.1 -> 39.4: Chromium's security fixes). A new major version (39 -> 40) comes with our
//   own release, after testing: Electron sometimes changes what the browser stands on.
// - It is downloaded in the background, checked against Electron's own SHA-256 list, unpacked
//   into ~/.local/share/browser-17/engines/vX.Y.Z and used from the NEXT start.
// - The launcher (/usr/bin/browser-17) starts the newest engine marked good; a new engine that
//   never got to "good" (its window did not come up) is dropped and the previous one is used.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { namedPython } = require("./procname.js");

const DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const ENGINES = path.join(DATA, "browser-17", "engines");
const ARCH = { x64: "x64", arm64: "arm64", arm: "armv7l" }[process.arch] || "x64";
const DAY = 24 * 3600 * 1000;
const AGENT = "Browser-17 (engine update)";

const current = () => "v" + process.versions.electron;
const major = (v) => parseInt(String(v).replace(/^v/, ""), 10);
const parts = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
function newer(a, b) {   // a > b ?
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const stable = (v) => /^v?\d+\.\d+\.\d+$/.test(v);

/** fetch (follows GitHub's redirects by itself); a file is streamed to disk, not kept in memory. */
async function get(url, { asJson = false, toFile = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), toFile ? 15 * 60 * 1000 : 30000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": AGENT }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    if (toFile) {
      const { Readable } = require("stream");
      const { pipeline } = require("stream/promises");
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(toFile));
      return toFile;
    }
    return asJson ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Released (stable) Electron versions, newest first: three sources, the first that answers. */
async function releases() {
  if (process.env.BROWSER17_ENGINE_LIST) return process.env.BROWSER17_ENGINE_LIST.split(",");   // (for testing)
  const tries = [
    async () => (await get("https://releases.electronjs.org/releases.json", { asJson: true }))
      .map((r) => "v" + String(r.version || "").replace(/^v/, "")),
    async () => (await get("https://api.github.com/repos/electron/electron/releases?per_page=60", { asJson: true }))
      .filter((r) => !r.prerelease && !r.draft).map((r) => r.tag_name),
    async () => [...(await get("https://github.com/electron/electron/releases.atom"))
      .matchAll(/releases\/tag\/(v\d+\.\d+\.\d+)</g)].map((m) => m[1]),
  ];
  for (const t of tries) {
    try {
      const list = (await t()).filter(stable);
      if (list.length) return list;
    } catch (e) { /* the next source */ }
  }
  throw new Error("no release list (offline?)");
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

/** Unzip keeping the file modes (electron and chrome-sandbox must stay runnable). */
function unzip(zip, dir) {
  const code = "import sys, zipfile, os\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "for i in z.infolist():\n" +
    "    t = z.extract(i, sys.argv[2])\n" +
    "    m = (i.external_attr >> 16) & 0o755\n" +   // never writable by others
    "    if m and not i.is_dir(): os.chmod(t, m)\n";
  return new Promise((resolve, reject) =>
    execFile(namedPython(), ["-c", code, zip, dir], (err) => (err ? reject(err) : resolve())));
}

function installed() {
  try {
    return fs.readdirSync(ENGINES).filter((d) => stable(d) && fs.existsSync(path.join(ENGINES, d, "electron")));
  } catch (e) { return []; }
}

/** Keep the engine in use, the newest and one before it; the rest goes. */
function tidy(keep) {
  const list = installed().sort((a, b) => (newer(a, b) ? -1 : 1));
  const keepSet = new Set([...keep, ...list.slice(0, 2)]);
  for (const v of list) {
    if (!keepSet.has(v)) fs.rmSync(path.join(ENGINES, v), { recursive: true, force: true });
  }
}

let busy = false;

/** Look for a newer engine and get it ready for the next start. tell(text) shows a message. */
async function check(tell, { allMajors = false } = {}) {
  if (busy) return;
  busy = true;
  const tmpZip = path.join(ENGINES, ".download.zip");
  const tmpDir = path.join(ENGINES, ".unpack");
  try {
    const now = current();
    const have = installed().concat(now).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
    const best = (await releases()).filter((v) => allMajors || major(v) === major(now))
      .sort((a, b) => (newer(a, b) ? -1 : 1))[0];
    fs.mkdirSync(ENGINES, { recursive: true });
    fs.writeFileSync(path.join(ENGINES, ".checked"), String(Date.now()));
    if (!best || !newer(best, have)) return;

    const base = `https://github.com/electron/electron/releases/download/${best}`;
    const name = `electron-${best}-linux-${ARCH}.zip`;
    const sums = await get(`${base}/SHASUMS256.txt`);
    const line = sums.split("\n").find((l) => l.trim().endsWith("*" + name) || l.trim().endsWith(" " + name));
    if (!line) throw new Error(`no checksum for ${name}`);
    const want = line.trim().split(/\s+/)[0].toLowerCase();

    await get(`${base}/${name}`, { toFile: tmpZip });
    const got = await sha256(tmpZip);
    if (got !== want) throw new Error(`checksum mismatch for ${name}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    await unzip(tmpZip, tmpDir);
    if (!fs.existsSync(path.join(tmpDir, "electron"))) throw new Error("the archive has no electron");
    const target = path.join(ENGINES, best);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmpDir, target);
    fs.writeFileSync(path.join(ENGINES, "current"), best);   // the launcher tries it at the next start
    tidy([now.replace(/^v/, "v"), best]);
    tell(`Browser engine ${best} is ready — it is used from the next start`);
  } catch (e) {
    console.error("[browser-17] engine update:", e.message);
  } finally {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    busy = false;
  }
}

/** This engine started fine: the launcher may keep using it. */
function markGood() {
  const here = path.dirname(process.execPath);
  if (path.dirname(here) !== ENGINES) return;   // the packaged engine: nothing to mark
  try { fs.writeFileSync(path.join(here, ".ok"), String(Date.now())); } catch (e) {}
}

/** Start the daily checks. settings.engine_auto === false switches them off. */
function start(settings, tell) {
  if (settings.engine_auto === false) return;
  const opts = { allMajors: settings.engine_track === "latest" };
  let last = 0;
  try { last = Number(fs.readFileSync(path.join(ENGINES, ".checked"), "utf8")) || 0; } catch (e) {}
  const first = Date.now() - last > DAY ? 60 * 1000 : DAY - (Date.now() - last);
  setTimeout(function again() {
    check(tell, opts);
    setTimeout(again, DAY);
  }, Math.max(60 * 1000, first));
}

module.exports = { start, check, markGood, ENGINES };
