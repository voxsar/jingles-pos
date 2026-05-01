import path from 'path';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  getDB,
  openLocalShift,
  closeLocalShift,
  getActiveLocalShift,
  createLocalSale,
  getLocalSale,
  listLocalSales,
  createLocalReturn,
  getPendingSyncOps,
  searchLocalProducts,
  getLocalProductByBarcode,
  upsertProduct,
} from './offline/localDB';
import { syncPendingOperations } from './offline/syncService';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../web/dist/index.html'));
  }

  getDB();
}

app.whenReady().then(() => {
  createWindow();

  // Auto-sync every 30 seconds
  setInterval(async () => {
    try {
      const result = await syncPendingOperations();
      if (result.synced > 0 || result.failed > 0) {
        mainWindow?.webContents.send('sync-result', result);
      }
    } catch {
      // Network unavailable, will retry
    }
  }, 30_000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.handle('pos:searchProducts', (_event, query: string) =>
  searchLocalProducts(query)
);

ipcMain.handle('pos:scanBarcode', (_event, barcode: string) =>
  getLocalProductByBarcode(barcode) ?? null
);

ipcMain.handle('pos:createSale', (_event, input: any) =>
  createLocalSale(input)
);

ipcMain.handle('pos:getShift', (_event, terminalId: string) =>
  getActiveLocalShift(terminalId) ?? null
);

ipcMain.handle('pos:openShift', (_event, data: any) =>
  openLocalShift(data)
);

ipcMain.handle('pos:closeShift', (_event, shiftId: string, data: any) =>
  closeLocalShift(shiftId, data)
);

ipcMain.handle('pos:createReturn', (_event, data: any) =>
  createLocalReturn(data)
);

ipcMain.handle('pos:listSales', () => listLocalSales());

ipcMain.handle('pos:getSyncQueue', () => getPendingSyncOps());

ipcMain.handle('pos:syncNow', async () => syncPendingOperations());

ipcMain.handle('pos:upsertProduct', (_event, product: any) => {
  upsertProduct(product);
  return true;
});
