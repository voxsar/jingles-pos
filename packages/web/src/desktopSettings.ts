import {
  DEFAULT_POS_CASH_SALES_VISIBILITY,
  DEFAULT_POS_PRICE_OVERRIDE_SETTINGS,
  DEFAULT_POS_PRINTER_CONFIG,
  DEFAULT_POS_SCANNER_SETTINGS,
  DEFAULT_POS_SESSION_LOCK_MINUTES,
  DEFAULT_POS_SHIFT_RECONCILIATION,
  DEFAULT_POS_SHORTCUT_SETTINGS,
  type POSDatabaseInfo,
  type POSDatabaseSwitchMode,
  type POSDatabaseSwitchResult,
  type POSDesktopBackupAsResult,
  type POSDesktopBackupResult,
  type POSDesktopSettings,
  type POSDesktopSettingsSaveResult,
  type POSPrinterConfig,
  type POSPrinterRole,
  type POSThemeMode,
} from '@jingles/shared';
import { readStoredCustomerDisplaySettings } from './customerDisplay';

export const DEFAULT_POS_SYNC_URL = 'https://inv.theredsun.org';
const THEME_STORAGE_KEY = 'jingles-pos-theme-mode';
export const SESSION_LOCK_MINUTES_KEY = 'jingles-pos-session-lock-minutes';

export function readStoredSessionLockMinutes() {
  const value = typeof window === 'undefined' ? NaN : Number(window.localStorage.getItem(SESSION_LOCK_MINUTES_KEY));
  return Number.isFinite(value) ? Math.min(120, Math.max(1, Math.round(value))) : DEFAULT_POS_SESSION_LOCK_MINUTES;
}

export function persistSessionLockMinutes(minutes: number) {
  const normalized = Math.min(120, Math.max(1, Math.round(minutes)));
  window.localStorage.setItem(SESSION_LOCK_MINUTES_KEY, String(normalized));
  window.dispatchEvent(new CustomEvent('jingles:session-lock-settings'));
}

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
    sessionLockMinutes: readStoredSessionLockMinutes(),
    syncUrl: DEFAULT_POS_SYNC_URL,
    databasePath: '',
    backupDirectory: '',
    themeMode,
    addDenominationsToPaymentList: true,
    showDenominationCombinations: true,
    allowShortPayments: false,
    printers: [],
    scanner: { ...DEFAULT_POS_SCANNER_SETTINGS },
    priceOverride: { ...DEFAULT_POS_PRICE_OVERRIDE_SETTINGS },
    shortcuts: {
      ...DEFAULT_POS_SHORTCUT_SETTINGS,
      actions: { ...DEFAULT_POS_SHORTCUT_SETTINGS.actions },
      quickKeys: [],
    },
    shiftReconciliation: { ...DEFAULT_POS_SHIFT_RECONCILIATION },
    // The browser build has no settings file, so the one section it can still
    // honour is kept in local storage instead of defaulting on every reload.
    customerDisplay: readStoredCustomerDisplaySettings(),
    cashSalesVisibility: { ...DEFAULT_POS_CASH_SALES_VISIBILITY },
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

/** Backs up to a destination the user picks in a save dialog, unlike {@link createDesktopBackup}'s fixed folder. */
export async function createDesktopBackupAs(): Promise<POSDesktopBackupAsResult> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.backupAs();
}

export async function getDesktopDatabaseInfo(): Promise<POSDatabaseInfo> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.getDatabaseInfo();
}

export async function revealDesktopDatabaseFile(): Promise<void> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.revealDatabaseFile();
}

/** Switches the live database file and restarts the local backend against it. */
export async function switchDesktopDatabase(mode: POSDatabaseSwitchMode): Promise<POSDatabaseSwitchResult> {
  const bridge = getDesktopSettingsBridge();
  if (!bridge) {
    throw new Error('Desktop settings are only available in the Electron app.');
  }

  return bridge.switchDatabase(mode);
}

