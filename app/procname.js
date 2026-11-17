// "Browser-17" (not "python3") in System Monitor for the browser's small Python jobs (unpacking
// an extension or an engine update, the Notebook key): Linux names a process after the file it
// started, so python3 is started through a link called Browser-17, kept in the user's own
// runtime folder (private to him). If the link can't be made, plain python3 it is.
const fs = require("fs");
const os = require("os");
const path = require("path");

function findPython() {
  if (fs.existsSync("/usr/bin/python3")) return "/usr/bin/python3";
  for (const dir of (process.env.PATH || "").split(":")) {
    const p = path.join(dir || ".", "python3");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
  }
  return null;
}

function namedPython(name = "Browser-17") {
  try {
    const real = findPython();
    if (!real) return "python3";
    const dir = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache"), "browser-17");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const link = path.join(dir, name);
    let ok = false;
    try { ok = fs.readlinkSync(link) === real; } catch (e) {}
    if (!ok) {
      const tmp = link + ".new";
      try { fs.unlinkSync(tmp); } catch (e) {}
      fs.symlinkSync(real, tmp);
      fs.renameSync(tmp, link);
    }
    return link;
  } catch (e) { return "python3"; }
}

module.exports = { namedPython };
