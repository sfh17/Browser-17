// Shield 17: blocks ads and trackers, and the cookies other sites leave inside the one you visit.
// Shared by Browser-17 and the browser inside Player-17 (the same file in both).
//  - The lists of ad / tracker domains are downloaded (open lists, as used by uBlock & co.),
//    kept on the disk and updated once a week; they work offline from the copy.
//  - "Gentle" sites (banks, government): Shield steps aside there, so logins and payments work
//    (their anti-fraud checks often come from domains that tracker lists block).
//  - Sites switched off by the user: Shield does nothing there.
// Settings and lists: $XDG_DATA_HOME/extensions-17/shield17*.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "extensions-17");
const SETTINGS = path.join(DATA, "shield17.json");
const LIST = path.join(DATA, "shield17-domains.txt");
const META = path.join(DATA, "shield17-lists.json");
const SOURCES = [
  // Steven Black's unified hosts (ads + malware), MIT licence
  "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
  // Peter Lowe's ad and tracking server list
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext",
];
const WEEK = 7 * 24 * 3600 * 1000;

// Banks, payments and government sites of Armenia and Russia: Shield is gentle there by default.
const GENTLE = [
  "idram.am", "idbank.am", "evoca.am", "ameriabank.am", "inecobank.am", "acba.am", "ardshinbank.am", "vtb.am",
  "conversebank.am", "araratbank.am", "unibank.am", "aeb.am", "hsbc.am", "fastbank.am", "artsakhbank.am",
  "easypay.am", "telcell.am", "arca.am", "cba.am", "e-gov.am", "gov.am", "e-request.am", "taxservice.am",
  "tbank.ru", "tinkoff.ru", "sberbank.ru", "sber.ru", "vtb.ru", "alfabank.ru", "gazprombank.ru", "raiffeisen.ru",
  "pochtabank.ru", "open.ru", "sovcombank.ru", "psbank.ru", "rshb.ru", "mtsbank.ru", "ozonbank.ru",
  "gosuslugi.ru", "esia.gosuslugi.ru", "nalog.gov.ru", "mos.ru", "nspk.ru", "sbp.nspk.ru",
  "paypal.com", "stripe.com", "3dsecure.io",
];
const DEFAULTS = { enabled: true, ads: true, cookies: true, gentle: true, gentleSites: GENTLE, off: [] };

// Two-part endings that count as one (so "bank.com.am" is its own site, not "com.am")
const MULTI = new Set(["co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "co.kr",
  "co.nz", "co.za", "co.in", "com.br", "com.tr", "com.cn", "com.hk", "com.sg", "com.mx", "com.ar", "com.ua",
  "com.am", "co.am", "net.am", "org.am", "gov.am", "com.ru", "msk.ru", "spb.ru", "gov.ru", "com.ge", "com.kz"]);
function siteOf(host) {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  const p = host.split(".");
  if (p.length <= 2) return host;
  return MULTI.has(p.slice(-2).join(".")) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ""; } };
// "a.b.example.com" matches a rule for "example.com" (and any level between)
function inSet(host, set) {
  for (let h = host; h; ) {
    if (set.has(h)) return true;
    const i = h.indexOf(".");
    if (i < 0) return false;
    h = h.slice(i + 1);
  }
  return false;
}

let settings = null;
let domains = new Set();
let meta = { updated: 0, count: 0 };
let blocked = 0;          // blocked since the browser started
let updating = null;

