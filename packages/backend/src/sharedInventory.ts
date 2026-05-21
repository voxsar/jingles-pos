import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import type { ProductPriceTier, SharedCatalogSnapshot } from '@jingles/shared';
import prisma from './prisma';

type SharedCategoryRow = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number | null;
};

type SharedSkuRow = {
  id: string;
  sku_code: string;
  name: string;
  description: string | null;
  category_id: string | null;
  unit_of_measure: string | null;
  selling_price: number | null;
  wholesale_price: number | null;
  bulk_price: number | null;
  batch_pricing: unknown;
  barcode: string | null;
  stock_on_hand: number | string | null;
};

type SharedSaleLine = {
  productId: string;
  sku: string;
  quantity: number;
  name?: string;
};

type SharedInventoryChange = {
  tableName: 'inventory_records' | 'inventory_events';
  rowId: string;
  action: 'upsert' | 'delete';
};

const SHARED_INVENTORY_DATABASE_URL = process.env.SHARED_INVENTORY_DATABASE_URL?.trim();
const SHARED_CATALOG_SYNC_TTL_MS = Number(process.env.SHARED_CATALOG_SYNC_TTL_MS ?? 60_000);
const SHELF_READY_STATE = 'ShelfReady';

let pool: Pool | null = null;
let cachedSnapshot: SharedCatalogSnapshot | null = null;
let lastSyncedAt = 0;
let inFlightSync: Promise<SharedCatalogSnapshot> | null = null;

function getSharedInventoryPool(): Pool {
  if (!SHARED_INVENTORY_DATABASE_URL) {
    throw new Error('SHARED_INVENTORY_DATABASE_URL is not configured');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: SHARED_INVENTORY_DATABASE_URL,
      max: 4,
    });
  }

  return pool;
}

function buildCategoryIcon(name: string): string {
  const tokens = name
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return 'CT';
  }

  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 2).toUpperCase();
  }

  return `${tokens[0]![0] ?? ''}${tokens[1]![0] ?? ''}`.toUpperCase();
}

function resolveRootCategory(
  categoryId: string | null,
  categoriesById: Map<string, SharedCategoryRow>,
): { categoryId: string; subcategory: string } {
  if (!categoryId) {
    return {
      categoryId: 'uncategorized',
      subcategory: '',
    };
  }

  const current = categoriesById.get(categoryId);
  if (!current) {
    return {
      categoryId: 'uncategorized',
      subcategory: '',
    };
  }

  let root = current;
  while (root.parent_id && categoriesById.has(root.parent_id)) {
    root = categoriesById.get(root.parent_id)!;
  }

  return {
    categoryId: root.id,
    subcategory: root.id === current.id ? '' : current.name,
  };
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function buildPriceTiers(row: SharedSkuRow): ProductPriceTier[] {
  const tiers: ProductPriceTier[] = [];

  if (Number.isFinite(row.selling_price)) {
    tiers.push({
      id: `${row.id}-retail`,
      label: 'Retail',
      price: Number(row.selling_price),
      priority: 0,
      minQty: 0,
      isDefault: true,
    });
  }

  if (Number.isFinite(row.wholesale_price)) {
    tiers.push({
      id: `${row.id}-wholesale`,
      label: 'Wholesale',
      price: Number(row.wholesale_price),
      priority: 1,
      minQty: 0,
    });
  }

  if (Number.isFinite(row.bulk_price)) {
    tiers.push({
      id: `${row.id}-bulk`,
      label: 'Bulk',
      price: Number(row.bulk_price),
      priority: 2,
      minQty: 0,
    });
  }

  if (Array.isArray(row.batch_pricing)) {
    row.batch_pricing.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }

      const minQty = normalizeNumber((entry as Record<string, unknown>).minQty, 0);
      const price = normalizeNumber((entry as Record<string, unknown>).price, NaN);
      if (!Number.isFinite(price)) {
        return;
      }

      tiers.push({
        id: `${row.id}-qty-${index}`,
        label: minQty > 0 ? `Qty ${minQty}+` : 'Retail',
        price,
        priority: 10 + index,
        minQty,
      });
    });
  }

  if (tiers.length === 0) {
    tiers.push({
      id: `${row.id}-retail`,
      label: 'Retail',
      price: 0,
      priority: 0,
      minQty: 0,
      isDefault: true,
    });
  }

  return tiers
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return (left.minQty ?? 0) - (right.minQty ?? 0);
    })
    .map((tier, index) => ({
      ...tier,
      isDefault: index === 0 ? true : tier.isDefault,
    }));
}

