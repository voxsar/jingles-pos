import { contextBridge, ipcRenderer } from 'electron';
import type {
  ElectronDiscoveredDevice,
  POSDesktopBackupResult,
  POSDesktopSettings,
  POSDesktopSettingsSaveResult,
} from '@jingles/shared';

const FALLBACK_DESKTOP_LOCAL_API_URL = 'http://127.0.0.1:3631';

function readDesktopLocalApiUrl() {
  try {
    const resolvedUrl = ipcRenderer.sendSync('app:backend-url-sync');
    return typeof resolvedUrl === 'string' && resolvedUrl.trim()
      ? resolvedUrl.trim()
      : FALLBACK_DESKTOP_LOCAL_API_URL;
  } catch (error) {
    console.error('[Electron preload] Failed to resolve the desktop backend URL.', error);
    return FALLBACK_DESKTOP_LOCAL_API_URL;
  }
}

const DESKTOP_LOCAL_API_URL = readDesktopLocalApiUrl();

contextBridge.exposeInMainWorld('electronAPI', {
  app: {
    backendUrl: DESKTOP_LOCAL_API_URL,
  },
  desktopSettings: {
    get: () => ipcRenderer.invoke('desktop-settings:get') as Promise<POSDesktopSettings>,
    save: (settings: POSDesktopSettings) => (
      ipcRenderer.invoke('desktop-settings:save', settings) as Promise<POSDesktopSettingsSaveResult>
    ),
    pickDatabasePath: (currentPath?: string) => (
      ipcRenderer.invoke('desktop-settings:pick-database-path', currentPath) as Promise<string | null>
    ),
    pickBackupDirectory: (currentPath?: string) => (
      ipcRenderer.invoke('desktop-settings:pick-backup-directory', currentPath) as Promise<string | null>
    ),
    backupNow: () => (
      ipcRenderer.invoke('desktop-settings:backup-now') as Promise<POSDesktopBackupResult>
    ),
  },
  devices: {
    list: () => ipcRenderer.invoke('devices:list') as Promise<ElectronDiscoveredDevice[]>,
    refresh: () => ipcRenderer.invoke('devices:refresh') as Promise<ElectronDiscoveredDevice[]>,
    onChanged: (callback: (devices: ElectronDiscoveredDevice[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, devices: ElectronDiscoveredDevice[]) => callback(devices);
      ipcRenderer.on('devices:changed', listener);
      return () => ipcRenderer.removeListener('devices:changed', listener);
    },
  },
  updates: {
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
    check: () => ipcRenderer.invoke('updater:check'),
    choosePolicy: () => ipcRenderer.invoke('updater:choose-policy'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
  },
});

declare global {
  interface Window {
    electronAPI?: {
      app?: {
        backendUrl?: string;
      };
      desktopSettings?: {
        get: () => Promise<POSDesktopSettings>;
        save: (settings: POSDesktopSettings) => Promise<POSDesktopSettingsSaveResult>;
        pickDatabasePath: (currentPath?: string) => Promise<string | null>;
        pickBackupDirectory: (currentPath?: string) => Promise<string | null>;
        backupNow: () => Promise<POSDesktopBackupResult>;
      };
      devices?: {
        list: () => Promise<ElectronDiscoveredDevice[]>;
        refresh: () => Promise<ElectronDiscoveredDevice[]>;
        onChanged: (callback: (devices: ElectronDiscoveredDevice[]) => void) => () => void;
      };
      updates?: {
        getStatus: () => Promise<unknown>;
        check: () => Promise<unknown>;
        choosePolicy: () => Promise<'automatic' | 'ask' | 'manual'>;
        install: () => Promise<boolean>;
        onStatus: (callback: (status: unknown) => void) => () => void;
      };
    };
  }
}
