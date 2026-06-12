'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('newmile', {
  status: () => ipcRenderer.invoke('nm:status'),
  config: () => ipcRenderer.invoke('nm:config'),
  samsara: () => ipcRenderer.invoke('nm:samsara'),
  camera: (truckNum) => ipcRenderer.invoke('nm:camera', truckNum),
  logs: () => ipcRenderer.invoke('nm:logs'),
  connect: () => ipcRenderer.invoke('nm:connect'),
  resume: () => ipcRenderer.invoke('nm:resume'),
  disconnect: () => ipcRenderer.invoke('nm:disconnect'),
  refreshAll: (dateISO) => ipcRenderer.invoke('nm:refreshAll', dateISO),
  pullDay: (dateISO) => ipcRenderer.invoke('nm:pullDay', dateISO),
  orderAssignments: (orderId) => ipcRenderer.invoke('nm:orderAssignments', orderId),
  pushOrder: (payload) => ipcRenderer.invoke('nm:pushOrder', payload),
  onStatus: (cb) => ipcRenderer.on('nm:status', (_e, st) => cb(st)),
  onLog: (cb) => ipcRenderer.on('nm:log', (_e, line) => cb(line))
});
