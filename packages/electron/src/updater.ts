import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, ipcMain, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { reportElectronError } from './errorReporter';

export type UpdatePolicy = 'automatic' | 'ask' | 'manual';

type UpdateStatus = {
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'error';
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  message: string;
  policy: UpdatePolicy;
};

type UpdatePreferences = { policy: UpdatePolicy; skippedVersion: string | null };
type UpdateConfig = { url?: string; channel?: string };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let preferences: UpdatePreferences = { policy: 'ask', skippedVersion: null };
let status: UpdateStatus;
let manualCheck = false;
let checking = false;
let checkTimer: NodeJS.Timeout | null = null;

function preferencePath() {
  return path.join(app.getPath('userData'), 'update-preferences.json');
}

function loadPreferences() {
  try {
    const saved = JSON.parse(fs.readFileSync(preferencePath(), 'utf8')) as Partial<UpdatePreferences>;
    preferences = {
      policy: saved.policy && ['automatic', 'ask', 'manual'].includes(saved.policy) ? saved.policy : 'ask',
      skippedVersion: typeof saved.skippedVersion === 'string' ? saved.skippedVersion : null,
    };
  } catch {
    preferences = { policy: 'ask', skippedVersion: null };
  }
}

function savePreferences() {
  fs.mkdirSync(path.dirname(preferencePath()), { recursive: true });
  fs.writeFileSync(preferencePath(), JSON.stringify(preferences, null, 2), 'utf8');
}

function broadcast(next: Partial<UpdateStatus>) {
  status = { ...status, ...next, policy: preferences.policy };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updater:status', status);
  }
}

function showMessage(options: Electron.MessageBoxOptions) {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}

function validateFeedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('The update feed must use HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

function readUpdateConfig(environmentVariable: string): UpdateConfig | null {
  const environmentUrl = process.env[environmentVariable]?.trim();
  if (environmentUrl) {
    return { url: environmentUrl, channel: process.env.JINGLES_UPDATE_CHANNEL?.trim() };
  }
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(process.resourcesPath, 'update-config.json'), 'utf8'),
    ) as UpdateConfig;
    return config.url?.trim() ? config : null;
  } catch {
    return null;
  }
}

async function downloadUpdate() {
  broadcast({ state: 'downloading', progressPercent: 0, message: 'Downloading update...' });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    reportElectronError(error, 'electron.updater.download');
    broadcast({ state: 'error', message: `Update download failed: ${String(error)}` });
  }
}

