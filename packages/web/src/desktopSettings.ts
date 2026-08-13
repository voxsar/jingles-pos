import {
  DEFAULT_POS_PRINTER_CONFIG,
  DEFAULT_POS_SCANNER_SETTINGS,
  type POSDesktopBackupResult,
  type POSDesktopSettings,
  type POSDesktopSettingsSaveResult,
  type POSPrinterConfig,
  type POSPrinterRole,
  type POSThemeMode,
} from '@jingles/shared';

export const DEFAULT_POS_SYNC_URL = 'https://inv.theredsun.org';
const THEME_STORAGE_KEY = 'jingles-pos-theme-mode';

export function hasDesktopSettingsBridge() {
  return typeof window !== 'undefined' && typeof window.electronAPI?.desktopSettings !== 'undefined';
}

export function readStoredThemeMode(): POSThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }

  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function persistThemeMode(themeMode: POSThemeMode) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  } catch {
    // Ignore storage-write failures and still apply the theme for this session.
  }
}

export function buildFallbackDesktopSettings(themeMode: POSThemeMode): POSDesktopSettings {
  return {
    syncUrl: DEFAULT_POS_SYNC_URL,
    databasePath: '',
    backupDirectory: '',
    themeMode,
    addDenominationsToPaymentList: true,
    showDenominationCombinations: true,
    allowShortPayments: false,
    printers: [],
    scanner: { ...DEFAULT_POS_SCANNER_SETTINGS },
  };
}

/** Creates a printer entry pre-filled for the role it will serve. */
export function createPrinterDraft(role: POSPrinterRole, overrides: Partial<POSPrinterConfig> = {}): POSPrinterConfig {
  const isLabel = role === 'label';

  return {
    ...DEFAULT_POS_PRINTER_CONFIG,
    id: `printer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: isLabel ? 'Label printer' : 'Receipt printer',
    role,
    language: isLabel ? 'zpl' : 'escpos',
    cutPaper: !isLabel,
    ...overrides,
  };
}

/**
 * Applies an edit to one printer while keeping the "one default per role"
 * invariant the main process also enforces when it loads the settings file.
 */
export function withPrinterUpdate(
  printers: POSPrinterConfig[],
  printerId: string,
  changes: Partial<POSPrinterConfig>,
): POSPrinterConfig[] {
  const updated = printers.map((printer) => (
    printer.id === printerId ? { ...printer, ...changes } : printer
  ));

  const edited = updated.find((printer) => printer.id === printerId);
  if (!edited) {
    return updated;
  }

  if (changes.isDefault === true || changes.role != null) {
    return updated.map((printer) => (
      printer.role === edited.role
        ? { ...printer, isDefault: printer.id === edited.id ? edited.isDefault : false }
        : printer
    ));
  }

  return updated;
}

function getDesktopSettingsBridge() {
  return window.electronAPI?.desktopSettings;
}

export async function loadDesktopSettings(): Promise<POSDesktopSettings> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.get();
}

export async function saveDesktopSettings(settings: POSDesktopSettings): Promise<POSDesktopSettingsSaveResult> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.save(settings);
}

export async function pickDesktopDatabasePath(currentPath?: string): Promise<string | null> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.pickDatabasePath(currentPath);
}

export async function pickDesktopBackupDirectory(currentPath?: string): Promise<string | null> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.pickBackupDirectory(currentPath);
}

export async function createDesktopBackup(): Promise<POSDesktopBackupResult> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.backupNow();
}

