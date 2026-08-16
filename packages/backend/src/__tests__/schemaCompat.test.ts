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

  describe('decimal quantity columns', () => {
    // Column types the default beforeEach mock doesn't cover, keyed the same
    // way ensureDecimalQuantityColumns looks them up: "<table>.<column>".
    const declareColumnTypes = (types: Record<string, string>) => {
      queryRawUnsafe.mockImplementation(async (sql: string, tableName?: string) => {
        if (sql.startsWith('SELECT name FROM sqlite_master')) {
          return [{ name: tableName }];
        }

        const tableMatch = /PRAGMA table_info\("(\w+)"\)/.exec(sql);
        const table = tableMatch?.[1];
        const rows = Object.entries(types)
          .filter(([key]) => key.startsWith(`${table}.`))
          .map(([key, type]) => ({ name: key.slice(table!.length + 1), type }));

        return rows.length > 0 ? rows : [{ name: 'existing_column', type: 'TEXT' }];
      });
    };

    it('rebuilds only the tables still carrying an INTEGER quantity column', async () => {
      declareColumnTypes({
        'Product.stockOnHand': 'INTEGER',
        'BatchPrice.minQty': 'REAL',
        'InventoryEvent.quantity': 'REAL',
        'SaleLine.quantity': 'INTEGER',
        'HeldSaleLine.quantity': 'REAL',
        'ReturnLine.quantity': 'REAL',
      });

      await ensureLocalSchemaCompat();

      expect(executeRawUnsafe).toHaveBeenCalledWith('PRAGMA foreign_keys=OFF');
      expect(executeRawUnsafe).toHaveBeenCalledWith('DROP TABLE "Product"');
      expect(executeRawUnsafe).toHaveBeenCalledWith('ALTER TABLE "new_Product" RENAME TO "Product"');
      expect(executeRawUnsafe).toHaveBeenCalledWith('DROP TABLE "SaleLine"');
      expect(executeRawUnsafe).toHaveBeenCalledWith('ALTER TABLE "new_SaleLine" RENAME TO "SaleLine"');
      expect(executeRawUnsafe).toHaveBeenCalledWith('PRAGMA foreign_keys=ON');

      expect(executeRawUnsafe).not.toHaveBeenCalledWith('DROP TABLE "BatchPrice"');
      expect(executeRawUnsafe).not.toHaveBeenCalledWith('DROP TABLE "InventoryEvent"');
      expect(executeRawUnsafe).not.toHaveBeenCalledWith('DROP TABLE "HeldSaleLine"');
      expect(executeRawUnsafe).not.toHaveBeenCalledWith('DROP TABLE "ReturnLine"');
    });

    it('is a no-op once every quantity column is already REAL', async () => {
      declareColumnTypes({
        'Product.stockOnHand': 'REAL',
        'BatchPrice.minQty': 'REAL',
        'InventoryEvent.quantity': 'REAL',
        'SaleLine.quantity': 'REAL',
        'HeldSaleLine.quantity': 'REAL',
        'ReturnLine.quantity': 'REAL',
      });

      await ensureLocalSchemaCompat();

      expect(executeRawUnsafe).not.toHaveBeenCalledWith('PRAGMA foreign_keys=OFF');
      expect(executeRawUnsafe).not.toHaveBeenCalledWith('DROP TABLE "Product"');
    });
  });
});
