import { contextBridge, ipcRenderer } from 'electron';
import type {
  POSCustomerDisplayState,
  POSCustomerDisplayStatus,
  POSDesktopBackupResult,
  POSDesktopSettings,
  POSDesktopSettingsSaveResult,
  POSLabelDocument,
  POSPrintDocument,
  POSPrintResult,
  POSPrinterConfig,
  POSPrinterDiscoveryResult,
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
  printing: {
    list: () => ipcRenderer.invoke('printing:list') as Promise<POSPrinterConfig[]>,
    discover: (options?: { includeNetwork?: boolean }) => (
      ipcRenderer.invoke('printing:discover', options) as Promise<POSPrinterDiscoveryResult>
    ),
    test: (printer: POSPrinterConfig) => (
      ipcRenderer.invoke('printing:test', printer) as Promise<POSPrintResult>
    ),
    printReceipt: (document: POSPrintDocument, options?: { printerId?: string }) => (
      ipcRenderer.invoke('printing:print-receipt', document, options) as Promise<POSPrintResult>
    ),
    printLabel: (document: POSLabelDocument, options?: { printerId?: string }) => (
      ipcRenderer.invoke('printing:print-label', document, options) as Promise<POSPrintResult>
    ),
    openCashDrawer: (printerId?: string) => (
      ipcRenderer.invoke('printing:open-drawer', printerId) as Promise<POSPrintResult>
    ),
  },
  customerDisplay: {
    getStatus: () => ipcRenderer.invoke('customer-display:status') as Promise<POSCustomerDisplayStatus>,
    open: () => ipcRenderer.invoke('customer-display:open') as Promise<POSCustomerDisplayStatus>,
    close: () => ipcRenderer.invoke('customer-display:close') as Promise<POSCustomerDisplayStatus>,
    toggle: () => ipcRenderer.invoke('customer-display:toggle') as Promise<POSCustomerDisplayStatus>,
    publish: (state: POSCustomerDisplayState) => ipcRenderer.send('customer-display:publish', state),
    getState: () => ipcRenderer.invoke('customer-display:get-state') as Promise<POSCustomerDisplayState | null>,
    onState: (callback: (state: POSCustomerDisplayState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: POSCustomerDisplayState) => callback(state);
      ipcRenderer.on('customer-display:state', listener);
      return () => ipcRenderer.removeListener('customer-display:state', listener);
    },
    onStatus: (callback: (status: POSCustomerDisplayStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: POSCustomerDisplayStatus) => callback(status);
      ipcRenderer.on('customer-display:status', listener);
      return () => ipcRenderer.removeListener('customer-display:status', listener);
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
      printing?: {
        list: () => Promise<POSPrinterConfig[]>;
        discover: (options?: { includeNetwork?: boolean }) => Promise<POSPrinterDiscoveryResult>;
        test: (printer: POSPrinterConfig) => Promise<POSPrintResult>;
        printReceipt: (document: POSPrintDocument, options?: { printerId?: string }) => Promise<POSPrintResult>;
        printLabel: (document: POSLabelDocument, options?: { printerId?: string }) => Promise<POSPrintResult>;
        openCashDrawer: (printerId?: string) => Promise<POSPrintResult>;
      };
      customerDisplay?: {
        getStatus: () => Promise<POSCustomerDisplayStatus>;
        open: () => Promise<POSCustomerDisplayStatus>;
        close: () => Promise<POSCustomerDisplayStatus>;
        toggle: () => Promise<POSCustomerDisplayStatus>;
        publish: (state: POSCustomerDisplayState) => void;
        getState: () => Promise<POSCustomerDisplayState | null>;
        onState: (callback: (state: POSCustomerDisplayState) => void) => () => void;
        onStatus: (callback: (status: POSCustomerDisplayStatus) => void) => () => void;
      };
      updates?: {
        getStatus: () => Promise<unknown>;
        check: () => Promise<unknown>;
        choosePolicy: () => Promise<unknown>;
        install: () => Promise<boolean>;
        onStatus: (callback: (status: unknown) => void) => () => void;
      };
    };
  }
}