function read() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")) || {}; } catch (e) {}
  settings = Object.assign({}, DEFAULTS, s);
  for (const k of ["gentleSites", "off"]) if (!Array.isArray(settings[k])) settings[k] = DEFAULTS[k].slice();
  return settings;
}
function write() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SETTINGS + ".tmp", JSON.stringify(settings, null, 1));
  fs.renameSync(SETTINGS + ".tmp", SETTINGS);
}
function loadList() {
  try {
    domains = new Set(fs.readFileSync(LIST, "utf8").split("\n").filter(Boolean));
    meta = JSON.parse(fs.readFileSync(META, "utf8")) || meta;
  } catch (e) { domains = new Set(); }
}
// one list text -> domains (hosts files "0.0.0.0 ads.example.com" and plain "ads.example.com")
const NOT = new Set(["localhost", "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-loopback", "0.0.0.0"]);
function parse(text, out) {
  for (let line of text.split("\n")) {
    line = line.replace(/#.*/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const name = (parts.length >= 2 && /^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0]) ? parts[1] : parts[0]).toLowerCase();
    if (!NOT.has(name) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) out.add(name);
  }
}
async function update(net) {
  if (updating) return updating;
  updating = (async () => {
    const all = new Set();
    let got = 0;
    for (const url of SOURCES) {
      try {
        const res = await net.fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        if (text.length > 64 * 1024 * 1024) throw new Error("too big");
        parse(text, all);
        got++;
      } catch (e) { console.error("[shield17] list:", url, e.message); }
    }
    if (!got || all.size < 1000) throw new Error("the lists could not be downloaded");
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(LIST + ".tmp", [...all].join("\n"));
    fs.renameSync(LIST + ".tmp", LIST);
    meta = { updated: Date.now(), count: all.size };
    fs.writeFileSync(META, JSON.stringify(meta));
    domains = all;
    return meta;
  })();
  try { return await updating; } finally { updating = null; }
}

// what applies on a page (its address): "off", "gentle" or "on"
function modeFor(pageUrl) {
  const s = settings || read();
  if (!s.enabled) return "off";
  const host = hostOf(pageUrl);
  if (!host || !/^https?:/i.test(pageUrl)) return "off";
  if (inSet(host, new Set(s.off))) return "off";
  if (s.gentle && inSet(host, new Set(s.gentleSites))) return "gentle";
  return "on";
}

function pageOf(details, webContents) {
  if (details.resourceType === "mainFrame") return details.url;
  try {
    const wc = details.webContentsId != null ? webContents.fromId(details.webContentsId) : null;
    if (wc && !wc.isDestroyed()) return wc.getURL();
  } catch (e) {}
  return details.referrer || "";
}
// Sites of one company that work as one (YouTube signs in through Google, and so on): between
// them nothing counts as "another site", so logins and players keep working.
const FAMILIES = [
  ["google.com", "youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "gstatic.com", "googleusercontent.com",
   "ggpht.com", "youtube-nocookie.com", "googleapis.com", "google.am", "google.ru"],
  ["yandex.ru", "yandex.com", "ya.ru", "yandex.net", "yastatic.net"],
  ["vk.com", "vk.ru", "userapi.com", "vkuser.net", "mycdn.me", "ok.ru"],
  ["mail.ru", "imgsmail.ru", "mradx.net"],
  ["microsoft.com", "live.com", "microsoftonline.com", "office.com", "msauth.net"],
  ["apple.com", "icloud.com", "apple-cloudkit.com", "mzstatic.com"],
];
const FAMILY = new Map();
FAMILIES.forEach((f, i) => f.forEach((site) => FAMILY.set(site, i)));
const partyOf = (site) => (FAMILY.has(site) ? "family:" + FAMILY.get(site) : site);
// a request to another site than the page's own
function thirdParty(details, page) {
  const a = siteOf(hostOf(details.url)), b = siteOf(hostOf(page));
  return !!a && !!b && partyOf(a) !== partyOf(b);
}

/** Wires Shield into a session. Returns the hook for the browser's own onBeforeSendHeaders. */
function attach({ ipcMain, net, session, webContents }) {
  read();
  loadList();
  const ses = session.defaultSession;

  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const s = settings;
      if (!s.enabled || !s.ads || !domains.size || details.resourceType === "mainFrame") return callback({});
      if (!/^(https?|wss?):/i.test(details.url)) return callback({});
      const page = pageOf(details, webContents);
      if (modeFor(page) !== "on" || !thirdParty(details, page)) return callback({});
      if (inSet(hostOf(details.url), domains)) { blocked++; return callback({ cancel: true }); }
    } catch (e) {}
    callback({});
  });
  // cookies set by other sites inside the page: not kept
  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      if (settings.enabled && settings.cookies && details.resourceType !== "mainFrame") {
        const page = pageOf(details, webContents);
        if (modeFor(page) === "on" && thirdParty(details, page)) {
          const headers = details.responseHeaders || {};
          let changed = false;
          for (const k of Object.keys(headers)) if (k.toLowerCase() === "set-cookie") { delete headers[k]; changed = true; }
          if (changed) return callback({ responseHeaders: headers });
        }
      }
    } catch (e) {}
    callback({});
  });

  // the settings for the Preferences island
  const state = () => ({ settings, count: meta.count || domains.size, updated: meta.updated || 0, blocked, updating: !!updating });
  ipcMain.handle("sh-get", () => state());
  ipcMain.handle("sh-set", (_e, patch) => {
    for (const k of ["enabled", "ads", "cookies", "gentle"]) if (patch && typeof patch[k] === "boolean") settings[k] = patch[k];
    write();
    return state();
  });
  // this site: Shield off / on again (by its site name, e.g. "example.com")
  ipcMain.handle("sh-site", (_e, pageUrl, off) => {
    const site = siteOf(hostOf(pageUrl));
    if (!site) return state();
    settings.off = settings.off.filter((x) => x !== site);
    if (off) settings.off.push(site);
    write();
    return state();
  });
  ipcMain.handle("sh-mode", (_e, pageUrl) => modeFor(pageUrl));
  ipcMain.handle("sh-update", async () => {
    try { await update(net); return { ok: true, ...state() }; }
    catch (e) { return { ok: false, error: e.message, ...state() }; }
  });

  // first start (no lists yet) or a week passed: update in the background, a bit after start
  if (!domains.size || Date.now() - (meta.updated || 0) > WEEK) {
    setTimeout(() => update(net).catch((e) => console.error("[shield17]", e.message)), domains.size ? 60000 : 5000);
  }

  // the browser's own header hook: a third-party request carries no cookies
  return function sendHeaders(details, headers) {
    if (!settings.enabled || !settings.cookies || details.resourceType === "mainFrame") return;
    const page = pageOf(details, webContents);
    if (modeFor(page) !== "on" || !thirdParty(details, page)) return;
    for (const k of Object.keys(headers)) if (k.toLowerCase() === "cookie") delete headers[k];
  };
}

module.exports = { attach, siteOf, modeFor };
