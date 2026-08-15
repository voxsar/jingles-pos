const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();

jest.mock('../prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
  },
}));

jest.mock('../localMode', () => ({
  isLocalPosBackendMode: () => true,
}));

const { ensureLocalSchemaCompat } = require('../services/schemaCompat') as typeof import('../services/schemaCompat');

describe('desktop schema compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryRawUnsafe.mockImplementation(async (sql: string, tableName?: string) => {
      if (sql.startsWith('SELECT name FROM sqlite_master')) {
        return [{ name: tableName }];
      }

      if (sql.includes('PRAGMA table_info("POSUser")')) {
        return [{ name: 'id' }, { name: 'password_hash' }];
      }

      return [{ name: 'existing_column' }];
    });
  });

  it('adds access and salesman columns to an existing desktop POSUser table', async () => {
    await ensureLocalSchemaCompat();

    expect(executeRawUnsafe).toHaveBeenCalledWith(
      'ALTER TABLE "POSUser" ADD COLUMN "access_scope" TEXT NOT NULL DEFAULT \'BOTH\'',
    );
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      'ALTER TABLE "POSUser" ADD COLUMN "is_salesman" BOOLEAN NOT NULL DEFAULT true',
    );
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      'ALTER TABLE "Product" ADD COLUMN "barcodes_json" TEXT',
    );
  });
});
