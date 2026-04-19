const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("echo", {
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on("log", (_e, entry) => cb(entry)),
  quickOpen: (service) => ipcRenderer.invoke("quick-open", service),
  getInitialState: () => ipcRenderer.invoke("get-initial-state"),
});