async function fetchSharedCatalogSnapshotFromSource(): Promise<SharedCatalogSnapshot> {
  const inventory = getSharedInventoryPool();
  const [categoriesResult, skuResult] = await Promise.all([
    inventory.query<SharedCategoryRow>(
      `
        SELECT id, name, parent_id, sort_order
        FROM categories
        WHERE is_active = TRUE
        ORDER BY sort_order ASC, name ASC
      `,
    ),
    inventory.query<SharedSkuRow>(
      `
        WITH shelf_ready_stock AS (
          SELECT sku_id, COALESCE(SUM(quantity), 0) AS stock_on_hand
          FROM inventory_records
          WHERE state = $1
          GROUP BY sku_id
        ),
        preferred_barcodes AS (
          SELECT DISTINCT ON (sku_id) sku_id, barcode
          FROM product_barcodes
          ORDER BY sku_id, is_default DESC, created_at ASC
        )
        SELECT
          s.id,
          s.sku_code,
          s.name,
          s.description,
          s.category_id,
          s.unit_of_measure,
          s.selling_price,
          s.wholesale_price,
          s.bulk_price,
          s.batch_pricing,
          pb.barcode,
          COALESCE(sr.stock_on_hand, 0) AS stock_on_hand
        FROM skus s
        LEFT JOIN preferred_barcodes pb ON pb.sku_id = s.id
        LEFT JOIN shelf_ready_stock sr ON sr.sku_id = s.id
        WHERE s.is_active = TRUE
        ORDER BY s.sku_code ASC
      `,
      [SHELF_READY_STATE],
    ),
  ]);

  const categoriesById = new Map(categoriesResult.rows.map((category) => [category.id, category]));
  const categoryListById = new Map(
    categoriesResult.rows.map((category) => [
      category.id,
      {
        id: category.id,
        name: category.name,
        icon: buildCategoryIcon(category.name),
        sortOrder: category.sort_order ?? 0,
      },
    ]),
  );

  const products = skuResult.rows.map((row) => {
    const categoryMeta = resolveRootCategory(row.category_id, categoriesById);
    return {
      id: row.id,
      sku: row.sku_code,
      barcode: row.barcode ?? undefined,
      name: row.name,
      categoryId: categoryMeta.categoryId,
      subcategory: categoryMeta.subcategory,
      packSize: 1,
      unitLabel: row.unit_of_measure?.trim() || 'pcs',
      stockOnHand: normalizeNumber(row.stock_on_hand),
      description: row.description ?? undefined,
      priceTiers: buildPriceTiers(row),
    };
  });

  const categories: SharedCatalogSnapshot['categories'] = [];
  const usedCategoryIds = new Set<string>();
  for (const product of products) {
    if (usedCategoryIds.has(product.categoryId)) {
      continue;
    }

    if (product.categoryId === 'uncategorized') {
      categories.push({
        id: 'uncategorized',
        name: 'Uncategorized',
        icon: 'UN',
        sortOrder: 9999,
      });
      usedCategoryIds.add(product.categoryId);
      continue;
    }

    const category = categoryListById.get(product.categoryId);
    if (category) {
      categories.push(category);
      usedCategoryIds.add(product.categoryId);
    }
  }

  if (categories.length === 0) {
    categories.push({
      id: 'uncategorized',
      name: 'Uncategorized',
      icon: 'UN',
      sortOrder: 9999,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    categories: categories
      .sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }
        return left.name.localeCompare(right.name);
      }),
    products,
  };
}

