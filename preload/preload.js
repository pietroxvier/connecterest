"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lookbook", {
  niches: () => ipcRenderer.invoke("lookbook:niches"),
  feed: (nicheId) => ipcRenderer.invoke("lookbook:feed", nicheId),

  favorites: {
    list: () => ipcRenderer.invoke("lookbook:favorites:list"),
    add: (photo, niche) => ipcRenderer.invoke("lookbook:favorites:add", { photo, niche }),
    remove: (id) => ipcRenderer.invoke("lookbook:favorites:remove", id),
    restore: (entry) => ipcRenderer.invoke("lookbook:favorites:restore", entry),
    openFolder: () => ipcRenderer.invoke("lookbook:favorites:open"),
  },
});