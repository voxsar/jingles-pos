import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import type {
  ProductPriceTier,
  ProductVariant,
  ProductVariantAttributeValue,
  SharedCatalogSnapshot,
} from '@jingles/shared';
import { UserRole } from '@jingles/shared';
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
  barcodes: string[] | null;
  stock_on_hand: number | string | null;
  stock_by_branch: Record<string, number> | null;
};

type SharedVariantRow = {
  sku_id: string;
  variant_id: string;
  variant_code: string;
  variant_name: string | null;
  barcodes: string[] | null;
  variant_stock_on_hand: number | string | null;
  stock_by_branch: Record<string, number> | null;
  selling_price: number | null;
  wholesale_price: number | null;
  bulk_price: number | null;
  attribute_id: string | null;
  attribute_name: string | null;
  attribute_type: string | null;
  attribute_sort_order: number | null;
  value_id: string | null;
  value_display_name: string | null;
  value_represented_value: string | null;
  value_sort_order: number | null;
};

type SharedSaleLine = {
  productId: string;
  sku: string;
  quantity: number;
  name?: string;
  variantId?: string | null;
  variantCode?: string | null;
  variantName?: string | null;
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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
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

function buildProductVariants(rows: SharedVariantRow[]): Map<string, ProductVariant[]> {
  const variantsByProduct = new Map<string, Map<string, ProductVariant>>();

  for (const row of rows) {
    const productVariants = variantsByProduct.get(row.sku_id) ?? new Map<string, ProductVariant>();
    const variant: ProductVariant = productVariants.get(row.variant_id) ?? {
      id: row.variant_id,
      productId: row.sku_id,
      variantCode: row.variant_code,
      barcodes: row.barcodes ?? [],
      name: row.variant_name ?? undefined,
      stockOnHand: normalizeNumber(row.variant_stock_on_hand),
      stockByBranch: row.stock_by_branch ?? {},
      priceTiers: buildPriceTiers({
        id: row.variant_id,
        selling_price: row.selling_price,
        wholesale_price: row.wholesale_price,
        bulk_price: row.bulk_price,
        batch_pricing: [],
      } as SharedSkuRow),
      attributes: [],
    };

    if (row.attribute_id && row.value_id) {
      const alreadyPresent = variant.attributes.some((entry) => (
        entry.attributeId === row.attribute_id && entry.valueId === row.value_id
      ));

      if (!alreadyPresent) {
        variant.attributes.push({
          attributeId: row.attribute_id,
          attributeName: row.attribute_name ?? row.attribute_id,
          attributeType: (row.attribute_type as ProductVariantAttributeValue['attributeType']) ?? undefined,
          valueId: row.value_id,
          value: row.value_display_name ?? row.value_represented_value ?? row.value_id,
          representedValue: row.value_represented_value ?? undefined,
          sortOrder: row.attribute_sort_order ?? row.value_sort_order ?? 0,
        });
      }
    }

    productVariants.set(row.variant_id, variant);
    variantsByProduct.set(row.sku_id, productVariants);
  }

  return new Map(
    Array.from(variantsByProduct.entries()).map(([skuId, variants]) => [
      skuId,
      Array.from(variants.values())
        .map((variant) => ({
          ...variant,
          attributes: [...variant.attributes].sort((left, right) => {
            if ((left.sortOrder ?? 0) !== (right.sortOrder ?? 0)) {
              return (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
            }
            if (left.attributeName !== right.attributeName) {
              return left.attributeName.localeCompare(right.attributeName);
            }
            return left.value.localeCompare(right.value);
          }),
        }))
        .sort((left, right) => left.variantCode.localeCompare(right.variantCode)),
    ]),
  );
}

async function fetchSharedCatalogSnapshotFromSource(): Promise<SharedCatalogSnapshot> {
  const inventory = getSharedInventoryPool();
  const [categoriesResult, skuResult, variantResult, branchesResult, usersResult, overlaysResult] = await Promise.all([
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
          SELECT x.sku_id, SUM(x.branch_qty) AS stock_on_hand,
            COALESCE(jsonb_object_agg(x.branch_id, x.branch_qty) FILTER (WHERE x.branch_id IS NOT NULL), '{}'::jsonb) AS stock_by_branch
          FROM (
            SELECT ir.sku_id, f.branch_id, SUM(ir.quantity) AS branch_qty
            FROM inventory_records ir LEFT JOIN floors f ON f.id = ir.floor_id
            WHERE ir.state = $1 GROUP BY ir.sku_id, f.branch_id
          ) x GROUP BY x.sku_id
        ),
        preferred_barcodes AS (
          SELECT DISTINCT ON (sku_id) sku_id, barcode
          FROM product_barcodes
          ORDER BY sku_id, is_default DESC, created_at ASC
        ),
        all_barcodes AS (
          SELECT sku_id, array_agg(barcode ORDER BY is_default DESC, created_at ASC) AS barcodes
          FROM product_barcodes
          GROUP BY sku_id
        )
        SELECT
          s.id,
          s.sku_code,
          s.name,
          s.description,
          s.category_id,
          s.unit_of_measure,
          COALESCE(latest.selling_price, s.selling_price) AS selling_price,
          COALESCE(latest.wholesale_price, s.wholesale_price) AS wholesale_price,
          COALESCE(latest.bulk_price, s.bulk_price) AS bulk_price,
          s.batch_pricing,
          pb.barcode,
          COALESCE(ab.barcodes, ARRAY[]::text[]) AS barcodes,
          COALESCE(sr.stock_on_hand, 0) AS stock_on_hand,
          COALESCE(sr.stock_by_branch, '{}'::jsonb) AS stock_by_branch
        FROM skus s
        LEFT JOIN preferred_barcodes pb ON pb.sku_id = s.id
        LEFT JOIN all_barcodes ab ON ab.sku_id = s.id
        LEFT JOIN shelf_ready_stock sr ON sr.sku_id = s.id
        LEFT JOIN LATERAL (
          SELECT selling_price, wholesale_price, bulk_price FROM batches
          WHERE sku_id = s.id AND variant_id IS NULL AND is_active = TRUE
          ORDER BY created_at DESC LIMIT 1
        ) latest ON TRUE
        WHERE s.is_active = TRUE
        ORDER BY s.sku_code ASC
      `,
      [SHELF_READY_STATE],
    ),
    inventory.query<SharedVariantRow>(
      `
        WITH variant_stock AS (
          SELECT x.variant_id, SUM(x.branch_qty) AS stock_on_hand,
            COALESCE(jsonb_object_agg(x.branch_id, x.branch_qty) FILTER (WHERE x.branch_id IS NOT NULL), '{}'::jsonb) AS stock_by_branch
          FROM (
            SELECT ir.variant_id, f.branch_id, SUM(ir.quantity) AS branch_qty
            FROM inventory_records ir LEFT JOIN floors f ON f.id = ir.floor_id
            WHERE ir.state = $1 AND ir.variant_id IS NOT NULL GROUP BY ir.variant_id, f.branch_id
          ) x GROUP BY x.variant_id
        )
        SELECT
          v.sku_id,
          v.id AS variant_id,
          v.variant_code,
          v.name AS variant_name,
          COALESCE(vb.barcodes, ARRAY[]::text[]) AS barcodes,
          COALESCE(vs.stock_on_hand, 0) AS variant_stock_on_hand,
          COALESCE(vs.stock_by_branch, '{}'::jsonb) AS stock_by_branch,
          COALESCE(bp.selling_price, s.selling_price) AS selling_price,
          COALESCE(bp.wholesale_price, s.wholesale_price) AS wholesale_price,
          COALESCE(bp.bulk_price, s.bulk_price) AS bulk_price,
          a.id AS attribute_id,
          a.name AS attribute_name,
          a.type AS attribute_type,
          a.sort_order AS attribute_sort_order,
          av.id AS value_id,
          av.display_name AS value_display_name,
          av.represented_value AS value_represented_value,
          av.sort_order AS value_sort_order
        FROM sku_variants v
        INNER JOIN skus s ON s.id = v.sku_id
        LEFT JOIN variant_stock vs ON vs.variant_id = v.id
        LEFT JOIN LATERAL (
          SELECT array_agg(barcode ORDER BY is_default DESC, created_at ASC) AS barcodes
          FROM product_barcodes
          WHERE variant_id = v.id
        ) vb ON TRUE
        LEFT JOIN LATERAL (
          SELECT selling_price, wholesale_price, bulk_price FROM batches
          WHERE sku_id = v.sku_id AND variant_id = v.id AND is_active = TRUE
          ORDER BY created_at DESC LIMIT 1
        ) bp ON TRUE
        LEFT JOIN sku_variant_values svv ON svv.variant_id = v.id
        LEFT JOIN attributes a ON a.id = svv.attribute_id
        LEFT JOIN attribute_values av ON av.id = svv.attribute_value_id
        WHERE s.is_active = TRUE
          AND v.is_active = TRUE
        ORDER BY
          s.sku_code ASC,
          v.variant_code ASC,
          COALESCE(a.sort_order, 0) ASC,
          a.name ASC,
          COALESCE(av.sort_order, 0) ASC,
          av.display_name ASC
      `,
      [SHELF_READY_STATE],
    ),
    inventory.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM branches WHERE is_active = TRUE ORDER BY code`),
    inventory.query<{ id: string; email: string; role: string; access_scope: string; is_salesman: boolean }>(`SELECT id, email, role, access_scope, is_salesman FROM users WHERE is_active = TRUE AND access_scope IN ('CASHIER','BOTH','ADMIN') ORDER BY email`),
    inventory.query<any>(`SELECT id, name, type, value, applies_to, conditions, priority, stackable, valid_from, valid_to FROM pricing_overlays WHERE status = 'active' AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to >= NOW()) ORDER BY priority DESC`),
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
  const variantsByProduct = buildProductVariants(variantResult.rows);

  const products = skuResult.rows.map((row) => {
    const categoryMeta = resolveRootCategory(row.category_id, categoriesById);
    return {
      id: row.id,
      sku: row.sku_code,
      barcode: row.barcode ?? undefined,
      barcodes: row.barcodes ?? [],
      name: row.name,
      categoryId: categoryMeta.categoryId,
      subcategory: categoryMeta.subcategory,
      packSize: 1,
      unitLabel: row.unit_of_measure?.trim() || 'pcs',
      stockOnHand: normalizeNumber(row.stock_on_hand),
      stockByBranch: row.stock_by_branch ?? {},
      description: row.description ?? undefined,
      priceTiers: buildPriceTiers(row),
      variants: variantsByProduct.get(row.id) ?? [],
      pricingRules: overlaysResult.rows.filter((overlay: any) => {
        const target = overlay.applies_to ?? {};
        return (!target.skuIds?.length && !target.categoryIds?.length) || target.skuIds?.includes(row.id) || (row.category_id && target.categoryIds?.includes(row.category_id));
      }).map((overlay: any) => ({ id: overlay.id, name: overlay.name, type: overlay.type, value: overlay.value, priority: overlay.priority, stackable: overlay.stackable, ...(overlay.applies_to ?? {}), ...(overlay.conditions ?? {}), validFrom: overlay.valid_from?.toISOString(), validTo: overlay.valid_to?.toISOString() })),
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
    branches: branchesResult.rows,
    users: usersResult.rows.map((user) => {
      const name = user.email.split('@')[0]!.replace(/[._-]+/g, ' ');
      return {
        id: user.id, code: `INV-${user.id.slice(0, 8).toUpperCase()}`, email: user.email, name,
        initials: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 3).toUpperCase(),
        role: user.access_scope === 'ADMIN' ? UserRole.MANAGER : UserRole.CASHIER,
        accessScope: user.access_scope as 'CASHIER' | 'BOTH' | 'ADMIN',
        isSalesman: user.is_salesman,
      };
    }),
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

export async function validateSharedVoucher(context: any) {
  const inventory = getSharedInventoryPool();
  const voucher = (await inventory.query<any>(`
    SELECT vc.*, COALESCE(jsonb_agg(vr) FILTER (WHERE vr.id IS NOT NULL), '[]'::jsonb) AS restrictions
    FROM voucher_codes vc LEFT JOIN voucher_restrictions vr ON vr.sku_id = vc.sku_id
    WHERE vc.code = $1 GROUP BY vc.id
  `, [String(context?.voucherCode ?? '').trim()])).rows[0];
  if (!voucher) return { isValid: false, errors: ['Voucher code not found'] };
  if (String(voucher.status).toLowerCase() !== 'active') return { isValid: false, errors: [`Voucher is ${voucher.status}`] };
  if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) return { isValid: false, errors: ['Voucher has expired'] };
  const errors: string[] = [];
  const restrictions = Array.isArray(voucher.restrictions) ? voucher.restrictions : [];
  if (context?.hasOtherVouchers && restrictions.some((r: any) => r.cannot_combine_with_other_vouchers)) errors.push('This voucher cannot be combined with other vouchers');
  if (context?.hasDiscounts && restrictions.some((r: any) => r.cannot_combine_with_discounts)) errors.push('This voucher cannot be combined with discounts');
  const minimum = Math.max(0, ...restrictions.map((r: any) => Number(r.min_purchase_amount ?? 0)));
  if (Number(context?.totalAmount ?? 0) < minimum) errors.push(`Minimum purchase amount of ${minimum} ${voucher.currency} required`);
  const items = Array.isArray(context?.items) ? context.items : [];
  const eligible = items.filter((item: any) => restrictions.every((r: any) => {
    const categories = Array.isArray(r.target_category_ids) ? r.target_category_ids : [];
    const skus = Array.isArray(r.target_sku_ids) ? r.target_sku_ids : [];
    const variants = Array.isArray(r.target_variant_ids) ? r.target_variant_ids : [];
    if (r.restriction_type === 'category_exclude') return !categories.includes(item.categoryId);
    if (r.restriction_type === 'category_include') return categories.includes(item.categoryId);
    if (r.restriction_type === 'sku_exclude') return !skus.includes(item.skuId);
    if (r.restriction_type === 'sku_include') return skus.includes(item.skuId);
    if (r.restriction_type === 'variant_exclude') return !variants.includes(item.variantId);
    if (r.restriction_type === 'variant_include') return variants.includes(item.variantId);
    return true;
  }));
  if (!eligible.length) errors.push('No items in cart are eligible for this voucher');
  const eligibleTotal = eligible.reduce((sum: number, item: any) => sum + Number(item.price ?? 0) * Number(item.quantity ?? 0), 0);
  const limits = restrictions.map((r: any) => Number(r.max_discount_amount)).filter(Number.isFinite);
  const maxRedeemableAmount = Math.min(Number(voucher.current_balance), eligibleTotal, ...(limits.length ? limits : [Number.POSITIVE_INFINITY]));
  if (Number(voucher.current_balance) <= 0) errors.push('Voucher balance is empty');
  return errors.length ? { isValid: false, errors } : {
    isValid: true,
    voucher: { id: voucher.id, code: voucher.code, currentBalance: Number(voucher.current_balance), currency: voucher.currency, status: voucher.status, expiresAt: voucher.expires_at },
    maxRedeemableAmount,
    applicableItems: eligible.map((item: any) => ({ skuId: item.skuId, variantId: item.variantId, quantity: item.quantity })),
  };
}

async function syncProjection(snapshot: SharedCatalogSnapshot): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const branch of snapshot.branches ?? []) {
      await tx.branch.upsert({ where: { id: branch.id }, create: branch, update: { code: branch.code, name: branch.name } });
    }
    for (const user of snapshot.users ?? []) {
      await tx.pOSUser.upsert({
        where: { id: user.id }, create: user,
        update: { code: user.code, email: user.email, name: user.name, initials: user.initials, role: user.role, accessScope: user.accessScope ?? 'BOTH', isSalesman: user.isSalesman !== false },
      });
    }
    if (snapshot.branches?.length) {
      await tx.terminal.updateMany({
        where: { branchId: { notIn: snapshot.branches.map((branch) => branch.id) } },
        data: { branchId: snapshot.branches[0]!.id },
      });
    }
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
          barcodesJson: JSON.stringify(product.barcodes ?? []),
          name: product.name,
          price: product.priceTiers[0]?.price ?? 0,
          categoryId: product.categoryId,
          subcategory: product.subcategory,
          packSize: Math.max(1, Math.round(product.packSize || 1)),
          unitLabel: product.unitLabel,
          stockOnHand: Math.max(0, Math.round(product.stockOnHand)),
          stockByBranchJson: stringifyJson(product.stockByBranch ?? {}),
          pricingRulesJson: stringifyJson(product.pricingRules ?? []),
          description: product.description ?? null,
          variantsJson: stringifyJson(product.variants ?? []),
        },
        create: {
          id: product.id,
          sku: product.sku,
          barcode: product.barcode ?? null,
          barcodesJson: JSON.stringify(product.barcodes ?? []),
          name: product.name,
          price: product.priceTiers[0]?.price ?? 0,
          categoryId: product.categoryId,
          subcategory: product.subcategory,
          packSize: Math.max(1, Math.round(product.packSize || 1)),
          unitLabel: product.unitLabel,
          stockOnHand: Math.max(0, Math.round(product.stockOnHand)),
          stockByBranchJson: stringifyJson(product.stockByBranch ?? {}),
          pricingRulesJson: stringifyJson(product.pricingRules ?? []),
          description: product.description ?? null,
          variantsJson: stringifyJson(product.variants ?? []),
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
    const offset = index * 5;
    values.push(randomUUID(), seq, change.tableName, change.rowId, change.action);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
  });

  await client.query(
    `
      INSERT INTO sync_server_changes (id, seq, table_name, row_id, action)
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
    branchId?: string | null;
    cashierId?: string | null;
    payments?: Array<{ method: string; amount: number; reference?: string }>;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await withSharedInventoryTransaction(async (client) => {
    const groupedVouchers = new Map<string, number>();
    for (const payment of input.payments ?? []) {
      if (payment.method !== 'GIFT') continue;
      const code = payment.reference?.trim();
      if (!code || payment.amount <= 0) throw new Error('Gift-voucher payments require a code and positive amount');
      groupedVouchers.set(code, (groupedVouchers.get(code) ?? 0) + payment.amount);
    }
    for (const [code, amount] of groupedVouchers) {
      const voucher = (await client.query<any>(`SELECT id, current_balance, status, expires_at FROM voucher_codes WHERE code=$1 FOR UPDATE`, [code])).rows[0];
      if (!voucher || String(voucher.status).toLowerCase() !== 'active') throw new Error(`Voucher ${code} is unavailable`);
      if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) throw new Error(`Voucher ${code} has expired`);
      const before = normalizeNumber(voucher.current_balance);
      if (amount > before) throw new Error(`Voucher ${code} has insufficient balance`);
      const after = Math.round((before - amount) * 100) / 100;
      await client.query(`UPDATE voucher_codes SET current_balance=$1,status=$2,activated_at=COALESCE(activated_at,NOW()),fully_redeemed_at=CASE WHEN $1<=0 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$3`, [after, after <= 0 ? 'redeemed' : 'active', voucher.id]);
      await client.query(`INSERT INTO voucher_redemptions (id,voucher_code_id,code,redeemed_amount,balance_before,balance_after,order_id,invoice_number,branch_id,applied_to_items,redeemed_by,redeemed_at,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)`,
        [randomUUID(), voucher.id, code, amount, before, after, input.aggregateId, input.receiptNumber, input.branchId ?? null, JSON.stringify(input.lines), input.cashierId ?? null, `POS ${input.terminalId ?? ''}`]);
    }
    for (const line of input.lines) {
      const requestedQuantity = normalizeNumber(line.quantity);
      if (requestedQuantity <= 0) {
        continue;
      }

      const recordResult = await client.query<{ id: string; quantity: number | string }>(
        `
          SELECT ir.id, ir.quantity
          FROM inventory_records ir LEFT JOIN floors f ON f.id = ir.floor_id
          WHERE ir.sku_id = $1
            AND ir.state = $2
            AND (
              ($3::text IS NULL AND ir.variant_id IS NULL)
              OR ir.variant_id = $3
            )
            AND ($4::text IS NULL OR f.branch_id = $4)
            AND ir.quantity > 0
          ORDER BY ir.updated_at ASC, ir.created_at ASC
          FOR UPDATE OF ir
        `,
        [line.productId, SHELF_READY_STATE, line.variantId ?? null, input.branchId ?? null],
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
            variantId: line.variantId ?? null,
            variantCode: line.variantCode ?? null,
            variantName: line.variantName ?? null,
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
    branchId?: string | null;
    eventType: 'RETURN_RECEIVED' | 'MANUAL_ADJUSTMENT';
    reasonCode?: string | null;
    metadata: Record<string, unknown>;
    lines: SharedSaleLine[];
    voucherRefund?: { saleId: string; refundId: string; amount?: number };
  },
): Promise<void> {
  await withSharedInventoryTransaction(async (client) => {
    if (input.voucherRefund) {
      const rows = await client.query<any>(`SELECT voucher_code_id,code,SUM(redeemed_amount) AS net FROM voucher_redemptions WHERE order_id=$1 GROUP BY voucher_code_id,code HAVING SUM(redeemed_amount)>0 ORDER BY code`, [input.voucherRefund.saleId]);
      let remaining = input.voucherRefund.amount == null ? Number.POSITIVE_INFINITY : input.voucherRefund.amount;
      for (const row of rows.rows) {
        if (remaining <= 0) break;
        const voucher = (await client.query<any>(`SELECT id,current_balance,initial_value FROM voucher_codes WHERE id=$1 FOR UPDATE`, [row.voucher_code_id])).rows[0];
        if (!voucher) continue;
        const amount = Math.min(normalizeNumber(row.net), remaining);
        const before = normalizeNumber(voucher.current_balance);
        const after = Math.min(normalizeNumber(voucher.initial_value), Math.round((before + amount) * 100) / 100);
        const restored = after - before;
        if (restored <= 0) continue;
        await client.query(`UPDATE voucher_codes SET current_balance=$1,status='active',fully_redeemed_at=NULL,updated_at=NOW() WHERE id=$2`, [after, voucher.id]);
        await client.query(`INSERT INTO voucher_redemptions (id,voucher_code_id,code,redeemed_amount,balance_before,balance_after,order_id,applied_to_items,redeemed_at,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)`, [randomUUID(), voucher.id, row.code, -restored, before, after, input.voucherRefund.saleId, JSON.stringify([]), `Voucher refund ${input.voucherRefund.refundId}`]);
        remaining -= restored;
      }
    }
    for (const line of input.lines) {
      const quantity = normalizeNumber(line.quantity);
      if (quantity <= 0) {
        continue;
      }

      const recordId = randomUUID();
      const floor = input.branchId ? (await client.query<{ id: string }>(`SELECT id FROM floors WHERE branch_id = $1 AND is_active = TRUE ORDER BY sort_order, created_at LIMIT 1`, [input.branchId])).rows[0] : undefined;
      await client.query(
        `
          INSERT INTO inventory_records (
            id,
            sku_id,
            variant_id,
            floor_id,
            quantity,
            state,
            source_event_id,
            terminal_id,
            version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
        `,
        [
          recordId,
          line.productId,
          line.variantId ?? null,
          floor?.id ?? null,
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
            variantId: line.variantId ?? null,
            variantCode: line.variantCode ?? null,
            variantName: line.variantName ?? null,
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
    branchId?: string | null;
    reason?: string | null;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await applySharedInventoryIncrease({
    aggregateId: input.aggregateId,
    terminalId: input.terminalId,
    branchId: input.branchId,
    eventType: 'MANUAL_ADJUSTMENT',
    reasonCode: 'POS_SALE_VOID',
    metadata: {
      receiptNumber: input.receiptNumber,
      reason: input.reason ?? null,
      source: 'pos-sale-void',
    },
    lines: input.lines,
    voucherRefund: { saleId: input.aggregateId, refundId: input.aggregateId },
  });
}

export async function applySharedInventoryReturn(
  input: {
    aggregateId: string;
    saleId: string;
    terminalId?: string | null;
    branchId?: string | null;
    reason?: string | null;
    refundAmount?: number;
    lines: SharedSaleLine[];
  },
): Promise<void> {
  await applySharedInventoryIncrease({
    aggregateId: input.aggregateId,
    terminalId: input.terminalId,
    branchId: input.branchId,
    eventType: 'RETURN_RECEIVED',
    reasonCode: input.reason ?? null,
    metadata: {
      saleId: input.saleId,
      reason: input.reason ?? null,
      source: 'pos-return',
    },
    lines: input.lines,
    voucherRefund: { saleId: input.saleId, refundId: input.aggregateId, amount: input.refundAmount },
  });
}