async function syncProjection(snapshot: SharedCatalogSnapshot): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const category of snapshot.categories) {
      await tx.category.upsert({
        where: { id: category.id },
        update: {
          name: category.name,
          icon: category.icon,
          sortOrder: category.sortOrder,
        },
        create: {
          id: category.id,
          name: category.name,
          icon: category.icon,
          sortOrder: category.sortOrder,
        },
      });
    }

    for (const product of snapshot.products) {
      await tx.product.upsert({
        where: { id: product.id },
        update: {
          sku: product.sku,
          barcode: product.barcode ?? null,
          name: product.name,
          price: product.priceTiers[0]?.price ?? 0,
          categoryId: product.categoryId,
          subcategory: product.subcategory,
          packSize: Math.max(1, Math.round(product.packSize || 1)),
          unitLabel: product.unitLabel,
          stockOnHand: Math.max(0, Math.round(product.stockOnHand)),
          description: product.description ?? null,
        },
        create: {
          id: product.id,
          sku: product.sku,
          barcode: product.barcode ?? null,
          name: product.name,
          price: product.priceTiers[0]?.price ?? 0,
          categoryId: product.categoryId,
          subcategory: product.subcategory,
          packSize: Math.max(1, Math.round(product.packSize || 1)),
          unitLabel: product.unitLabel,
          stockOnHand: Math.max(0, Math.round(product.stockOnHand)),
          description: product.description ?? null,
        },
      });

      await tx.batchPrice.deleteMany({
        where: { productId: product.id },
      });

      if (product.priceTiers.length > 0) {
        await tx.batchPrice.createMany({
          data: product.priceTiers.map((tier) => ({
            id: tier.id,
            productId: product.id,
            label: tier.label,
            price: tier.price,
            priority: tier.priority,
            minQty: tier.minQty ?? 0,
            isDefault: tier.isDefault ?? false,
          })),
        });
      }
    }
  });
}

export async function syncSharedCatalogProjection(options?: {
  force?: boolean;
}): Promise<SharedCatalogSnapshot> {
  const force = options?.force ?? false;

  if (
    !force &&
    cachedSnapshot &&
    Date.now() - lastSyncedAt < SHARED_CATALOG_SYNC_TTL_MS
  ) {
    return cachedSnapshot;
  }

  if (inFlightSync) {
    return inFlightSync;
  }

  inFlightSync = (async () => {
    const snapshot = await fetchSharedCatalogSnapshotFromSource();
    await syncProjection(snapshot);
    cachedSnapshot = snapshot;
    lastSyncedAt = Date.now();
    return snapshot;
  })();

  try {
    return await inFlightSync;
  } finally {
    inFlightSync = null;
  }
}

export function getCachedSharedCatalogSnapshot(): SharedCatalogSnapshot | null {
  return cachedSnapshot;
}

async function withSharedInventoryTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getSharedInventoryPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordSharedInventoryChanges(
  client: PoolClient,
  input: {
    aggregateId: string;
    aggregateType?: string;
    changes: SharedInventoryChange[];
  },
) {
  if (input.changes.length === 0) {
    return null;
  }

  const sequenceResult = await client.query<{ seq: number }>(
    `
      INSERT INTO sync_server_sequence (operation_id, aggregate_type, aggregate_id)
      VALUES ($1, $2, $3)
      RETURNING seq
    `,
    [null, input.aggregateType ?? 'inventory_record', input.aggregateId],
  );

  const seq = sequenceResult.rows[0]?.seq ?? null;
  if (seq == null) {
    return null;
  }

  const values: Array<string | number> = [];
  const placeholders = input.changes.map((change, index) => {
    const offset = index * 4;
    values.push(seq, change.tableName, change.rowId, change.action);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  });

  await client.query(
    `
      INSERT INTO sync_server_changes (seq, table_name, row_id, action)
      VALUES ${placeholders.join(', ')}
    `,
    values,
  );

  return seq;
}

