import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';

let mainWindow: BrowserWindow | null = null;
const STARTUP_LOG_PATH = path.join(process.env.TEMP || process.cwd(), 'jingles-pos-electron.log');
let runtimeModules:
  | {
      shared: typeof import('@jingles/shared');
      localDB: typeof import('./offline/localDB');
      syncService: typeof import('./offline/syncService');
    }
  | null = null;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  return typeof error === 'string'
    ? error
    : JSON.stringify(error, null, 2);
}

function appendStartupLog(message: string, error?: unknown) {
  const lines = [`[${new Date().toISOString()}] ${message}`];
  if (typeof error !== 'undefined') {
    lines.push(formatError(error));
  }

  try {
    fs.appendFileSync(STARTUP_LOG_PATH, `${lines.join('\n')}\n`);
  } catch {
    // Ignore secondary log-write failures.
  }
}

function showStartupError(title: string, message: string, error: unknown) {
  appendStartupLog(`${title}: ${message}`, error);

  try {
    dialog.showErrorBox(title, `${message}\n\n${formatError(error)}\n\nLog: ${STARTUP_LOG_PATH}`);
  } catch {
    // Ignore dialog failures and rely on the startup log.
  }
}

process.on('uncaughtException', (error) => {
  showStartupError('Jingles POS failed to start', 'The Electron main process crashed.', error);
});

process.on('unhandledRejection', (reason) => {
  showStartupError('Jingles POS failed to start', 'The Electron main process hit an unhandled rejection.', reason);
});

function getRuntimeModules() {
  if (!runtimeModules) {
    runtimeModules = {
      shared: require('@jingles/shared'),
      localDB: require('./offline/localDB'),
      syncService: require('./offline/syncService'),
    };
  }

  return runtimeModules;
}

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
  const { shared, localDB } = getRuntimeModules();
  const payload = localDB.getSyncStatus(shared.DEFAULT_DEVICE_ID, shared.DEFAULT_TERMINAL_ID);
  mainWindow?.webContents.send('pos:sync-status', payload);
}

async function createWindow() {
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    appendStartupLog(
      `Renderer failed to load (${errorCode}) ${validatedUrl || 'unknown-url'}: ${errorDescription}`
    );
  });

  const rendererTarget = resolveRendererTarget();
  try {
    if (rendererTarget.type === 'url') {
      await mainWindow.loadURL(rendererTarget.value);
    } else {
      await mainWindow.loadFile(rendererTarget.value);
    }
  } catch (error) {
    appendStartupLog(`Failed to load renderer target ${rendererTarget.value}`, error);
    throw error;
  }
}

app.whenReady().then(async () => {
  try {
    try {
      await getRuntimeModules().syncService.refreshCatalogSnapshot();
    } catch (error) {
      appendStartupLog('Initial shared catalog refresh failed; continuing with the local cache.', error);
    }

    await createWindow();
    emitSyncStatus();
  } catch (error) {
    showStartupError('Jingles POS failed to start', 'Desktop startup aborted before the window was ready.', error);
    app.quit();
    return;
  }

  setInterval(async () => {
    const { shared, syncService } = getRuntimeModules();
    try {
      await syncService.syncPlaybackLog({
        deviceId: shared.DEFAULT_DEVICE_ID,
        terminalId: shared.DEFAULT_TERMINAL_ID,
      });
    } catch (error) {
      appendStartupLog('Background sync failed.', error);
    } finally {
      try {
        emitSyncStatus();
      } catch (error) {
        appendStartupLog('Refreshing sync status failed.', error);
      }
    }
  }, 20_000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('pos:bootstrap', (_event, options?: { deviceId?: string; terminalId?: string }) =>
  getRuntimeModules().localDB.bootstrapPOS(options));

ipcMain.handle('pos:auth:login', (_event, input: { identifier: string; password: string }) =>
  getRuntimeModules().localDB.loginLocalUser(input));

ipcMain.handle('pos:auth:me', (_event, token: string) =>
  getRuntimeModules().localDB.getLocalAuthUser(token));

ipcMain.handle('pos:auth:logout', (_event, token: string) => {
  getRuntimeModules().localDB.clearLocalAuthSession(token);
});

ipcMain.handle('pos:searchProducts', (_event, query: string) =>
  getRuntimeModules().localDB.searchLocalProducts(query));

ipcMain.handle('pos:getShift', (_event, terminalId: string) =>
  getRuntimeModules().localDB.getActiveLocalShift(terminalId) ?? null);

ipcMain.handle('pos:openShift', (_event, input: any) => {
  const result = getRuntimeModules().localDB.openLocalShift(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:closeShift', (_event, input: any) => {
  const result = getRuntimeModules().localDB.closeLocalShift(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:saveHeldSale', (_event, input: any) => {
  const result = getRuntimeModules().localDB.saveHeldSale(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:listHeldSales', () => getRuntimeModules().localDB.listHeldSales());

ipcMain.handle('pos:recallHeldSale', (_event, heldSaleId: string) => {
  const result = getRuntimeModules().localDB.recallHeldSale(heldSaleId);
  emitSyncStatus();
  return result ?? null;
});

ipcMain.handle('pos:createSale', (_event, input: any) => {
  const result = getRuntimeModules().localDB.createLocalSale(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:listSales', () => getRuntimeModules().localDB.listLocalSales());

ipcMain.handle('pos:getSale', (_event, saleId: string) =>
  getRuntimeModules().localDB.getLocalSale(saleId) ?? null);

ipcMain.handle('pos:createReturn', (_event, input: any) => {
  const result = getRuntimeModules().localDB.createLocalReturn(input);
  emitSyncStatus();
  return result;
});

ipcMain.handle('pos:getZReport', (_event, shiftId: string) =>
  getRuntimeModules().localDB.buildLocalZReport(shiftId));

ipcMain.handle('pos:getSyncStatus', () => {
  const { shared, localDB } = getRuntimeModules();
  return localDB.getSyncStatus(shared.DEFAULT_DEVICE_ID, shared.DEFAULT_TERMINAL_ID);
});

ipcMain.handle('pos:getSyncDashboard', () => {
  const { shared, localDB } = getRuntimeModules();
  return localDB.getSyncDashboard(shared.DEFAULT_DEVICE_ID, shared.DEFAULT_TERMINAL_ID);
});

ipcMain.handle('pos:syncNow', async () => {
  const { shared, syncService } = getRuntimeModules();
  const result = await syncService.syncPlaybackLog({
    deviceId: shared.DEFAULT_DEVICE_ID,
    terminalId: shared.DEFAULT_TERMINAL_ID,
  });
  emitSyncStatus();
  return result;
});
