import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import {
  DEFAULT_POS_PRINTER_CONFIG,
  DEFAULT_POS_SCANNER_SETTINGS,
  DEFAULT_POS_SESSION_LOCK_MINUTES,
  normalizeCartLineOrder,
  normalizeCashSalesVisibility,
  normalizeCustomerDisplaySettings,
  normalizePriceOverrideSettings,
  normalizeShiftReconciliation,
  normalizeShortcutSettings,
  type POSDatabaseInfo,
  type POSDesktopBackupResult,
  type POSDesktopSettings,
  type POSPrinterConfig,
  type POSPrinterLanguage,
  type POSPrinterRole,
  type POSPrinterTransport,
  type POSScannerSettings,
  type POSThemeMode,
} from '@jingles/shared';
import { reportElectronError } from './errorReporter';

const DEFAULT_SYNC_URL = 'https://inv.theredsun.org';
const SETTINGS_FILE_NAME = 'desktop-settings.json';

type StoredDesktopSettings = Partial<POSDesktopSettings>;

function ensureDirectory(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  return dirPath;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function getDesktopRuntimeRoot() {
  return ensureDirectory(path.join(app.getPath('userData'), 'backend'));
}

export function getDefaultDatabasePath() {
  return path.join(getDesktopRuntimeRoot(), 'jingles-pos.sqlite');
}

function getDefaultBackupDirectory() {
  return path.join(app.getPath('documents'), 'Jingles POS Backups');
}

function getDesktopSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

function normalizeThemeMode(value: string | null | undefined): POSThemeMode {
  return value?.trim().toLowerCase() === 'dark' ? 'dark' : 'light';
}

function normalizeSyncUrl(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_SYNC_URL;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('Sync URL must start with http:// or https://.');
  }

  return trimTrailingSlash(normalized);
}

function normalizeAbsolutePath(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return path.normalize(path.resolve(normalized));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeTransport(value: unknown): POSPrinterTransport {
  return value === 'system' || value === 'device' ? value : 'network';
}

function normalizeLanguage(value: unknown): POSPrinterLanguage {
  return value === 'zpl' ? 'zpl' : 'escpos';
}

function normalizeRole(value: unknown): POSPrinterRole {
  return value === 'label' ? 'label' : 'receipt';
}

/**
 * Printer entries come straight from a hand-editable JSON file, so every field is
 * clamped to a range the encoders and transports can actually honour.
 */
function normalizePrinters(value: unknown): POSPrinterConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const printers = value.flatMap((entry): POSPrinterConfig[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const source = entry as Partial<POSPrinterConfig>;
    const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : null;
    if (!id || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    const transport = normalizeTransport(source.transport);

    return [{
      id,
      name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : id,
      role: normalizeRole(source.role),
      language: normalizeLanguage(source.language),
      transport,
      address: typeof source.address === 'string' ? source.address.trim() : '',
      port: transport === 'network' ? clampNumber(source.port, 9100, 1, 65535) : 0,
      enabled: source.enabled !== false,
      isDefault: source.isDefault === true,
      copies: clampNumber(source.copies, DEFAULT_POS_PRINTER_CONFIG.copies, 1, 5),
      columns: clampNumber(source.columns, DEFAULT_POS_PRINTER_CONFIG.columns, 24, 96),
      cutPaper: source.cutPaper !== false,
      openDrawer: source.openDrawer === true,
      labelWidthMm: clampNumber(source.labelWidthMm, DEFAULT_POS_PRINTER_CONFIG.labelWidthMm, 10, 220),
      labelHeightMm: clampNumber(source.labelHeightMm, DEFAULT_POS_PRINTER_CONFIG.labelHeightMm, 10, 300),
      dpi: clampNumber(source.dpi, DEFAULT_POS_PRINTER_CONFIG.dpi, 152, 600),
      darkness: clampNumber(source.darkness, DEFAULT_POS_PRINTER_CONFIG.darkness, -30, 30),
    }];
  });

  // Exactly one default per role keeps job routing unambiguous.
  for (const role of ['receipt', 'label'] as const) {
    const forRole = printers.filter((printer) => printer.role === role);
    const firstDefault = forRole.find((printer) => printer.isDefault && printer.enabled)
      ?? forRole.find((printer) => printer.enabled)
      ?? forRole[0];

    for (const printer of forRole) {
      printer.isDefault = printer === firstDefault;
    }
  }

  return printers;
}

function normalizeScanner(value: unknown): POSScannerSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<POSScannerSettings>;

  return {
    enabled: source.enabled !== false,
    minLength: clampNumber(source.minLength, DEFAULT_POS_SCANNER_SETTINGS.minLength, 2, 32),
    maxInterKeyMs: clampNumber(source.maxInterKeyMs, DEFAULT_POS_SCANNER_SETTINGS.maxInterKeyMs, 10, 200),
    requireTerminator: source.requireTerminator !== false,
    prefix: typeof source.prefix === 'string' ? source.prefix.slice(0, 8) : '',
    beepOnScan: source.beepOnScan !== false,
  };
}

