import type {
  POSCustomerDisplayState,
  POSCustomerDisplayStatus,
  POSDatabaseInfo,
  POSDatabaseSwitchMode,
  POSDatabaseSwitchResult,
  POSDesktopBackupAsResult,
  POSDesktopBackupResult,
  POSDesktopSettings,
  POSDesktopSettingsSaveResult,
  POSLabelDocument,
  POSPrintDocument,
  POSPrintResult,
  POSPrinterConfig,
  POSPrinterDiscoveryResult,
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
        backupAs: () => Promise<POSDesktopBackupAsResult>;
        getDatabaseInfo: () => Promise<POSDatabaseInfo>;
        revealDatabaseFile: () => Promise<void>;
        switchDatabase: (mode: POSDatabaseSwitchMode) => Promise<POSDatabaseSwitchResult>;
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
      printing?: {
        list: () => Promise<POSPrinterConfig[]>;
        discover: (options?: { includeNetwork?: boolean }) => Promise<POSPrinterDiscoveryResult>;
        test: (printer: POSPrinterConfig) => Promise<POSPrintResult>;
        printReceipt: (document: POSPrintDocument, options?: { printerId?: string }) => Promise<POSPrintResult>;
        printLabel: (document: POSLabelDocument, options?: { printerId?: string }) => Promise<POSPrintResult>;
        openCashDrawer: (printerId?: string) => Promise<POSPrintResult>;
      };
    };
  }
}

export {};
