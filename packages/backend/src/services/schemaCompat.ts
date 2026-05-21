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

export async function ensureLocalSchemaCompat() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  if (!(await hasTable('SyncDeviceState'))) {
    for (const statement of readMigrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }
  }

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
}