function toSnapshot(value: StoredDesktopSettings | null | undefined): POSDesktopSettings {
  return {
    sessionLockMinutes: clampNumber(value?.sessionLockMinutes, DEFAULT_POS_SESSION_LOCK_MINUTES, 1, 120),
    syncUrl: normalizeSyncUrl(value?.syncUrl),
    databasePath: normalizeAbsolutePath(value?.databasePath, getDefaultDatabasePath()),
    backupDirectory: normalizeAbsolutePath(value?.backupDirectory, getDefaultBackupDirectory()),
    themeMode: normalizeThemeMode(value?.themeMode),
    addDenominationsToPaymentList: value?.addDenominationsToPaymentList !== false,
    showDenominationCombinations: value?.showDenominationCombinations !== false,
    allowShortPayments: value?.allowShortPayments === true,
    printers: normalizePrinters(value?.printers),
    scanner: normalizeScanner(value?.scanner),
    priceOverride: normalizePriceOverrideSettings(value?.priceOverride),
    shortcuts: normalizeShortcutSettings(value?.shortcuts),
    shiftReconciliation: normalizeShiftReconciliation(value?.shiftReconciliation),
    customerDisplay: normalizeCustomerDisplaySettings(value?.customerDisplay),
    cashSalesVisibility: normalizeCashSalesVisibility(value?.cashSalesVisibility),
    cartLineOrder: normalizeCartLineOrder(value?.cartLineOrder),
  };
}

function parseStoredDesktopSettings(): StoredDesktopSettings {
  const settingsPath = getDesktopSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as StoredDesktopSettings : {};
  } catch (error) {
    reportElectronError(error, 'electron.settings.read');
    return {};
  }
}

function writeSnapshot(snapshot: POSDesktopSettings) {
  fs.writeFileSync(getDesktopSettingsPath(), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function backupDatabaseFile(sourcePath: string, destinationPath: string) {
  const sourceDb = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });

  return sourceDb.backup(destinationPath)
    .finally(() => {
      sourceDb.close();
    });
}

export function readDesktopSettings(): POSDesktopSettings {
  return toSnapshot(parseStoredDesktopSettings());
}

export function saveDesktopSettings(input: StoredDesktopSettings): POSDesktopSettings {
  const merged = toSnapshot({
    ...parseStoredDesktopSettings(),
    ...input,
  });

  ensureDirectory(path.dirname(merged.databasePath));
  ensureDirectory(merged.backupDirectory);
  writeSnapshot(merged);
  return merged;
}

export async function copyDatabaseSnapshotIfNeeded(sourcePath: string, destinationPath: string) {
  if (path.normalize(sourcePath) === path.normalize(destinationPath)) {
    return false;
  }

  if (!fs.existsSync(sourcePath) || fs.existsSync(destinationPath)) {
    return false;
  }

  ensureDirectory(path.dirname(destinationPath));
  await backupDatabaseFile(sourcePath, destinationPath);
  return true;
}

export async function createDesktopBackup(): Promise<POSDesktopBackupResult> {
  const settings = readDesktopSettings();
  if (!fs.existsSync(settings.databasePath)) {
    throw new Error(`No SQLite database was found at ${settings.databasePath}.`);
  }

  const backupDirectory = ensureDirectory(settings.backupDirectory);
  const timestamp = new Date()
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\.\d{3}Z$/, 'Z');
  const backupPath = path.join(backupDirectory, `jingles-pos-backup-${timestamp}.sqlite`);

  await backupDatabaseFile(settings.databasePath, backupPath);

  return {
    filePath: backupPath,
    createdAt: new Date().toISOString(),
  };
}

/** Same as {@link createDesktopBackup}, but to a caller-chosen destination (e.g. a save dialog). */
export async function backupDatabaseTo(destinationPath: string): Promise<POSDesktopBackupResult> {
  const settings = readDesktopSettings();
  if (!fs.existsSync(settings.databasePath)) {
    throw new Error(`No SQLite database was found at ${settings.databasePath}.`);
  }

  const resolvedDestination = path.resolve(destinationPath);
  ensureDirectory(path.dirname(resolvedDestination));
  await backupDatabaseFile(settings.databasePath, resolvedDestination);

  return {
    filePath: resolvedDestination,
    createdAt: new Date().toISOString(),
  };
}

export function getDatabaseInfo(): POSDatabaseInfo {
  const settings = readDesktopSettings();
  const currentPath = path.resolve(settings.databasePath);
  const defaultPath = path.resolve(getDefaultDatabasePath());
  const exists = fs.existsSync(currentPath);
  const stats = exists ? fs.statSync(currentPath) : null;

  return {
    currentPath,
    defaultPath,
    directory: path.dirname(currentPath),
    exists,
    sizeBytes: stats?.size ?? 0,
    lastModifiedAt: stats?.mtime.toISOString() ?? null,
    usesCustomPath: currentPath !== defaultPath,
  };
}

