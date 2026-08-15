import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { getDesktopLocalApiUrl, startLocalApiServer, type LocalApiServer } from './backend/localApi';
import {
  backupDatabaseTo,
  copyDatabaseSnapshotIfNeeded,
  createDesktopBackup,
  getDatabaseInfo,
  getDefaultDatabasePath,
  readDesktopSettings,
  saveDesktopSettings,
} from './desktopSettings';
import {
  closeCustomerDisplayWindow,
  configureCustomerDisplay,
  getCachedCustomerDisplayState,
  getCustomerDisplayStatus,
  openCustomerDisplayWindow,
  publishCustomerDisplayState,
  toggleCustomerDisplayWindow,
} from './customerDisplay';
import { resolveRendererTarget } from './rendererTarget';
import { discoverPrinters } from './printing/discovery';
import {
  listConfiguredPrinters,
  openCashDrawer,
  printDocument,
  printLabel,
  testPrinter,
} from './printing/printerService';
import { cleanPrintingWorkDirectory } from './printing/transport';
import { JinglesMdnsService, type DiscoveredJinglesDevice } from './network/mdns';
import { writeLanSyncTarget } from './network/lanSyncTarget';
import { DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID, type POSDatabaseSwitchMode } from '@jingles/shared';
import { getUpdateMenu, initializeUpdater } from './updater';
import { flushElectronErrorReports, reportElectronError } from './errorReporter';

let mainWindow: BrowserWindow | null = null;
let localApiServer: LocalApiServer | null = null;
let mdnsService: JinglesMdnsService | null = null;
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

function selectInventoryLanTarget(devices: DiscoveredJinglesDevice[]) {
  return devices
    .filter((device) => device.application === 'inventory' && Date.parse(device.expiresAt) > Date.now())
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0] ?? null;
}

function startLanDiscovery() {
  const deviceId = process.env.JINGLES_POS_DEVICE_ID?.trim() || DEFAULT_DEVICE_ID;
  const terminalId = process.env.JINGLES_POS_TERMINAL_ID?.trim() || DEFAULT_TERMINAL_ID;
  mdnsService = new JinglesMdnsService({
    deviceId,
    deviceName: `Jingles POS - ${os.hostname()} (${terminalId})`,
    application: 'pos',
    applicationVersion: app.getVersion(),
    port: 3631,
    protocol: 'http',
    apiPath: '/api/pos',
    terminalId,
  });
  mdnsService.subscribe((devices) => {
    const target = selectInventoryLanTarget(devices);
    writeLanSyncTarget(target);
    appendStartupLog(
      target
        ? `LAN inventory route discovered: ${target.deviceName} at ${target.address}:${target.port}`
        : 'No Inventory desktop LAN route is currently available.',
    );
  });
  mdnsService.start();
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
  reportElectronError(error, 'electron.process.uncaught-exception');
  showStartupError('Jingles POS failed to start', 'The Electron main process crashed.', error);
});

