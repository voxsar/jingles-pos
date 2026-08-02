import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import type {
  POSDesktopBackupResult,
  POSDesktopSettings,
  POSThemeMode,
} from '@jingles/shared';

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

function getDefaultDatabasePath() {
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

function toSnapshot(value: StoredDesktopSettings | null | undefined): POSDesktopSettings {
  return {
    syncUrl: normalizeSyncUrl(value?.syncUrl),
    databasePath: normalizeAbsolutePath(value?.databasePath, getDefaultDatabasePath()),
    backupDirectory: normalizeAbsolutePath(value?.backupDirectory, getDefaultBackupDirectory()),
    themeMode: normalizeThemeMode(value?.themeMode),
    addDenominationsToPaymentList: value?.addDenominationsToPaymentList !== false,
    showDenominationCombinations: value?.showDenominationCombinations !== false,
    allowShortPayments: value?.allowShortPayments === true,
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
  } catch {
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

