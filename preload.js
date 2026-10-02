'use strict';
// Exposes a small, fixed set of desktop features to the page (window.presenterDesktop).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenterDesktop', {
  getVersion: () => ipcRenderer.invoke('presenter:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('presenter:checkForUpdates'),
  setBgMode: (mode) => ipcRenderer.invoke('presenter:setBgMode', mode),
  ai: {
    keyStatus: () => ipcRenderer.invoke('presenter:ai:keyStatus'),
    setKey: (key) => ipcRenderer.invoke('presenter:ai:setKey', key),
    lyrics: (query, ctx) => ipcRenderer.invoke('presenter:ai:lyrics', query, ctx),
    detect: (wavBase64, ctx) => ipcRenderer.invoke('presenter:ai:detect', wavBase64, ctx)
  }
});