process.on('unhandledRejection', (reason) => {
  reportElectronError(reason, 'electron.process.unhandled-rejection');
  showStartupError('Jingles POS failed to start', 'The Electron main process hit an unhandled rejection.', reason);
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: '#e6e2f0',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.resolve(__dirname, '../build/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // The customer display exists to mirror the workstation; without one there
    // is nothing left to mirror.
    closeCustomerDisplayWindow();
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
    reportElectronError(error, 'electron.renderer.load');
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
    reportElectronError(error, 'electron.backend.stop');
    appendStartupLog('Failed to stop the POS desktop backend cleanly.', error);
  }
}

async function restartLocalApiServer() {
  await stopLocalApiServer();
  localApiServer = await startLocalApiServer({
    onDiagnostic: (message, error) => appendStartupLog(message, error),
  });
  return localApiServer;
}

function buildTimestampForFilename(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
}

async function pickBackupDestinationPath() {
  const databaseInfo = getDatabaseInfo();
  const dialogOptions: SaveDialogOptions = {
    title: 'Backup POS Database',
    defaultPath: path.join(
      databaseInfo.directory,
      `jingles-pos-backup-${buildTimestampForFilename()}.sqlite`,
    ),
    filters: [
      { name: 'SQLite Database', extensions: ['sqlite', 'db'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  if (selection.canceled || !selection.filePath) {
    return null;
  }

  return path.resolve(selection.filePath);
}

/** Opens the picker for a "Switch Database" action; 'new' creates an empty file path, 'existing' opens one. */
async function pickDatabasePathForSwitch(mode: 'new' | 'existing') {
  const databaseInfo = getDatabaseInfo();

  if (mode === 'existing') {
    const dialogOptions: OpenDialogOptions = {
      title: 'Select POS database file',
      defaultPath: databaseInfo.directory,
      filters: [
        { name: 'SQLite Database', extensions: ['sqlite', 'db'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }

    return path.resolve(selection.filePaths[0]);
  }

  const dialogOptions: SaveDialogOptions = {
    title: 'Create new POS database file',
    defaultPath: path.join(
      databaseInfo.directory,
      `jingles-pos-${buildTimestampForFilename()}.sqlite`,
    ),
    filters: [
      { name: 'SQLite Database', extensions: ['sqlite', 'db'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  if (selection.canceled || !selection.filePath) {
    return null;
  }

  return path.resolve(selection.filePath);
}

/**
 * Points the desktop settings at a new database file and restarts the local
 * backend against it, the same live-switch the settings form triggers when
 * `databasePath` changes. If the new location doesn't exist yet, the current
 * database is copied there first so the switch never starts from empty data.
 */
async function applyDatabasePathChange(nextDatabasePath: string) {
  const previousSettings = readDesktopSettings();

  if (path.normalize(nextDatabasePath) === path.normalize(previousSettings.databasePath)) {
    return { settings: previousSettings, copiedDatabase: false };
  }

  const savedSettings = saveDesktopSettings({ databasePath: nextDatabasePath });
  const copiedDatabase = await copyDatabaseSnapshotIfNeeded(
    previousSettings.databasePath,
    savedSettings.databasePath,
  );

  try {
    await restartLocalApiServer();
    return { settings: savedSettings, copiedDatabase };
  } catch (error) {
    reportElectronError(error, 'electron.database.switch');
    saveDesktopSettings(previousSettings);
    await restartLocalApiServer();
    throw error;
  }
}

app.whenReady().then(async () => {
  try {
    app.setAppUserModelId('com.jingles.pos');
    initializeUpdater('JINGLES_POS_UPDATE_URL');
    configureCustomerDisplay({
      getMainWindow: () => mainWindow,
      onError: (message, error) => {
        reportElectronError(error, 'electron.customer-display', { message });
        appendStartupLog(message, error);
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'viewMenu' },
      {
        label: 'Customer display',
        submenu: [
          {
            label: 'Toggle customer display',
            click: () => {
              void toggleCustomerDisplayWindow().catch((error) => {
                reportElectronError(error, 'electron.customer-display.toggle-menu');
                appendStartupLog('Failed to toggle the customer display window.', error);
              });
            },
          },
        ],
      },
      getUpdateMenu(),
      { role: 'help' },
    ]));
    startLanDiscovery();
    cleanPrintingWorkDirectory();
    localApiServer = await restartLocalApiServer();
    void flushElectronErrorReports();
    await createWindow();

    if (readDesktopSettings().customerDisplay.enabled) {
      // A failed customer display must not take the till down with it.
      await openCustomerDisplayWindow().catch((error) => {
        reportElectronError(error, 'electron.customer-display.open-startup');
        appendStartupLog('Failed to open the customer display window at startup.', error);
      });
    }
  } catch (error) {
    reportElectronError(error, 'electron.startup');
    showStartupError('Jingles POS failed to start', 'Desktop startup aborted before the window was ready.', error);
    await stopLocalApiServer();
    app.quit();
  }
});

app.on('before-quit', () => {
  mdnsService?.stop();
  mdnsService = null;
  closeCustomerDisplayWindow();
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

ipcMain.on('app:version-sync', (event) => {
  event.returnValue = app.getVersion();
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

ipcMain.handle('desktop-settings:backup-as', async () => {
  const backupPath = await pickBackupDestinationPath();
  if (!backupPath) {
    return { canceled: true, filePath: null, createdAt: null };
  }

  const result = await backupDatabaseTo(backupPath);
  return { canceled: false, ...result };
});

ipcMain.handle('desktop-settings:get-database-info', () => {
  return getDatabaseInfo();
});

ipcMain.handle('desktop-settings:reveal-database-file', async () => {
  const info = getDatabaseInfo();

  if (info.exists) {
    shell.showItemInFolder(info.currentPath);
    return;
  }

  const openError = await shell.openPath(info.directory);
  if (openError) {
    throw new Error(openError);
  }
});

ipcMain.handle('desktop-settings:switch-database', async (_event, mode: POSDatabaseSwitchMode) => {
  let nextPath: string;

  if (mode === 'default') {
    nextPath = getDefaultDatabasePath();
  } else {
    const picked = await pickDatabasePathForSwitch(mode);
    if (!picked) {
      return { canceled: true, mode, selectedPath: null, copiedDatabase: false };
    }
    nextPath = picked;
  }

  const { settings, copiedDatabase } = await applyDatabasePathChange(nextPath);
  return {
    canceled: false,
    mode,
    selectedPath: settings.databasePath,
    copiedDatabase,
  };
});

ipcMain.handle('customer-display:status', () => {
  return getCustomerDisplayStatus();
});

ipcMain.handle('customer-display:open', async () => {
  return openCustomerDisplayWindow();
});

ipcMain.handle('customer-display:close', () => {
  return closeCustomerDisplayWindow();
});

ipcMain.handle('customer-display:toggle', async () => {
  return toggleCustomerDisplayWindow();
});

// Fire-and-forget from the workstation: a snapshot the customer should see.
ipcMain.on('customer-display:publish', (_event, state) => {
  publishCustomerDisplayState(state);
});

// Asked by the display window itself when it mounts.
ipcMain.handle('customer-display:get-state', () => {
  return getCachedCustomerDisplayState();
});

ipcMain.handle('printing:list', () => {
  return listConfiguredPrinters();
});

ipcMain.handle('printing:discover', async (_event, options?: { includeNetwork?: boolean }) => {
  return discoverPrinters(mainWindow?.webContents ?? null, options ?? {});
});

ipcMain.handle('printing:test', async (_event, printer) => {
  return testPrinter(printer);
});

ipcMain.handle('printing:print-receipt', async (_event, document, options?: { printerId?: string }) => {
  return printDocument(document, { ...options, role: 'receipt' });
});

ipcMain.handle('printing:print-label', async (_event, document, options?: { printerId?: string }) => {
  return printLabel(document, options ?? {});
});

ipcMain.handle('printing:open-drawer', async (_event, printerId?: string) => {
  return openCashDrawer(printerId);
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

    // Turning the display on in settings should show it now, not at the next
    // start; turning it off should take the customer screen down with it.
    if (savedSettings.customerDisplay.enabled !== previousSettings.customerDisplay.enabled) {
      if (savedSettings.customerDisplay.enabled) {
        await openCustomerDisplayWindow().catch((error) => {
          reportElectronError(error, 'electron.customer-display.open-settings');
          appendStartupLog('Failed to open the customer display window after a settings change.', error);
        });
      } else {
        closeCustomerDisplayWindow();
      }
    }

    return {
      settings: savedSettings,
      restartedBackend: shouldRestartBackend,
      copiedDatabase,
    };
  } catch (error) {
    reportElectronError(error, 'electron.settings.save');
    saveDesktopSettings(previousSettings);
    if (shouldRestartBackend) {
      await restartLocalApiServer();
    }
    throw error;
  }
});
