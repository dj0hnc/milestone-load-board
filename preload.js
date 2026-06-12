'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('newmile', {
  status: () => ipcRenderer.invoke('nm:status'),
  config: () => ipcRenderer.invoke('nm:config'),
  getSettings: () => ipcRenderer.invoke('nm:getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('nm:saveSettings', s),
  samsara: () => ipcRenderer.invoke('nm:samsara'),
  camera: (truckNum) => ipcRenderer.invoke('nm:camera', truckNum),
  route: (payload) => ipcRenderer.invoke('nm:route', payload),
  directory: () => ipcRenderer.invoke('nm:directory'),
  setOnCall: (list) => ipcRenderer.invoke('nm:setOnCall', list),
  drivers: () => ipcRenderer.invoke('nm:drivers'),
  sendDriverMsg: (p) => ipcRenderer.invoke('nm:sendDriverMsg', p),
  deleteAssignments: (ids) => ipcRenderer.invoke('nm:deleteAssignments', ids),
  logs: () => ipcRenderer.invoke('nm:logs'),
  connect: () => ipcRenderer.invoke('nm:connect'),
  resume: () => ipcRenderer.invoke('nm:resume'),
  disconnect: () => ipcRenderer.invoke('nm:disconnect'),
  refreshAll: (dateISO) => ipcRenderer.invoke('nm:refreshAll', dateISO),
  pullDay: (dateISO) => ipcRenderer.invoke('nm:pullDay', dateISO),
  orderAssignments: (orderId) => ipcRenderer.invoke('nm:orderAssignments', orderId),
  pushOrder: (payload) => ipcRenderer.invoke('nm:pushOrder', payload),
  downloadUpdate: () => ipcRenderer.invoke('nm:downloadUpdate'),
  onUpdate: (cb) => ipcRenderer.on('nm:update', (_e, u) => cb(u)),
  onStatus: (cb) => ipcRenderer.on('nm:status', (_e, st) => cb(st)),
  onLog: (cb) => ipcRenderer.on('nm:log', (_e, line) => cb(line))
});
