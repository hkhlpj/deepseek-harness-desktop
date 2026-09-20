'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshSettings', {
  get: () => ipcRenderer.invoke('dsh:get-settings'),
  save: (next) => ipcRenderer.invoke('dsh:save-settings', next),
  pickBackground: () => ipcRenderer.invoke('dsh:pick-background'),
  apply: (next) => ipcRenderer.invoke('dsh:apply', next),
  close: () => ipcRenderer.invoke('dsh:close-settings'),
})