export async function applySharedInventorySale(
  input: {
    aggregateId: string;
    receiptNumber: string;
    terminalId?: string | null;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await withSharedInventoryTransaction(async (client) => {
    for (const line of input.lines) {
      const requestedQuantity = normalizeNumber(line.quantity);
      if (requestedQuantity <= 0) {
        continue;
      }

      const recordResult = await client.query<{ id: string; quantity: number | string }>(
        `
          SELECT id, quantity
          FROM inventory_records
          WHERE sku_id = $1
            AND state = $2
            AND quantity > 0
          ORDER BY updated_at ASC, created_at ASC
          FOR UPDATE
        `,
        [line.productId, SHELF_READY_STATE],
      );

      const totalBefore = recordResult.rows.reduce(
        (sum, row) => sum + normalizeNumber(row.quantity),
        0,
      );
      if (totalBefore < requestedQuantity) {
        throw new Error(`Insufficient ShelfReady stock for ${line.sku}`);
      }

      let remaining = requestedQuantity;
      const changedRecordIds: string[] = [];

      for (const row of recordResult.rows) {
        if (remaining <= 0) {
          break;
        }

        const currentQuantity = normalizeNumber(row.quantity);
        const delta = Math.min(remaining, currentQuantity);
        const afterQuantity = currentQuantity - delta;

        await client.query(
          `
            UPDATE inventory_records
            SET quantity = $1,
                source_event_id = $2,
                terminal_id = $3,
                version = version + 1,
                updated_at = NOW()
            WHERE id = $4
          `,
          [afterQuantity, input.aggregateId, input.terminalId ?? null, row.id],
        );

        changedRecordIds.push(row.id);
        remaining -= delta;
      }

      const eventId = randomUUID();
      await client.query(
        `
          INSERT INTO inventory_events (
            id,
            event_type,
            parent_entity_id,
            quantity_delta,
            before_quantity,
            after_quantity,
            terminal_id,
            override_flag,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8::jsonb)
        `,
        [
          eventId,
          'SALE_DEDUCTED',
          input.aggregateId,
          -requestedQuantity,
          totalBefore,
          totalBefore - requestedQuantity,
          input.terminalId ?? null,
          JSON.stringify({
            receiptNumber: input.receiptNumber,
            skuId: line.productId,
            skuCode: line.sku,
            productName: line.name ?? null,
          }),
        ],
      );

      await recordSharedInventoryChanges(client, {
        aggregateId: input.aggregateId,
        changes: [
          ...changedRecordIds.map((rowId) => ({
            tableName: 'inventory_records' as const,
            rowId,
            action: 'upsert' as const,
          })),
          {
            tableName: 'inventory_events',
            rowId: eventId,
            action: 'upsert',
          },
        ],
      });
    }
  });
}

async function applySharedInventoryIncrease(
  input: {
    aggregateId: string;
    terminalId?: string | null;
    eventType: 'RETURN_RECEIVED' | 'MANUAL_ADJUSTMENT';
    reasonCode?: string | null;
    metadata: Record<string, unknown>;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await withSharedInventoryTransaction(async (client) => {
    for (const line of input.lines) {
      const quantity = normalizeNumber(line.quantity);
      if (quantity <= 0) {
        continue;
      }

      const recordId = randomUUID();
      await client.query(
        `
          INSERT INTO inventory_records (
            id,
            sku_id,
            quantity,
            state,
            source_event_id,
            terminal_id,
            version
          )
          VALUES ($1, $2, $3, $4, $5, $6, 1)
        `,
        [
          recordId,
          line.productId,
          quantity,
          SHELF_READY_STATE,
          input.aggregateId,
          input.terminalId ?? null,
        ],
      );

      const eventId = randomUUID();
      await client.query(
        `
          INSERT INTO inventory_events (
            id,
            event_type,
            parent_entity_id,
            quantity_delta,
            before_quantity,
            after_quantity,
            reason_code,
            terminal_id,
            override_flag,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9::jsonb)
        `,
        [
          eventId,
          input.eventType,
          input.aggregateId,
          quantity,
          0,
          quantity,
          input.reasonCode ?? null,
          input.terminalId ?? null,
          JSON.stringify({
            ...input.metadata,
            skuId: line.productId,
            skuCode: line.sku,
            productName: line.name ?? null,
          }),
        ],
      );

      await recordSharedInventoryChanges(client, {
        aggregateId: input.aggregateId,
        changes: [
          {
            tableName: 'inventory_records',
            rowId: recordId,
            action: 'upsert',
          },
          {
            tableName: 'inventory_events',
            rowId: eventId,
            action: 'upsert',
          },
        ],
      });
    }
  });
}

export async function applySharedInventoryVoid(
  input: {
    aggregateId: string;
    receiptNumber: string;
    terminalId?: string | null;
    reason?: string | null;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await applySharedInventoryIncrease({
    aggregateId: input.aggregateId,
    terminalId: input.terminalId,
    eventType: 'MANUAL_ADJUSTMENT',
    reasonCode: 'POS_SALE_VOID',
    metadata: {
      receiptNumber: input.receiptNumber,
      reason: input.reason ?? null,
      source: 'pos-sale-void',
    },
    lines: input.lines,
  });
}

export async function applySharedInventoryReturn(
  input: {
    aggregateId: string;
    saleId: string;
    terminalId?: string | null;
    reason?: string | null;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await applySharedInventoryIncrease({
    aggregateId: input.aggregateId,
    terminalId: input.terminalId,
    eventType: 'RETURN_RECEIVED',
    reasonCode: input.reason ?? null,
    metadata: {
      saleId: input.saleId,
      reason: input.reason ?? null,
      source: 'pos-return',
    },
    lines: input.lines,
  });
}
