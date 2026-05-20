import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('posAPI', {
  bootstrap: (options?: { deviceId?: string; terminalId?: string }) => ipcRenderer.invoke('pos:bootstrap', options),
  searchProducts: (query: string) => ipcRenderer.invoke('pos:searchProducts', query),
  getShift: (terminalId: string) => ipcRenderer.invoke('pos:getShift', terminalId),
  openShift: (input: unknown) => ipcRenderer.invoke('pos:openShift', input),
  closeShift: (input: unknown) => ipcRenderer.invoke('pos:closeShift', input),
  saveHeldSale: (input: unknown) => ipcRenderer.invoke('pos:saveHeldSale', input),
  listHeldSales: () => ipcRenderer.invoke('pos:listHeldSales'),
  recallHeldSale: (heldSaleId: string) => ipcRenderer.invoke('pos:recallHeldSale', heldSaleId),
  createSale: (input: unknown) => ipcRenderer.invoke('pos:createSale', input),
  listSales: () => ipcRenderer.invoke('pos:listSales'),
  getSale: (saleId: string) => ipcRenderer.invoke('pos:getSale', saleId),
  createReturn: (input: unknown) => ipcRenderer.invoke('pos:createReturn', input),
  getZReport: (shiftId: string) => ipcRenderer.invoke('pos:getZReport', shiftId),
  getSyncStatus: () => ipcRenderer.invoke('pos:getSyncStatus'),
  syncNow: () => ipcRenderer.invoke('pos:syncNow'),
  onSyncStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('pos:sync-status', listener);
    return () => ipcRenderer.removeListener('pos:sync-status', listener);
  },
});