async function offerUpdate(info: UpdateInfo) {
  if (!manualCheck && preferences.skippedVersion === info.version) return;
  if (!manualCheck && preferences.policy === 'automatic') {
    await downloadUpdate();
    return;
  }
  const result = await showMessage({
    type: 'info',
    title: 'POS update available',
    message: `Jingles POS ${info.version} is available`,
    detail: `You are using ${app.getVersion()}. Download it in the background now?`,
    buttons: ['Download now', 'Later', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) await downloadUpdate();
  if (result.response === 2) {
    preferences.skippedVersion = info.version;
    savePreferences();
  }
}

export async function checkForUpdates(showResult = true) {
  if (status.state === 'disabled') {
    if (showResult) await showMessage({ type: 'info', title: 'Updates unavailable', message: status.message });
    return status;
  }
  if (checking || status.state === 'downloading') return status;
  checking = true;
  manualCheck = showResult;
  broadcast({ state: 'checking', progressPercent: null, message: 'Checking for updates...' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    reportElectronError(error, 'electron.updater.check');
    broadcast({ state: 'error', message: `Update check failed: ${String(error)}` });
    if (showResult) await showMessage({ type: 'error', title: 'Update check failed', message: status.message });
  } finally {
    checking = false;
    manualCheck = false;
  }
  return status;
}

export async function chooseUpdatePolicy() {
  const result = await showMessage({
    type: 'question',
    title: 'Update preferences',
    message: 'How should Jingles POS handle updates?',
    buttons: ['Automatic', 'Ask before downloading', 'Manual only', 'Cancel'],
    defaultId: preferences.policy === 'automatic' ? 0 : preferences.policy === 'ask' ? 1 : 2,
    cancelId: 3,
    noLink: true,
  });
  if (result.response === 3) return preferences.policy;
  preferences = {
    policy: (['automatic', 'ask', 'manual'] as const)[result.response],
    skippedVersion: null,
  };
  savePreferences();
  scheduleChecks();
  broadcast({ message: `Update policy changed to ${preferences.policy}.` });
  return preferences.policy;
}

export function getUpdateMenu(): MenuItemConstructorOptions {
  return {
    label: 'Updates',
    submenu: [
      { label: 'Check for Updates...', click: () => void checkForUpdates(true) },
      { label: 'Update Preferences...', click: () => void chooseUpdatePolicy() },
      { type: 'separator' },
      { label: `Current version ${app.getVersion()}`, enabled: false },
    ],
  };
}

function scheduleChecks() {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = null;
  if (preferences.policy === 'manual' || status.state === 'disabled') return;
  checkTimer = setTimeout(() => {
    void checkForUpdates(false);
    checkTimer = setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS);
    checkTimer.unref?.();
  }, 15_000);
  checkTimer.unref?.();
}

export function initializeUpdater(environmentVariable: string) {
  loadPreferences();
  status = {
    state: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progressPercent: null,
    message: 'Ready to check for updates.',
    policy: preferences.policy,
  };

  try {
    const externalConfig = readUpdateConfig(environmentVariable);
    const embeddedConfig = path.join(process.resourcesPath, 'app-update.yml');
    if (!app.isPackaged || (!externalConfig && !fs.existsSync(embeddedConfig))) {
      broadcast({
        state: 'disabled',
        message: app.isPackaged
          ? 'No POS update feed is configured for this build.'
          : 'Updates are enabled only in packaged builds.',
      });
    } else {
      if (externalConfig?.url) {
        const channel = externalConfig.channel?.trim() || 'latest';
        autoUpdater.setFeedURL({ provider: 'generic', url: validateFeedUrl(externalConfig.url), channel });
        autoUpdater.channel = channel;
      }
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.on('update-available', (info) => {
        broadcast({ state: 'available', availableVersion: info.version, message: `Version ${info.version} is available.` });
        void offerUpdate(info);
      });
      autoUpdater.on('update-not-available', async () => {
        broadcast({ state: 'current', availableVersion: null, message: 'You have the latest POS version.' });
        if (manualCheck) await showMessage({ type: 'info', title: 'No updates available', message: status.message });
      });
      autoUpdater.on('download-progress', (progress: ProgressInfo) => {
        broadcast({ state: 'downloading', progressPercent: Math.round(progress.percent), message: `Downloading update... ${Math.round(progress.percent)}%` });
      });
      autoUpdater.on('update-downloaded', async (info) => {
        broadcast({ state: 'downloaded', availableVersion: info.version, progressPercent: 100, message: `Version ${info.version} is ready to install.` });
        const result = await showMessage({
          type: 'info',
          title: 'POS update ready',
          message: `Jingles POS ${info.version} is ready`,
          detail: 'Restart now, or install it automatically when POS closes.',
          buttons: ['Restart and install', 'Later'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (result.response === 0) autoUpdater.quitAndInstall(false, true);
      });
      autoUpdater.on('error', (error) => {
        reportElectronError(error, 'electron.updater.event');
        broadcast({ state: 'error', message: `Updater error: ${error.message}` });
      });
    }
  } catch (error) {
    reportElectronError(error, 'electron.updater.configure');
    broadcast({ state: 'error', message: `Invalid update configuration: ${String(error)}` });
  }

  ipcMain.handle('updater:get-status', () => status);
  ipcMain.handle('updater:check', () => checkForUpdates(true));
  ipcMain.handle('updater:choose-policy', () => chooseUpdatePolicy());
  ipcMain.handle('updater:install', () => {
    if (status.state !== 'downloaded') return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  });
  scheduleChecks();
  return status;
}
