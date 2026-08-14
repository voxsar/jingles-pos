import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

type TableNameRow = {
  name: string;
};

export type FreshDatabaseBootstrapResult = {
  initialized: boolean;
  migrationsApplied: number;
};

function listMigrationFiles(migrationsDirectory: string) {
  if (!fs.existsSync(migrationsDirectory)) {
    throw new Error(`POS database migrations were not found at ${migrationsDirectory}.`);
  }

  return fs.readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDirectory, entry.name, 'migration.sql'))
    .filter((migrationPath) => fs.existsSync(migrationPath))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Prisma does not create an SQLite schema when it first connects. Initialize a
 * truly empty desktop database from the bundled, ordered migrations before the
 * backend starts. Any database containing a user table is treated as an
 * existing installation and is left to the additive compatibility checks.
 */
export function bootstrapFreshDesktopDatabase(
  databasePath: string,
  migrationsDirectory: string,
): FreshDatabaseBootstrapResult {
  const database = new Database(databasePath);

  try {
    const existingTables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
    `).all() as TableNameRow[];

    if (existingTables.length > 0) {
      return { initialized: false, migrationsApplied: 0 };
    }

    const migrationFiles = listMigrationFiles(migrationsDirectory);
    if (migrationFiles.length === 0) {
      throw new Error(`No POS database migrations were found at ${migrationsDirectory}.`);
    }

    const applyMigrations = database.transaction(() => {
      for (const migrationPath of migrationFiles) {
        database.exec(fs.readFileSync(migrationPath, 'utf8'));
      }
    });

    applyMigrations();

    const requiredTables = ['Product', 'POSUser', 'SyncDeviceState'];
    const createdTables = new Set(
      (database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
      `).all() as TableNameRow[]).map((row) => row.name),
    );
    const missingTables = requiredTables.filter((tableName) => !createdTables.has(tableName));
    if (missingTables.length > 0) {
      throw new Error(`POS database initialization missed tables: ${missingTables.join(', ')}.`);
    }

    return { initialized: true, migrationsApplied: migrationFiles.length };
  } finally {
    database.close();
  }
}
