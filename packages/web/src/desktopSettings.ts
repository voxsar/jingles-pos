import type {
  POSDesktopBackupResult,
  POSDesktopSettings,
  POSDesktopSettingsSaveResult,
  POSThemeMode,
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
    deviceId: 'browser-pos',
    deviceName: 'Browser POS',
    deviceNameVersion: 0,
    syncUrl: DEFAULT_POS_SYNC_URL,
    databasePath: '',
    backupDirectory: '',
    themeMode,
    addDenominationsToPaymentList: true,
    showDenominationCombinations: true,
    allowShortPayments: false,
  };
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

