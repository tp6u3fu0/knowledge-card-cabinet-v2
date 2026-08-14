const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopStatus", {
  onChange(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:status", listener);
    return () => ipcRenderer.removeListener("desktop:status", listener);
  },
  retry() {
    return ipcRenderer.invoke("desktop:retry");
  },
  openDocs() {
    return ipcRenderer.invoke("desktop:open-docs");
  },
  dataDir() {
    return ipcRenderer.invoke("desktop:data-dir");
  },
  openDataDir() {
    return ipcRenderer.invoke("desktop:open-data-dir");
  },
});
