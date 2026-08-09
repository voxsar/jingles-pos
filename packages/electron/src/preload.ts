import { contextBridge, ipcRenderer } from 'electron';
import type {
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
    };
  }
}
