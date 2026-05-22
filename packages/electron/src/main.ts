import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { getDesktopLocalApiUrl, startLocalApiServer, type LocalApiServer } from './backend/localApi';
import {
  copyDatabaseSnapshotIfNeeded,
  createDesktopBackup,
  readDesktopSettings,
  saveDesktopSettings,
} from './desktopSettings';

let mainWindow: BrowserWindow | null = null;
let localApiServer: LocalApiServer | null = null;
const STARTUP_LOG_PATH = path.join(process.env.TEMP || process.cwd(), 'jingles-pos-electron.log');

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
      `Renderer failed to load (${errorCode}) ${validatedUrl || 'unknown-url'}: ${errorDescription}`,
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

async function stopLocalApiServer() {
  if (!localApiServer) {
    return;
  }

  const server = localApiServer;
  localApiServer = null;
  try {
    await server.close();
  } catch (error) {
    appendStartupLog('Failed to stop the POS desktop backend cleanly.', error);
  }
}

async function restartLocalApiServer() {
  await stopLocalApiServer();
  localApiServer = await startLocalApiServer();
  return localApiServer;
}

app.whenReady().then(async () => {
  try {
    app.setAppUserModelId('com.jingles.pos');
    localApiServer = await restartLocalApiServer();
    await createWindow();
  } catch (error) {
    showStartupError('Jingles POS failed to start', 'Desktop startup aborted before the window was ready.', error);
    await stopLocalApiServer();
    app.quit();
  }
});

app.on('before-quit', () => {
  void stopLocalApiServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on('app:backend-url-sync', (event) => {
  event.returnValue = localApiServer?.url ?? getDesktopLocalApiUrl();
});

ipcMain.handle('app:backend-url', () => {
  return localApiServer?.url ?? getDesktopLocalApiUrl();
});

ipcMain.handle('desktop-settings:get', () => {
  return readDesktopSettings();
});

ipcMain.handle('desktop-settings:pick-database-path', async (_event, currentPath?: string) => {
  const dialogOptions = {
    title: 'Choose POS database file',
    defaultPath: currentPath || readDesktopSettings().databasePath,
    filters: [
      { name: 'SQLite Database', extensions: ['sqlite', 'db'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  };
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  return selection.canceled ? null : selection.filePath ?? null;
});

ipcMain.handle('desktop-settings:pick-backup-directory', async (_event, currentPath?: string) => {
  const dialogOptions = {
    title: 'Choose backup directory',
    defaultPath: currentPath || readDesktopSettings().backupDirectory,
    properties: ['openDirectory', 'createDirectory'] as OpenDialogOptions['properties'],
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  return selection.canceled ? null : selection.filePaths[0] ?? null;
});

ipcMain.handle('desktop-settings:backup-now', async () => {
  return createDesktopBackup();
});

ipcMain.handle('desktop-settings:save', async (_event, nextSettings) => {
  const previousSettings = readDesktopSettings();
  const savedSettings = saveDesktopSettings(nextSettings ?? {});
  const copiedDatabase = await copyDatabaseSnapshotIfNeeded(
    previousSettings.databasePath,
    savedSettings.databasePath,
  );
  const shouldRestartBackend =
    savedSettings.syncUrl !== previousSettings.syncUrl ||
    savedSettings.databasePath !== previousSettings.databasePath;

  try {
    if (shouldRestartBackend) {
      await restartLocalApiServer();
    }

    return {
      settings: savedSettings,
      restartedBackend: shouldRestartBackend,
      copiedDatabase,
    };
  } catch (error) {
    saveDesktopSettings(previousSettings);
    if (shouldRestartBackend) {
      await restartLocalApiServer();
    }
    throw error;
  }
});
