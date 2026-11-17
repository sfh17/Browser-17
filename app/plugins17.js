// The browser's own plugins ("Own plugins" in Extensions), shared by Browser-17 and the browser
// inside Player-17: their settings in $XDG_DATA_HOME/extensions-17/plugins17.json.
//  - Translator 17: a selected text → an island with its translation; a whole page → Google's
//    page translation. Text goes to Google Translate (as with Google's own extension).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const FILE = path.join(DATA, "extensions-17", "plugins17.json");
const DEFAULTS = { translate: { enabled: true, from: "auto", to: "ru", pageButton: "header" }, dark: { enabled: false, style: "dark" } };

function read() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (e) {}
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = Object.assign({}, DEFAULTS[k], s[k] || {});
  return out;
}
function write(s) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(s, null, 1));
  fs.renameSync(FILE + ".tmp", FILE);
}

// Google's free endpoint takes a few thousand characters at a time: longer text goes in pieces,
// cut after a sentence or a line where possible.
function pieces(text, max = 4000) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(". ", max) + 1);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

async function translate(net, text, to, from) {
  const lang = /^[a-zA-Z-]{2,7}$/.test(to || "") ? to : "ru";
  const src = /^[a-zA-Z-]{2,7}$/.test(from || "") ? from : "auto";
  let result = "", detected = "";
  for (const part of pieces(text)) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(src)}&dt=t` +
      `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(part)}`;
    const res = await net.fetch(url);
    if (!res.ok) throw new Error("Google Translate answered " + res.status);
    const data = await res.json();
    result += (data[0] || []).map((s) => (s && s[0]) || "").join("");
    detected = detected || data[2] || "";
  }
  return { text: result, from: detected || src };
}

function attach({ ipcMain, net }) {
  ipcMain.handle("pl-get", () => read());
  ipcMain.handle("pl-set", (_e, id, patch) => {
    const s = read();
    if (s[id] && patch && typeof patch === "object") Object.assign(s[id], patch);
    write(s);
    return s;
  });
  ipcMain.handle("tr-text", async (_e, text, to, from) => {
    try { return Object.assign({ ok: true }, await translate(net, String(text || "").slice(0, 20000), to, from)); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
}

module.exports = { attach };
