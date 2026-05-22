import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { readDesktopSettings } from '../desktopSettings';

function ensureDirectory(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  return dirPath;
}

export function getDesktopRuntimeRoot() {
  return ensureDirectory(path.join(app.getPath('userData'), 'backend'));
}

export function getDesktopDatabasePath() {
  const configuredPath = readDesktopSettings().databasePath;
  ensureDirectory(path.dirname(configuredPath));
  return configuredPath;
}

export function getDesktopSqliteDatabaseUrl() {
  const databasePath = getDesktopDatabasePath().replace(/\\/g, '/');

  if (/^[A-Za-z]:\//.test(databasePath) || databasePath.startsWith('//')) {
    return `file:${databasePath}`;
  }

  return databasePath.startsWith('/') ? `file:${databasePath}` : `file:/${databasePath}`;
}

export function getDesktopBackendResourcePath(...segments: string[]) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', ...segments);
  }

  return path.resolve(app.getAppPath(), '..', 'backend', ...segments);
}

export function getDesktopBackendEntryPath() {
  return getDesktopBackendResourcePath('dist', 'server.js');
}
