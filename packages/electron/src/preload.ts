import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('posAPI', {
  searchProducts: (q: string) => ipcRenderer.invoke('pos:searchProducts', q),
  scanBarcode: (barcode: string) => ipcRenderer.invoke('pos:scanBarcode', barcode),
  createSale: (input: any) => ipcRenderer.invoke('pos:createSale', input),
  getShift: (terminalId: string) => ipcRenderer.invoke('pos:getShift', terminalId),
  openShift: (data: any) => ipcRenderer.invoke('pos:openShift', data),
  closeShift: (shiftId: string, data: any) => ipcRenderer.invoke('pos:closeShift', shiftId, data),
  createReturn: (data: any) => ipcRenderer.invoke('pos:createReturn', data),
  listSales: () => ipcRenderer.invoke('pos:listSales'),
  getSyncQueue: () => ipcRenderer.invoke('pos:getSyncQueue'),
  syncNow: () => ipcRenderer.invoke('pos:syncNow'),
  upsertProduct: (product: any) => ipcRenderer.invoke('pos:upsertProduct', product),
  onSyncResult: (callback: (result: any) => void) =>
    ipcRenderer.on('sync-result', (_event, result) => callback(result)),
});
