// The bridge between the browser's own page (header, tabs, menus) and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("p17", {
  init: () => ipcRenderer.sendSync("init"),
  send: (event) => ipcRenderer.send("to-player", event),
  win: (what) => ipcRenderer.send("win", what),
  ctx: (what) => ipcRenderer.send("ctx-do", what),
  mem: (id) => ipcRenderer.invoke("tab-mem", id),   // a tab's memory, MB (its page process)
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
  // the browser's own plugins (Translator 17)
  pl: {
    get: () => ipcRenderer.invoke("pl-get"),
    set: (id, patch) => ipcRenderer.invoke("pl-set", id, patch),
    translate: (text, to, from) => ipcRenderer.invoke("tr-text", text, to, from),
  },
  // Extensions (a trial)
  ext: {
    list: () => ipcRenderer.invoke("ext-list"),
    store: (link) => ipcRenderer.invoke("ext-store", link),
    folder: () => ipcRenderer.invoke("ext-folder"),
    enable: (id, on) => ipcRenderer.invoke("ext-enable", id, on),
    remove: (id) => ipcRenderer.invoke("ext-remove", id),
  },
  // Shield 17 (Preferences)
  sh: {
    get: () => ipcRenderer.invoke("sh-get"),
    set: (patch) => ipcRenderer.invoke("sh-set", patch),
    site: (url, off) => ipcRenderer.invoke("sh-site", url, off),
    mode: (url) => ipcRenderer.invoke("sh-mode", url),
    update: () => ipcRenderer.invoke("sh-update"),
  },
  // the Downloads list
  dl: {
    list: () => ipcRenderer.invoke("dl-list"),
    act: (act, id) => ipcRenderer.send("dl-do", { act, id }),
  },
  // Notebook 17
  nb: {
    load: () => ipcRenderer.invoke("nb-load"),
    save: (book) => ipcRenderer.invoke("nb-save", book),
    reset: () => ipcRenderer.invoke("nb-reset"),
    copy: (text, secret) => ipcRenderer.send("nb-copy", { text, secret }),
  },
});
