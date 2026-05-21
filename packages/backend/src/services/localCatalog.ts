import type { ProductPriceTier, Product, SharedCatalogSnapshot } from '@jingles/shared';
import prisma from '../prisma';
import { isLocalPosBackendMode } from '../localMode';

type LocalProductRow = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string | null;
  subcategory: string;
  packSize: number;
  unitLabel: string;
  stockOnHand: number;
  description: string | null;
};

function sortTiers<T extends { priority: number; minQty: number }>(tiers: T[]): T[] {
  return [...tiers].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.minQty - right.minQty;
  });
}

function mapPriceTiers(
  tiers: Array<{
    id: string;
    label: string | null;
    price: number;
    priority: number;
    minQty: number;
    isDefault: boolean;
  }>,
): ProductPriceTier[] {
  return sortTiers(
    tiers.map((tier) => ({
      id: tier.id,
      label: tier.label ?? (tier.minQty > 0 ? `Bulk ${tier.minQty}+` : 'Retail'),
      price: tier.price,
      priority: tier.priority ?? 0,
      minQty: tier.minQty ?? 0,
      isDefault: tier.isDefault ?? false,
    })),
  );
}

function mapProductRow(
  product: LocalProductRow,
  tiers: Array<{
    id: string;
    label: string | null;
    price: number;
    priority: number;
    minQty: number;
    isDefault: boolean;
  }>,
): Product {
  return {
    id: product.id,
    sku: product.sku,
    barcode: product.barcode ?? undefined,
    name: product.name,
    categoryId: product.categoryId ?? 'uncategorized',
    subcategory: product.subcategory ?? '',
    packSize: product.packSize ?? 1,
    unitLabel: product.unitLabel ?? 'pcs',
    stockOnHand: product.stockOnHand ?? 0,
    description: product.description ?? undefined,
    priceTiers: mapPriceTiers(tiers),
  };
}

export async function ensureLocalCatalogSearchIndex() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(
      id UNINDEXED,
      sku,
      barcode,
      name,
      subcategory,
      description
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER IF NOT EXISTS product_search_ai
    AFTER INSERT ON "Product"
    BEGIN
      INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
      VALUES (
        NEW.id,
        NEW.sku,
        COALESCE(NEW.barcode, ''),
        NEW.name,
        COALESCE(NEW.subcategory, ''),
        COALESCE(NEW.description, '')
      );
    END
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER IF NOT EXISTS product_search_ad
    AFTER DELETE ON "Product"
    BEGIN
      DELETE FROM product_search WHERE id = OLD.id;
    END
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER IF NOT EXISTS product_search_au
    AFTER UPDATE ON "Product"
    BEGIN
      DELETE FROM product_search WHERE id = OLD.id;
      INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
      VALUES (
        NEW.id,
        NEW.sku,
        COALESCE(NEW.barcode, ''),
        NEW.name,
        COALESCE(NEW.subcategory, ''),
        COALESCE(NEW.description, '')
      );
    END
  `);

  await rebuildLocalCatalogSearchIndex();
}

export async function rebuildLocalCatalogSearchIndex() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  await prisma.$executeRawUnsafe('DELETE FROM product_search');
  await prisma.$executeRawUnsafe(`
    INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
    SELECT
      id,
      sku,
      COALESCE(barcode, ''),
      name,
      COALESCE(subcategory, ''),
      COALESCE(description, '')
    FROM "Product"
  `);
}

export async function getLocalCatalogSnapshot(): Promise<SharedCatalogSnapshot> {
  const [categories, products] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.product.findMany({
      include: {
        batchPrices: {
          orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: { sku: 'asc' },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      icon: category.icon ?? category.name.slice(0, 2).toUpperCase(),
      sortOrder: category.sortOrder ?? 0,
    })),
    products: products.map((product) => mapProductRow(product, product.batchPrices)),
  };
}

export async function replaceLocalCatalogSnapshot(snapshot: SharedCatalogSnapshot) {
  await prisma.$transaction(async (tx) => {
    await tx.batchPrice.deleteMany();
    await tx.product.deleteMany();
    await tx.category.deleteMany();

    if (snapshot.categories.length > 0) {
      await tx.category.createMany({
        data: snapshot.categories.map((category) => ({
          id: category.id,
          name: category.name,
          icon: category.icon,
          sortOrder: category.sortOrder,
        })),
      });
    }

    if (snapshot.products.length > 0) {
      await tx.product.createMany({
        data: snapshot.products.map((product) => ({
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
          lastVectorClock: '{}',
        })),
      });
    }

    const batchPrices = snapshot.products.flatMap((product) =>
      product.priceTiers.map((tier) => ({
        id: tier.id,
        productId: product.id,
        label: tier.label,
        price: tier.price,
        priority: tier.priority,
        minQty: tier.minQty ?? 0,
        isDefault: tier.isDefault ?? false,
      })),
    );

    if (batchPrices.length > 0) {
      await tx.batchPrice.createMany({ data: batchPrices });
    }
  });

  await rebuildLocalCatalogSearchIndex();
}

function buildFtsQuery(query: string) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/["*()\[\]{}^~?:\\]/g, '').trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return '';
  }

  const lastToken = tokens.pop()!;
  return [...tokens, `${lastToken}*`].join(' ');
}

async function getProductsByIds(ids: string[]) {
  if (ids.length === 0) {
    return [];
  }

  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: {
      batchPrices: {
        orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
      },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => mapProductRow(row, row.batchPrices));
}

export async function searchLocalCatalog(query: string) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    const rows = await prisma.product.findMany({
      include: {
        batchPrices: {
          orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: { sku: 'asc' },
      take: 30,
    });
    return rows.map((row) => mapProductRow(row, row.batchPrices));
  }

  if (!isLocalPosBackendMode()) {
    const rows = await prisma.product.findMany({
      where: {
        OR: [
          { sku: { contains: trimmedQuery } },
          { name: { contains: trimmedQuery } },
          { barcode: trimmedQuery },
          { subcategory: { contains: trimmedQuery } },
        ],
      },
      include: {
        batchPrices: {
          orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: { sku: 'asc' },
      take: 30,
    });

    return rows.map((row) => mapProductRow(row, row.batchPrices));
  }

  const exactBarcodeIds = (
    await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT id
        FROM "Product"
        WHERE barcode = ?
        ORDER BY sku ASC
        LIMIT 5
      `,
      trimmedQuery,
    )
  ).map((row) => row.id);

  const ftsQuery = buildFtsQuery(trimmedQuery);
  if (!ftsQuery) {
    return getProductsByIds(exactBarcodeIds);
  }

  const ftsIds = (
    await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT p.id
        FROM product_search
        INNER JOIN "Product" p ON p.id = product_search.id
        WHERE product_search MATCH ?
          AND p.id NOT IN (
            SELECT id
            FROM "Product"
            WHERE barcode = ?
          )
        ORDER BY bm25(product_search), p.sku ASC
        LIMIT 30
      `,
      ftsQuery,
      trimmedQuery,
    )
  ).map((row) => row.id);

  return getProductsByIds([...exactBarcodeIds, ...ftsIds]);
}
