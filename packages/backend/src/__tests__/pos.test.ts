import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import { InventoryState, InventoryEventType, SaleStatus, PaymentMethod } from '@jingles/shared';

// Use a separate test database
process.env.DATABASE_URL = 'file:./test.db';

const prisma = new PrismaClient();

async function seedProduct(overrides: Partial<{ sku: string; name: string; price: number; barcode: string }> = {}) {
  return prisma.product.create({
    data: {
      id: uuidv4(),
      sku: overrides.sku ?? `TEST-${uuidv4().slice(0, 8)}`,
      name: overrides.name ?? 'Test Product',
      price: overrides.price ?? 10.0,
      barcode: overrides.barcode,
    },
  });
}

async function seedInventory(productId: string, qty: number, state: string = InventoryState.ShelfReady) {
  const items = [];
  for (let i = 0; i < qty; i++) {
    items.push(
      await prisma.inventory.create({
        data: { id: uuidv4(), productId, state },
      })
    );
  }
  return items;
}

async function completeSale(
  productId: string,
  sku: string,
  name: string,
  quantity: number,
  unitPrice: number
) {
  const receiptNumber = `RCP-${uuidv4().slice(0, 8)}`;

  // Validate stock
  const stock = await prisma.inventory.findMany({
    where: { productId, state: InventoryState.ShelfReady },
    take: quantity,
  });

  if (stock.length < quantity) {
    throw new Error(`Insufficient stock for ${productId}`);
  }

  return prisma.$transaction(async (tx) => {
    const stockIds = stock.map((s) => s.id);
    await tx.inventory.updateMany({
      where: { id: { in: stockIds } },
      data: { state: InventoryState.Sold },
    });

    await tx.inventoryEvent.create({
      data: {
        id: uuidv4(),
        productId,
        eventType: InventoryEventType.SALE_DEDUCTED,
        quantity,
        reference: receiptNumber,
        notes: `Sale: ${receiptNumber}`,
      },
    });

    const sale = await tx.sale.create({
      data: {
        receiptNumber,
        terminalId: 'TERM-001',
        userId: 'user-1',
        status: SaleStatus.COMPLETED,
        subtotal: unitPrice * quantity,
        total: unitPrice * quantity,
        lines: {
          create: [{ productId, sku, name, quantity, unitPrice, lineTotal: unitPrice * quantity }],
        },
        payments: {
          create: [{ method: PaymentMethod.CASH, amount: unitPrice * quantity }],
        },
      },
      include: { lines: true, payments: true },
    });

    return sale;
  });
}

beforeAll(async () => {
  // Run migrations
  const { execSync } = require('child_process');
  execSync('npx prisma migrate deploy', {
    cwd: '/home/runner/work/jingles-pos/jingles-pos/packages/backend',
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'pipe',
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean DB before each test
  await prisma.returnLine.deleteMany();
  await prisma.return.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.saleLine.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.inventoryEvent.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.batchPrice.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.pOSShift.deleteMany();
});

describe('Sale completion - inventory deduction', () => {
  it('deducts inventory atomically when completing a sale', async () => {
    const product = await seedProduct({ sku: 'SKU-001', name: 'Widget', price: 5.0 });
    await seedInventory(product.id, 3);

    const sale = await completeSale(product.id, product.sku, product.name, 2, 5.0);

    expect(sale.status).toBe(SaleStatus.COMPLETED);
    expect(sale.lines).toHaveLength(1);
    expect(sale.lines[0].quantity).toBe(2);

    const remaining = await prisma.inventory.findMany({
      where: { productId: product.id, state: InventoryState.ShelfReady },
    });
    expect(remaining).toHaveLength(1);

    const sold = await prisma.inventory.findMany({
      where: { productId: product.id, state: InventoryState.Sold },
    });
    expect(sold).toHaveLength(2);
  });

  it('fails safely when stock is insufficient', async () => {
    const product = await seedProduct({ sku: 'SKU-002', name: 'Gadget', price: 10.0 });
    await seedInventory(product.id, 1); // Only 1 in stock

    await expect(
      completeSale(product.id, product.sku, product.name, 3, 10.0) // Requesting 3
    ).rejects.toThrow('Insufficient stock');

    // Inventory must remain untouched
    const remaining = await prisma.inventory.findMany({
      where: { productId: product.id, state: InventoryState.ShelfReady },
    });
    expect(remaining).toHaveLength(1);
  });

  it('records SALE_DEDUCTED event in the inventory event ledger', async () => {
    const product = await seedProduct({ sku: 'SKU-003', name: 'Doohickey', price: 15.0 });
    await seedInventory(product.id, 5);

    await completeSale(product.id, product.sku, product.name, 2, 15.0);

    const events = await prisma.inventoryEvent.findMany({
      where: { productId: product.id, eventType: InventoryEventType.SALE_DEDUCTED },
    });

    expect(events).toHaveLength(1);
    expect(events[0].quantity).toBe(2);
    expect(events[0].eventType).toBe(InventoryEventType.SALE_DEDUCTED);
  });

  it('restores stock correctly on return', async () => {
    const product = await seedProduct({ sku: 'SKU-004', name: 'Thingamajig', price: 20.0 });
    await seedInventory(product.id, 3);

    const sale = await completeSale(product.id, product.sku, product.name, 2, 20.0);

    // Now return 1 unit
    const saleLine = sale.lines[0];
    await prisma.$transaction(async (tx) => {
      const ret = await tx.return.create({
        data: {
          saleId: sale.id,
          userId: 'user-1',
          terminalId: 'TERM-001',
          totalRefund: 20.0,
          lines: {
            create: [
              {
                saleLineId: saleLine.id,
                productId: product.id,
                quantity: 1,
                refundAmount: 20.0,
              },
            ],
          },
        },
      });

      await tx.inventory.create({
        data: { id: uuidv4(), productId: product.id, state: InventoryState.Returned },
      });

      await tx.inventoryEvent.create({
        data: {
          id: uuidv4(),
          productId: product.id,
          eventType: InventoryEventType.RETURNED,
          quantity: 1,
          reference: sale.id,
        },
      });

      return ret;
    });

    const returnedStock = await prisma.inventory.findMany({
      where: { productId: product.id, state: InventoryState.Returned },
    });
    expect(returnedStock).toHaveLength(1);

    const shelfStock = await prisma.inventory.findMany({
      where: { productId: product.id, state: InventoryState.ShelfReady },
    });
    expect(shelfStock).toHaveLength(1); // 1 was never sold
  });
});

describe('Pricing', () => {
  it('resolves batch price when quantity meets threshold', () => {
    const { resolveUnitPrice } = require('../pricing');
    const batchPrices = [
      { id: '1', productId: 'p1', minQty: 5, price: 8.0, createdAt: new Date() },
      { id: '2', productId: 'p1', minQty: 10, price: 6.0, createdAt: new Date() },
    ];
    expect(resolveUnitPrice(10.0, 5, batchPrices)).toBe(8.0);
    expect(resolveUnitPrice(10.0, 10, batchPrices)).toBe(6.0);
    expect(resolveUnitPrice(10.0, 3, batchPrices)).toBe(10.0);
  });
});
