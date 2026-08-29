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

/**
 * The quick search overlay's own controls.
 *
 * Exposed to every window rather than to a second preload script: the overlay
 * is a normal page served by the same frontend, and a page that is not the
 * overlay simply never calls these. Nothing here reaches the cabinet — the
 * overlay talks to the API through the same proxy routes as the collection, so
 * the token still never leaves the server side.
 */
contextBridge.exposeInMainWorld("quickSearch", {
  /** Put the overlay away. Hidden rather than closed, so the next one is instant. */
  close() {
    return ipcRenderer.invoke("quick:close");
  },
  /** Hand a card to the main window and bring it forward. */
  openCard(id) {
    return ipcRenderer.invoke("quick:open-card", String(id));
  },
  /** Which accelerator actually got registered, or null when none did. */
  shortcut() {
    return ipcRenderer.invoke("quick:shortcut");
  },
});
