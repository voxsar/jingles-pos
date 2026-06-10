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

async function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (await hasColumn(tableName, columnName)) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`,
  );
}

export async function ensureLocalSchemaCompat() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  if (!(await hasTable('SyncDeviceState'))) {
    for (const statement of readMigrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }
  }

  await ensureColumn('SyncDeviceState', 'online', 'BOOLEAN NOT NULL DEFAULT false');
  await ensureColumn('SyncDeviceState', 'lastError', 'TEXT');
  await ensureColumn('POSUser', 'password_hash', 'TEXT');
  await ensureColumn('Product', 'variants_json', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variantId', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variantCode', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variantName', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variant_attributes_json', 'TEXT');
  await ensureColumn('SaleLine', 'variantId', 'TEXT');
  await ensureColumn('SaleLine', 'variantCode', 'TEXT');
  await ensureColumn('SaleLine', 'variantName', 'TEXT');
  await ensureColumn('SaleLine', 'variant_attributes_json', 'TEXT');
  await ensureColumn('ReturnLine', 'variantId', 'TEXT');

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
