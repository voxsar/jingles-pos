import fs from 'fs';
import path from 'path';
import prisma from '../prisma';
import { isLocalPosBackendMode } from '../localMode';

type TableInfoRow = {
  name: string;
};

function getMigrationsDirectory() {
  return path.resolve(__dirname, '..', '..', 'prisma', 'migrations');
}

function readMigrationStatements() {
  const migrationsDirectory = getMigrationsDirectory();
  if (!fs.existsSync(migrationsDirectory)) {
    return [];
  }

  return fs.readdirSync(migrationsDirectory)
    .sort()
    .flatMap((entry) => {
      const migrationFile = path.join(migrationsDirectory, entry, 'migration.sql');
      if (!fs.existsSync(migrationFile)) {
        return [];
      }

      const source = fs.readFileSync(migrationFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');

      return source
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
    });
}

async function hasTable(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<TableInfoRow[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  );

  return rows.length > 0;
}

async function hasColumn(tableName: string, columnName: string) {
  const rows = await prisma.$queryRawUnsafe<TableInfoRow[]>(`PRAGMA table_info("${tableName}")`);
  return rows.some((row) => row.name === columnName);
}

async function hasIndex(indexName: string) {
  const rows = await prisma.$queryRawUnsafe<TableInfoRow[]>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    indexName,
  );

  return rows.length > 0;
}

async function shouldSkipStatement(statement: string) {
  const createTable = statement.match(/^CREATE TABLE (?:IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?/i);
  if (createTable) {
    return hasTable(createTable[1]);
  }

  const createIndex = statement.match(/^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?/i);
  if (createIndex) {
    return hasIndex(createIndex[1]);
  }

  const addColumn = statement.match(/^ALTER TABLE "?([A-Za-z0-9_]+)"? ADD COLUMN "?([A-Za-z0-9_]+)"?/i);
  if (addColumn) {
    return hasColumn(addColumn[1], addColumn[2]);
  }

  return false;
}

async function applyMigrationStatements() {
  for (const statement of readMigrationStatements()) {
    if (await shouldSkipStatement(statement)) {
      continue;
    }

    await prisma.$executeRawUnsafe(statement);
  }
}

export async function ensureLocalSchemaCompat() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  // Replay every migration statement idempotently so existing databases pick
  // up schema changes (new tables, indexes, columns) without a manual reset.
  await applyMigrationStatements();

  if (!(await hasColumn('SyncDeviceState', 'online'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SyncDeviceState" ADD COLUMN "online" BOOLEAN NOT NULL DEFAULT false`,
    );
  }

  if (!(await hasColumn('SyncDeviceState', 'lastError'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SyncDeviceState" ADD COLUMN "lastError" TEXT`,
    );
  }

  if (!(await hasColumn('POSUser', 'password_hash'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "POSUser" ADD COLUMN "password_hash" TEXT`,
    );
  }

  if (!(await hasTable('ConfigEntry'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "ConfigEntry" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
}
