import path from 'path';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_TERMINAL_ID,
} from '@jingles/shared';
import {
  bootstrapPOS,
  buildLocalZReport,
  closeLocalShift,
  createLocalReturn,
  createLocalSale,
  getActiveLocalShift,
  getLocalSale,
  getSyncStatus,
  listHeldSales,
  listLocalSales,
  openLocalShift,
  recallHeldSale,
  saveHeldSale,
  searchLocalProducts,
} from './offline/localDB';
import { syncPlaybackLog } from './offline/syncService';

let mainWindow: BrowserWindow | null = null;

function resolveRendererTarget() {
  if (process.env.NODE_ENV === 'development') {
    return {
      type: 'url' as const,
      value: process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173',
    };
  }

  return {
    type: 'file' as const,
    value: app.isPackaged
      ? path.join(process.resourcesPath, 'web', 'dist', 'index.html')
      : path.join(__dirname, '../../web/dist/index.html'),
  };
}

function emitSyncStatus() {
  const payload = getSyncStatus(DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID);
  mainWindow?.webContents.send('pos:sync-status', payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: '#e6e2f0',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const rendererTarget = resolveRendererTarget();
  if (rendererTarget.type === 'url') {
    mainWindow.loadURL(rendererTarget.value);
  } else {
    mainWindow.loadFile(rendererTarget.value);
  }
}

app.whenReady().then(() => {
  createWindow();
  emitSyncStatus();

  setInterval(async () => {
    try {
      await syncPlaybackLog({ deviceId: DEFAULT_DEVICE_ID, terminalId: DEFAULT_TERMINAL_ID });
    } finally {
      emitSyncStatus();
    }
  }, 20_000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('pos:bootstrap', (_event, options?: { deviceId?: string; terminalId?: string }) =>
  bootstrapPOS(options));

ipcMain.handle('pos:searchProducts', (_event, query: string) =>
  searchLocalProducts(query));

ipcMain.handle('pos:getShift', (_event, terminalId: string) =>
  getActiveLocalShift(terminalId) ?? null);

ipcMain.handle('pos:openShift', (_event, input: any) => {
  const result = openLocalShift(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:closeShift', (_event, input: any) => {
  const result = closeLocalShift(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:saveHeldSale', (_event, input: any) => {
  const result = saveHeldSale(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:listHeldSales', () => listHeldSales());

ipcMain.handle('pos:recallHeldSale', (_event, heldSaleId: string) => {
  const result = recallHeldSale(heldSaleId);
  emitSyncStatus();
  return result ?? null;
});

ipcMain.handle('pos:createSale', (_event, input: any) => {
  const result = createLocalSale(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:listSales', () => listLocalSales());

ipcMain.handle('pos:getSale', (_event, saleId: string) =>
  getLocalSale(saleId) ?? null);

ipcMain.handle('pos:createReturn', (_event, input: any) => {
  const result = createLocalReturn(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:getZReport', (_event, shiftId: string) =>
  buildLocalZReport(shiftId));

ipcMain.handle('pos:getSyncStatus', () =>
  getSyncStatus(DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID));

ipcMain.handle('pos:syncNow', async () => {
  const result = await syncPlaybackLog({ deviceId: DEFAULT_DEVICE_ID, terminalId: DEFAULT_TERMINAL_ID });
  emitSyncStatus();
  return result;
});
