import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { bootstrapFreshDesktopDatabase } from '../backend/freshDatabaseBootstrap';

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  '../../../backend/prisma/migrations',
);

describe('fresh desktop database bootstrap', () => {
  let testDirectory: string;
  let databasePath: string;

  beforeEach(() => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jingles-pos-bootstrap-'));
    databasePath = path.join(testDirectory, 'jingles-pos.sqlite');
  });

  afterEach(() => {
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  it('applies all bundled migrations to a new database', () => {
    const result = bootstrapFreshDesktopDatabase(databasePath, MIGRATIONS_DIRECTORY);
    const database = new Database(databasePath, { readonly: true });

    try {
      const syncColumns = database.prepare('PRAGMA table_info("SyncDeviceState")').all() as Array<{ name: string }>;
      const shiftColumns = database.prepare('PRAGMA table_info("ShiftCashCount")').all() as Array<{ name: string }>;

      expect(result.initialized).toBe(true);
      expect(result.migrationsApplied).toBeGreaterThan(0);
      expect(syncColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['online', 'lastError']),
      );
      expect(shiftColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['tenders', 'tenderMode']),
      );
    } finally {
      database.close();
    }
  });

  it('does not change an existing database', () => {
    const database = new Database(databasePath);
    database.exec('CREATE TABLE ExistingData (value TEXT NOT NULL); INSERT INTO ExistingData VALUES (\'keep-me\');');
    database.close();

    const result = bootstrapFreshDesktopDatabase(databasePath, MIGRATIONS_DIRECTORY);
    const verificationDatabase = new Database(databasePath, { readonly: true });

    try {
      expect(result).toEqual({ initialized: false, migrationsApplied: 0 });
      expect(verificationDatabase.prepare('SELECT value FROM ExistingData').pluck().get()).toBe('keep-me');
    } finally {
      verificationDatabase.close();
    }
  });
});
