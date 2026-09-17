// The only bridge between the page and the shell: a folder chooser and a way
// to show a folder. Everything else the page needs comes from core over HTTP.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roster", {
  pickDirectory: (defaultPath) => ipcRenderer.invoke("roster:pickDirectory", defaultPath),
  revealDirectory: (dir) => ipcRenderer.invoke("roster:revealDirectory", dir),
});
