import type {
  POSDesktopBackupResult,
  POSDesktopSettings,
  POSDesktopSettingsSaveResult,
} from '@jingles/shared';

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

export {};
