// The only bridge between the page and the shell: a folder chooser, a way to
// show a folder, and the two halves of notifications the page has to take part
// in -- what is on screen, and where a click on one should land. Everything
// else the page needs comes from core over HTTP.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roster", {
  pickDirectory: (defaultPath) => ipcRenderer.invoke("roster:pickDirectory", defaultPath),
  revealDirectory: (dir) => ipcRenderer.invoke("roster:revealDirectory", dir),
  showing: (conversationId) => ipcRenderer.send("roster:showing", conversationId),
  onOpen: (fn) => {
    const relay = (_e, conversationId) => fn(conversationId);
    ipcRenderer.on("roster:open", relay);
    return () => ipcRenderer.off("roster:open", relay);
  },
});
