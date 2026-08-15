import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  CashCountMode,
  DEFAULT_DEVICE_ID,
  DEFAULT_TERMINAL_ID,
  CompleteSaleInput,
  Customer,
  HeldSaleSummary,
  POSBootstrap,
  POSUser,
  SaleStatus,
  SharedCatalogSnapshot,
  ShiftStatus,
  SyncConflictStatus,
  SyncEventType,
  UserRole,
} from '@jingles/shared';
import prisma from '../prisma';
import {
  getLocalPosDeviceId,
  getLocalPosTerminalId,
  isLocalPosBackendMode,
} from '../localMode';
import { ensureSeedData } from '../seed';
import {
  applyLocalEvent,
  applyServerEvent,
  getLocalSyncDashboard,
  getLocalSyncStatus,
  buildDrawerContents,
  buildZReport,
  buildZReports,
  confirmPlayback,
  getServerVectorClock,
  playbackEvents,
  submitPriceOverride,
  syncWithUpstream,
  validateUpstreamVoucher,
} from '../services/posSync';
import { recordSharedPriceOverride, syncSharedCatalogProjection, validateSharedVoucher } from '../sharedInventory';
import {
  getLocalCatalogSnapshot,
  searchLocalCatalog,
} from '../services/localCatalog';
import { authenticate } from './auth';
import { reportBackgroundServerError, respondWithServerError } from '../services/serverErrorLog';

const router = Router();

function logPosRouteError(
  operation: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  const errorRecord = error && typeof error === 'object'
    ? error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; meta?: unknown }
    : {};
  console.error(`[POS API] ${operation} failed`, {
    occurredAt: new Date().toISOString(),
    errorName: errorRecord.name ?? typeof error,
    message: errorRecord.message ?? String(error),
    code: errorRecord.code,
    stack: errorRecord.stack,
    meta: errorRecord.meta,
    context,
  });
}

// Login is only useful if the business endpoints enforce the resulting session.
// Keep this ahead of catalog preparation so unauthenticated requests cannot trigger
// database work or mutate workstation state.
router.use((req: Request, res: Response, next: NextFunction) => {
  const isMachineSyncEndpoint = ['/sync/handshake', '/sync/playback', '/sync/confirm'].includes(req.path);
  const configuredAppToken = (
    process.env.JINGLES_POS_SYNC_APP_TOKEN?.trim()
    || process.env.POS_SYNC_APP_TOKEN?.trim()
  );
  const requestAppToken = req.header('x-jingles-pos-app-token')?.trim();
  if (isMachineSyncEndpoint && configuredAppToken && requestAppToken) {
    const configured = Buffer.from(configuredAppToken);
    const supplied = Buffer.from(requestAppToken);
    if (configured.length === supplied.length && timingSafeEqual(configured, supplied)) {
      next();
      return;
    }
  }
  void authenticate(req, res, next);
});

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureSeedData();
    if (!isLocalPosBackendMode()) {
      res.locals.sharedCatalog = await syncSharedCatalogProjection();
    }
    next();
  } catch (error) {
    return respondWithServerError(
      req,
      res,
      error,
      isLocalPosBackendMode()
        ? 'The local POS backend could not prepare its catalog cache.'
        : 'Shared inventory catalog is unavailable',
    );
  }
});

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
}

function sortTiers<T extends { priority: number; minQty: number }>(tiers: T[]): T[] {
  return [...tiers].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.minQty - right.minQty;
  });
}

function mapProduct(product: any) {
  return {
    id: product.id,
    sku: product.sku,
    barcode: product.barcode ?? undefined,
    barcodes: parseJson(product.barcodesJson, []),
    name: product.name,
    categoryId: product.categoryId ?? 'uncategorized',
    subcategory: product.subcategory || '',
    packSize: product.packSize ?? 1,
    unitLabel: product.unitLabel ?? 'pcs',
    stockOnHand: product.stockOnHand ?? 0,
    stockByBranch: parseJson(product.stockByBranchJson, {}),
    description: product.description ?? undefined,
    variants: parseJson(product.variantsJson, []),
    pricingRules: parseJson(product.pricingRulesJson, []),
    priceTiers: sortTiers(product.batchPrices ?? []).map((tier: any) => ({
      id: tier.id,
      label: tier.label ?? (tier.minQty > 0 ? `Bulk ${tier.minQty}+` : 'Retail'),
      price: tier.price,
      priority: tier.priority ?? 0,
      minQty: tier.minQty ?? 0,
      isDefault: tier.isDefault ?? false,
    })),
  };
}

function applyRule(price: number, rule: any) {
  if (rule.type === 'percentage_discount') return Math.max(0, price * (1 - rule.value / 100));
  if (rule.type === 'fixed_discount') return Math.max(0, price - rule.value);
  if (rule.type === 'percentage_markup') return price * (1 + rule.value / 100);
  if (rule.type === 'fixed_markup') return price + rule.value;
  return price;
}

function scopeProductForBranch(product: any, branchId?: string) {
  const branchRules = (product.pricingRules ?? []).filter((rule: any) => !rule.branchIds?.length || (branchId && rule.branchIds.includes(branchId)));
  const resolvePriceTiers = (tiers: any[], variantId?: string) => {
    const rules = branchRules.filter((rule: any) => (
      variantId ? (!rule.variantIds?.length || rule.variantIds.includes(variantId)) : !rule.variantIds?.length
    ));
    return tiers.flatMap((base: any) => {
    const breakpoints = new Set<number>([base.minQty ?? 0, ...rules.map((rule: any) => Number(rule.minQty ?? 0))]);
    return Array.from(breakpoints).sort((a, b) => a - b).map((minQty) => {
      let price = base.price;
      const applied: string[] = [];
      for (const rule of rules) {
        if (minQty < Number(rule.minQty ?? 0) || (rule.maxQty != null && minQty > Number(rule.maxQty))) continue;
        price = applyRule(price, rule);
        applied.push(rule.name);
        if (!rule.stackable) break;
      }
      return { ...base, id: `${base.id}-${minQty}-${applied.join('-')}`, minQty, price: Math.round(price * 100) / 100 };
    });
  });
  };
  const priceTiers = resolvePriceTiers(product.priceTiers);
  return {
    ...product,
    stockOnHand: branchId ? Number(product.stockByBranch?.[branchId] ?? 0) : product.stockOnHand,
    variants: (product.variants ?? []).map((variant: any) => ({
      ...variant,
      stockOnHand: branchId ? Number(variant.stockByBranch?.[branchId] ?? 0) : variant.stockOnHand,
      priceTiers: resolvePriceTiers(variant.priceTiers?.length ? variant.priceTiers : product.priceTiers, variant.id),
    })),
    priceTiers,
  };
}

async function getProjectedProducts(catalog: SharedCatalogSnapshot, branchId?: string) {
  const rows = await prisma.product.findMany({
    include: { batchPrices: true },
    orderBy: { sku: 'asc' },
  });

  const projectedById = new Map(rows.map((row) => [row.id, mapProduct(row)]));
  return catalog.products.map((product) => {
    const projected = projectedById.get(product.id);
    if (!projected) {
      return scopeProductForBranch(product, branchId);
    }

    return scopeProductForBranch({
      ...product,
      ...projected,
      variants: projected.variants ?? product.variants ?? [],
    }, branchId);
  });
}

async function getCatalogSnapshot(res: Response) {
  if (isLocalPosBackendMode()) {
    return getLocalCatalogSnapshot();
  }

  const sharedCatalog = res.locals.sharedCatalog as SharedCatalogSnapshot;
  const [users, customers] = await Promise.all([
    prisma.pOSUser.findMany({ orderBy: { code: 'asc' } }),
    prisma.customer.findMany({ orderBy: { name: 'asc' } }),
  ]);
  return {
    ...sharedCatalog,
    users: users.map(mapUser),
    customers: customers.map(mapCustomer),
  };
}

export async function mergeHandshakeReferenceData(users: POSUser[], customers: Customer[]) {
  await prisma.$transaction(async (tx) => {
    for (const user of users) {
      const existing = await tx.pOSUser.findFirst({
        where: {
          OR: [
            { id: user.id },
            { code: user.code },
            ...(user.email ? [{ email: user.email }] : []),
          ],
        },
      });
      const data = {
        code: user.code,
        email: user.email ?? null,
        name: user.name,
        initials: user.initials,
        role: user.role,
      };
      if (existing) await tx.pOSUser.update({ where: { id: existing.id }, data });
      else await tx.pOSUser.create({ data: { id: user.id, ...data } });
    }

    for (const customer of customers) {
      const existing = await tx.customer.findFirst({
        where: {
          OR: [
            { id: customer.id },
            ...(customer.code ? [{ code: customer.code }] : []),
            ...(customer.email ? [{ email: customer.email }] : []),
          ],
        },
      });
      const data = {
        code: customer.code || null,
        name: customer.name,
        tier: customer.tier,
        phone: customer.phone ?? null,
        email: customer.email ?? null,
        notes: customer.notes ?? null,
        creditLimit: customer.creditLimit ?? 0,
      };
      if (existing) await tx.customer.update({ where: { id: existing.id }, data });
      else await tx.customer.create({ data: { id: customer.id, ...data } });
    }
  });
}

async function getWorkstationProducts(
  res: Response,
  terminalId?: string,
  catalogSnapshot?: SharedCatalogSnapshot,
) {
  const catalog = catalogSnapshot ?? await getCatalogSnapshot(res);
  const terminal = terminalId ? await prisma.terminal.findUnique({ where: { id: terminalId } }) : null;
  const branchId = terminal?.branchId;
  if (isLocalPosBackendMode()) return catalog.products.map((product) => scopeProductForBranch(product, branchId));
  return getProjectedProducts(catalog, branchId);
}

function resolveDeviceId(req: Request) {
  if (typeof req.body?.deviceId === 'string' && req.body.deviceId.trim()) {
    return req.body.deviceId.trim();
  }

  if (typeof req.query?.deviceId === 'string' && req.query.deviceId.trim()) {
    return req.query.deviceId.trim();
  }

  return getLocalPosDeviceId();
}

function resolveTerminalId(req: Request) {
  if (typeof req.body?.terminalId === 'string' && req.body.terminalId.trim()) {
    return req.body.terminalId.trim();
  }

  if (typeof req.query?.terminalId === 'string' && req.query.terminalId.trim()) {
    return req.query.terminalId.trim();
  }

  return getLocalPosTerminalId();
}

async function applyWorkstationEvent(req: Request, input: {
  aggregateType: string;
  aggregateId: string;
  eventType: SyncEventType;
  payload: unknown;
  terminalId?: string | null;
}) {
  if (isLocalPosBackendMode()) {
    return applyLocalEvent({
      ...input,
      terminalId: input.terminalId ?? resolveTerminalId(req),
      deviceId: resolveDeviceId(req),
    });
  }

  return applyServerEvent(input);
}

function mapTerminal(terminal: any, branchMap: Map<string, any>) {
  return {
    id: terminal.id,
    code: terminal.code,
    name: terminal.name,
    branchId: terminal.branchId,
    branchCode: branchMap.get(terminal.branchId)?.code ?? '',
  };
}

function mapUser(user: any) {
  return {
    id: user.id,
    code: user.code,
    email: user.email ?? undefined,
    name: user.name,
    initials: user.initials,
    role: user.role as UserRole,
  };
}

function mapCustomer(customer: any) {
  return {
    id: customer.id,
    code: customer.code ?? customer.id,
    name: customer.name,
    tier: customer.tier,
    phone: customer.phone ?? undefined,
    email: customer.email ?? undefined,
    notes: customer.notes ?? undefined,
    creditLimit: customer.creditLimit ?? 0,
  };
}

function mapCreditPayment(payment: any, userMap: Map<string, { name: string }>) {
  return {
    id: payment.id,
    customerId: payment.customerId,
    amount: payment.amount,
    method: payment.method,
    note: payment.note ?? undefined,
    terminalId: payment.terminalId ?? undefined,
    userId: payment.userId ?? undefined,
    userName: payment.userId ? userMap.get(payment.userId)?.name : undefined,
    shiftId: payment.shiftId ?? undefined,
    createdAt: payment.createdAt.toISOString(),
  };
}

function mapCategory(category: any) {
  return {
    id: category.id,
    name: category.name,
    icon: category.icon ?? category.name.slice(0, 2).toUpperCase(),
    sortOrder: category.sortOrder ?? 0,
  };
}

function mapShift(shift: any, userMap: Map<string, any>) {
  return {
    id: shift.id,
    terminalId: shift.terminalId,
    branchId: shift.branchId ?? 'branch-jingles-01',
    cashierId: shift.userId,
    cashierName: userMap.get(shift.userId)?.name ?? shift.userId,
    status: shift.status,
    openingFloat: shift.openingFloat,
    closingFloat: shift.closingFloat ?? undefined,
    openedAt: shift.openedAt.toISOString(),
    closedAt: shift.closedAt?.toISOString(),
    notes: shift.notes ?? undefined,
  };
}

function mapSale(sale: any, userMap: Map<string, any>) {
  return {
    id: sale.id,
    receiptNumber: sale.receiptNumber,
    terminalId: sale.terminalId,
    branchId: sale.branchId ?? 'branch-jingles-01',
    cashierId: sale.userId,
    cashierName: userMap.get(sale.userId)?.name ?? sale.userId,
    customerId: sale.customerId ?? undefined,
    customerName: sale.customer?.name ?? undefined,
    shiftId: sale.shiftId ?? undefined,
    status: sale.status,
    subtotal: sale.subtotal,
    discountTotal: sale.discountTotal,
    taxTotal: sale.taxTotal,
    total: sale.total,
    marginTotal: sale.marginTotal ?? 0,
    createdAt: sale.createdAt.toISOString(),
    updatedAt: sale.updatedAt.toISOString(),
    lines: (sale.lines ?? []).map((line: any) => ({
      id: line.id,
      saleId: line.saleId,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      variantId: line.variantId ?? undefined,
      variantCode: line.variantCode ?? undefined,
      variantName: line.variantName ?? undefined,
      variantAttributes: parseJson(line.variantAttributesJson, undefined),
      subcategory: line.subcategory ?? '',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      tierLabel: line.tierLabel ?? 'Retail',
      discountPercent: line.discountPercent ?? 0,
      discountAmount: line.discountAmount ?? 0,
      salespersonId: line.salespersonId ?? '',
      salespersonName: userMap.get(line.salespersonId)?.name ?? 'Unassigned',
      salespersonInitials: userMap.get(line.salespersonId)?.initials ?? '--',
      costBasis: line.costBasis ?? 0,
      marginAmount: line.marginAmount ?? 0,
      lineTotal: line.lineTotal,
      returnedQuantity: (line.returnLines ?? []).reduce((sum: number, returnLine: any) => sum + returnLine.quantity, 0),
    })),
    payments: (sale.payments ?? []).map((payment: any) => ({
      method: payment.method,
      amount: payment.amount,
      tenderedAmount: payment.tenderedAmount ?? undefined,
      changeDue: payment.changeDue ?? undefined,
      reference: payment.reference ?? undefined,
      metadata: parseJson<Record<string, unknown> | undefined>(payment.metadata, undefined),
    })),
  };
}

function mapHeldSale(heldSale: any, userMap: Map<string, any>): HeldSaleSummary {
  return {
    id: heldSale.id,
    holdNumber: heldSale.holdNumber,
    terminalId: heldSale.terminalId,
    branchId: heldSale.branchId,
    cashierId: heldSale.userId,
    cashierName: userMap.get(heldSale.userId)?.name ?? heldSale.userId,
    customerId: heldSale.customerId ?? undefined,
    customerName: heldSale.customerName ?? undefined,
    status: heldSale.status,
    subtotal: heldSale.subtotal,
    discountTotal: heldSale.discountTotal,
    total: heldSale.total,
    itemCount: (heldSale.lines ?? []).reduce((sum: number, line: any) => sum + line.quantity, 0),
    createdAt: heldSale.createdAt.toISOString(),
    updatedAt: heldSale.updatedAt.toISOString(),
    lines: (heldSale.lines ?? []).map((line: any) => ({
      id: line.id,
      heldSaleId: line.heldSaleId,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      variantId: line.variantId ?? undefined,
      variantCode: line.variantCode ?? undefined,
      variantName: line.variantName ?? undefined,
      variantAttributes: parseJson(line.variantAttributesJson, undefined),
      subcategory: line.subcategory ?? '',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      tierLabel: line.tierLabel ?? 'Retail',
      discountPercent: line.discountPercent ?? 0,
      discountAmount: line.discountAmount ?? 0,
      salespersonId: line.salespersonId ?? '',
      salespersonName: userMap.get(line.salespersonId)?.name ?? 'Unassigned',
      salespersonInitials: userMap.get(line.salespersonId)?.initials ?? '--',
      costBasis: line.costBasis ?? 0,
      lineTotal: line.lineTotal,
    })),
  };
}

async function getUserMap(): Promise<Map<string, any>> {
  const users = await prisma.pOSUser.findMany();
  return new Map(users.map((user) => [user.id, user]));
}

export async function respondWithExistingOpenShift(
  res: Response,
  terminalId: unknown,
  cashierId: unknown,
) {
  if (typeof terminalId !== 'string' || !terminalId.trim()) {
    return null;
  }

  const existingShift = await prisma.pOSShift.findFirst({
    where: { terminalId, status: ShiftStatus.OPEN },
    orderBy: { openedAt: 'desc' },
  });
  if (!existingShift) {
    return null;
  }

  if (existingShift.userId !== cashierId) {
    return res.status(409).json({
      error: `Terminal ${terminalId} already has an open shift`,
    });
  }

  const userMap = await getUserMap();
  return res.status(200).json(mapShift(existingShift, userMap));
}

router.get('/bootstrap', async (req: Request, res: Response) => {
  try {
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const catalog = await getCatalogSnapshot(res);
    const [branches, terminals, users, customers, activeShift, heldSales, syncStatus, products] = await Promise.all([
      prisma.branch.findMany({ orderBy: { code: 'asc' } }),
      prisma.terminal.findMany({ orderBy: { code: 'asc' } }),
      prisma.pOSUser.findMany({ orderBy: { code: 'asc' } }),
      prisma.customer.findMany({ orderBy: { name: 'asc' } }),
      prisma.pOSShift.findFirst({
        where: {
          terminalId: terminalId ?? undefined,
          status: ShiftStatus.OPEN,
        },
        orderBy: { openedAt: 'desc' },
      }),
      prisma.heldSale.findMany({
        where: { status: SaleStatus.HELD },
        include: { lines: true },
        orderBy: { createdAt: 'desc' },
      }),
      isLocalPosBackendMode()
        ? getLocalSyncStatus(deviceId ?? getLocalPosDeviceId(), terminalId ?? getLocalPosTerminalId())
        : (async () => {
            const serverClock = await getServerVectorClock();
            const conflictCount = await prisma.syncConflict.count({ where: { status: SyncConflictStatus.OPEN } });
            return {
              online: true,
              pendingEvents: 0,
              conflictCount,
              deviceId: deviceId ?? DEFAULT_DEVICE_ID,
              localVectorClock: {},
              remoteVectorClock: serverClock,
              lastSyncAt: new Date().toISOString(),
            };
          })(),
      getWorkstationProducts(res, terminalId, catalog),
    ]);

    const userMap = new Map(users.map((user) => [user.id, user]));
    const branchMap = new Map(branches.map((branch) => [branch.id, branch]));
    const payload: POSBootstrap = {
      branches,
      terminals: terminals.map((terminal) => mapTerminal(terminal, branchMap)),
      users: users.map(mapUser),
      customers: customers.map(mapCustomer),
      categories: catalog.categories,
      products,
      activeShift: activeShift ? mapShift(activeShift, userMap) : null,
      heldSales: heldSales.map((heldSale) => mapHeldSale(heldSale, userMap)),
      syncStatus,
    };

    return res.json(payload);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to bootstrap POS workstation');
  }
});

router.get('/catalog/snapshot', async (_req: Request, res: Response) => {
  const catalog = await getCatalogSnapshot(res);
  return res.json(catalog);
});

router.post('/vouchers/validate', async (req: Request, res: Response) => {
  try {
    const result = isLocalPosBackendMode()
      ? await validateUpstreamVoucher(req.body)
      : await validateSharedVoucher(req.body);
    return res.status(result.isValid ? 200 : 422).json(result);
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Voucher validation unavailable' });
  }
});

/**
 * Makes the "<price>-<code>" checkout shorthand permanent: records it as a
 * new batch-pricing entry on the inventory side instead of writing to this
 * terminal's own local SQLite, because every local `BatchPrice` row is
 * wholesale-replaced from the cloud catalog snapshot on every sync cycle - a
 * local-only write would silently revert within ~20 seconds. Fire-and-forget
 * from the cashier's point of view: this never touches the sale itself, so a
 * slow or failed request here can't hold up the receipt.
 */
router.post('/pricing/override', async (req: Request, res: Response) => {
  try {
    const result = isLocalPosBackendMode()
      ? await submitPriceOverride(req.body)
      : await recordSharedPriceOverride(req.body);
    return res.status(201).json(result);
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Price override was not saved' });
  }
});

router.get('/products/search', async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }

    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    const terminal = terminalId ? await prisma.terminal.findUnique({ where: { id: terminalId } }) : null;

    if (isLocalPosBackendMode()) {
      return res.json((await searchLocalCatalog(q)).map((product) => scopeProductForBranch(product, terminal?.branchId)));
    }

    const catalog = await getCatalogSnapshot(res);
    const term = q.toLowerCase();
    const rows = (await getProjectedProducts(catalog, terminal?.branchId))
      .filter((product) => (
        product.sku.toLowerCase().includes(term) ||
        product.name.toLowerCase().includes(term) ||
        (product.barcode?.toLowerCase() ?? '') === term ||
        product.barcodes?.some((barcode: string) => barcode.toLowerCase().includes(term)) ||
        product.subcategory.toLowerCase().includes(term)
      ))
      .slice(0, 30);

    return res.json(rows);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Product search failed');
  }
});

router.get('/products/barcode/:barcode', async (req: Request, res: Response) => {
  try {
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    const row = (await getWorkstationProducts(res, terminalId))
      .find((product) => product.barcode === req.params.barcode);

    if (!row) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json(row);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Barcode lookup failed');
  }
});

router.post('/shifts/open', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const existingShiftResponse = await respondWithExistingOpenShift(
      res,
      req.body.terminalId,
      req.body.cashierId,
    );
    if (existingShiftResponse) {
      return existingShiftResponse;
    }

    const shiftId = req.body.shiftId ?? uuidv4();
    await applyWorkstationEvent(req, {
      aggregateType: 'shift',
      aggregateId: shiftId,
      eventType: SyncEventType.SHIFT_OPENED,
      terminalId: req.body.terminalId,
      payload: {
        shiftId,
        terminalId: req.body.terminalId,
        branchId: req.body.branchId,
        cashierId: req.body.cashierId,
        openingFloat: req.body.openingFloat ?? 0,
        notes: req.body.notes,
        declaration: req.body.declaration,
      },
    });

    const userMap = await getUserMap();
    const shift = await prisma.pOSShift.findUnique({ where: { id: shiftId } });
    return res.status(201).json(shift ? mapShift(shift, userMap) : null);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already has an open shift')) {
      try {
        const existingShiftResponse = await respondWithExistingOpenShift(
          res,
          req.body.terminalId,
          req.body.cashierId,
        );
        if (existingShiftResponse) {
          return existingShiftResponse;
        }
      } catch (recoveryError) {
        logPosRouteError('Recover existing open shift', recoveryError, {
          terminalId: req.body.terminalId,
          cashierId: req.body.cashierId,
        });
      }
    }

    return respondWithServerError(req, res, error, 'Failed to open shift');
  }
});

router.post('/shifts/:id/close', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    await applyWorkstationEvent(req, {
      aggregateType: 'shift',
      aggregateId: req.params.id,
      eventType: SyncEventType.SHIFT_CLOSED,
      terminalId: req.body.terminalId,
      payload: {
        shiftId: req.params.id,
        closingFloat: req.body.closingFloat ?? 0,
        notes: req.body.notes,
        declaration: req.body.declaration,
        // Carried through as-is so the inventory system can queue a review
        // without the workstation having to show anything to the cashier.
        flagged: req.body.flagged === true,
      },
    });

    const userMap = await getUserMap();
    const shift = await prisma.pOSShift.findUnique({ where: { id: req.params.id } });
    return res.json(shift ? mapShift(shift, userMap) : null);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to close shift');
  }
});

/**
 * Records cash moving in or out of the drawer part-way through a shift.
 *
 * This rides the existing CASH_DECLARED event with a PAID_IN / PAID_OUT count
 * mode rather than introducing a new event type, so the movement lands in the
 * same append-only cash-count history the opening and closing declarations use
 * and replays identically upstream.
 */
router.post('/shifts/:id/cash-movement', async (req: Request, res: Response) => {
  try {
    const direction = req.body.direction === 'out' ? 'out' : 'in';
    const declaration = req.body.declaration;

    if (!declaration || typeof declaration.total !== 'number' || !Number.isFinite(declaration.total)) {
      return res.status(400).json({ error: 'A counted cash declaration is required' });
    }
    if (declaration.total <= 0) {
      return res.status(400).json({ error: 'A cash movement must be for more than zero' });
    }

    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (reason === '') {
      return res.status(400).json({ error: 'A reason is required for a cash movement' });
    }
    let reasonSuffix = '';

    const shift = await prisma.pOSShift.findUnique({ where: { id: req.params.id } });
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    if (shift.status !== ShiftStatus.OPEN) {
      return res.status(409).json({ error: 'Cash can only be moved while the shift is open' });
    }
    if (req.body.terminalId && req.body.terminalId !== shift.terminalId) {
      return res.status(409).json({ error: 'The active shift belongs to a different terminal' });
    }

    // Money cannot leave a drawer that does not hold it. Enforced here rather
    // than only in the UI, because a movement that overdraws the till is either
    // a miscount or a loss, and recording it silently destroys the evidence.
    const allowOverdraw = req.body.allowOverdraw === true;
    if (direction === 'out') {
      const drawer = await buildDrawerContents(shift.id);
      const shortfalls: string[] = [];

      if (declaration.total > drawer.total) {
        shortfalls.push(
          `total ${declaration.total.toFixed(2)} exceeds the ${drawer.total.toFixed(2)} in the drawer`,
        );
      }

      for (const [value, raw] of Object.entries(declaration.denominations ?? {})) {
        const wanted = Number(raw);
        if (!Number.isFinite(wanted) || wanted <= 0) continue;
        const held = drawer.counts[value] ?? 0;
        if (wanted > held) {
          shortfalls.push(`${wanted}x${value} requested but only ${held} in the drawer`);
        }
      }

      if (shortfalls.length > 0 && !allowOverdraw) {
        return res.status(409).json({
          error: `The drawer does not hold this: ${shortfalls.join('; ')}.`,
          drawer,
        });
      }

      if (shortfalls.length > 0) {
        // Permitted by configuration, but never silently: the override is part
        // of the audit trail for the shift.
        reasonSuffix = ` [overdraw permitted: ${shortfalls.join('; ')}]`;
      }
    }

    const mode = direction === 'in' ? CashCountMode.PAID_IN : CashCountMode.PAID_OUT;
    const movementId = req.body.movementId ?? uuidv4();

    await applyWorkstationEvent(req, {
      aggregateType: 'shift',
      aggregateId: shift.id,
      eventType: SyncEventType.CASH_DECLARED,
      terminalId: shift.terminalId,
      payload: {
        shiftId: shift.id,
        movementId,
        direction,
        reason: `${reason}${reasonSuffix}`,
        declaration: {
          ...declaration,
          mode,
          // Signed so a reader that only looks at the total still gets the
          // direction right without having to interpret the mode.
          variance: direction === 'in' ? declaration.total : -declaration.total,
        },
      },
    });

    const report = await buildZReport(shift.id);
    return res.status(201).json(report);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to record the cash movement');
  }
});

/** What the drawer is believed to hold right now, used to suggest change. */
router.get('/shifts/:id/drawer', async (req: Request, res: Response) => {
  try {
    return res.json(await buildDrawerContents(req.params.id));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to read the drawer contents');
  }
});

router.post('/shifts/:id/end-session', async (req: Request, res: Response) => {
  try {
    const actor = (req as Request & { user?: { id: string; email?: string; code?: string; role: string } }).user;
    if (actor?.role !== UserRole.MANAGER) {
      return res.status(403).json({ error: 'Only a manager can end another user’s active session' });
    }

    const shift = await prisma.pOSShift.findUnique({ where: { id: req.params.id } });
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    if (shift.status !== ShiftStatus.OPEN) {
      const userMap = await getUserMap();
      return res.json(mapShift(shift, userMap));
    }
    if (req.body.terminalId && req.body.terminalId !== shift.terminalId) {
      return res.status(409).json({ error: 'The active shift belongs to a different terminal' });
    }

    const auditNote = `Session ended by manager ${actor.email ?? actor.code ?? actor.id}`;
    await applyWorkstationEvent(req, {
      aggregateType: 'shift',
      aggregateId: shift.id,
      eventType: SyncEventType.SHIFT_CLOSED,
      terminalId: shift.terminalId,
      payload: {
        shiftId: shift.id,
        closingFloat: shift.closingFloat ?? shift.openingFloat,
        notes: [shift.notes, auditNote].filter(Boolean).join('\n'),
      },
    });

    const userMap = await getUserMap();
    const closedShift = await prisma.pOSShift.findUnique({ where: { id: shift.id } });
    return res.json(closedShift ? mapShift(closedShift, userMap) : null);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to end the active session');
  }
});

router.get('/shifts/active', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    const shift = await prisma.pOSShift.findFirst({
      where: {
        terminalId: terminalId ?? undefined,
        status: ShiftStatus.OPEN,
      },
      orderBy: { openedAt: 'desc' },
    });

    if (!shift) {
      return res.json(null);
    }

    const userMap = await getUserMap();
    return res.json(mapShift(shift, userMap));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load active shift');
  }
});

router.get('/shifts/:id/z-report', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const report = await buildZReport(req.params.id);
    return res.json(report);
  } catch (error: any) {
    if (error.message === 'Shift not found') {
      return res.status(404).json({ error: error.message });
    }
    return respondWithServerError(req, res, error, 'Failed to build Z-report');
  }
});

router.get('/z-reports', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const fromDate = typeof req.query.fromDate === 'string' ? new Date(req.query.fromDate) : undefined;
    const toDate = typeof req.query.toDate === 'string' ? new Date(req.query.toDate) : undefined;
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'A report start and end date are required' });
    }
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
      return res.status(400).json({ error: 'Invalid report date range' });
    }

    const shifts = await prisma.pOSShift.findMany({
      where: {
        terminalId,
        OR: [
          {
            closedAt: {
              gte: fromDate,
              lte: toDate,
            },
          },
          {
            status: ShiftStatus.OPEN,
            openedAt: { gte: fromDate, lte: toDate },
          },
        ],
      },
      orderBy: [{ closedAt: 'desc' }, { openedAt: 'desc' }],
      take: 500,
    });
    const userMap = await getUserMap();
    const reports = await buildZReports(shifts.map((shift) => shift.id));
    const reportMap = new Map(reports.map((report) => [report.shiftId, report]));
    const slots = shifts.map((shift) => ({
      shift: mapShift(shift, userMap),
      report: reportMap.get(shift.id),
    })).filter((slot) => slot.report != null);
    return res.json(slots);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load Z-report slots');
  }
});

router.get('/legacy-records', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
    const sourceTable = typeof req.query.sourceTable === 'string' ? req.query.sourceTable.toLowerCase() : undefined;
    const where = sourceTable ? { sourceTable } : {};
    const [total, items] = await Promise.all([
      prisma.legacyPOSRecord.count({ where }),
      prisma.legacyPOSRecord.findMany({
        where,
        orderBy: [{ sourceTable: 'asc' }, { sourceId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return res.json({
      page,
      pageSize,
      total,
      items: items.map((item) => ({ ...item, payload: JSON.parse(item.payload) })),
    });
  } catch (error: any) {
    return respondWithServerError(req, res, error, 'Failed to load legacy POS records');
  }
});

router.post('/held-sales', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const heldSaleId = req.body.heldSaleId ?? uuidv4();
    await applyWorkstationEvent(req, {
      aggregateType: 'held-sale',
      aggregateId: heldSaleId,
      eventType: SyncEventType.HELD_SALE_SAVED,
      terminalId: req.body.terminalId,
      payload: {
        holdNumber: req.body.holdNumber ?? `H-${new Date().getTime()}`,
        terminalId: req.body.terminalId,
        branchId: req.body.branchId,
        cashierId: req.body.cashierId,
        customerId: req.body.customerId,
        lines: req.body.lines ?? [],
        discountTotal: req.body.discountTotal ?? 0,
        subtotal: req.body.subtotal ?? 0,
        total: req.body.total ?? 0,
      },
    });

    const userMap = await getUserMap();
    const held = await prisma.heldSale.findUnique({
      where: { id: heldSaleId },
      include: { lines: true },
    });

    return res.status(201).json(held ? mapHeldSale(held, userMap) : null);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to hold bill');
  }
});

router.get('/held-sales', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const userMap = await getUserMap();
    const held = await prisma.heldSale.findMany({
      where: { status: SaleStatus.HELD },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(held.map((sale) => mapHeldSale(sale, userMap)));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load held bills');
  }
});

router.post('/held-sales/:id/recall', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    await applyWorkstationEvent(req, {
      aggregateType: 'held-sale',
      aggregateId: req.params.id,
      eventType: SyncEventType.HELD_SALE_RECALLED,
      terminalId: req.body.terminalId,
      payload: {
        heldSaleId: req.params.id,
      },
    });

    const held = await prisma.heldSale.findUnique({
      where: { id: req.params.id },
      include: { lines: true },
    });
    if (!held) {
      return res.status(404).json({ error: 'Held bill not found' });
    }

    const userMap = await getUserMap();
    return res.json(mapHeldSale(held, userMap));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to recall held bill');
  }
});

router.post('/sales', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const saleId = req.body.saleId ?? uuidv4();
    const payload: CompleteSaleInput = {
      receiptNumber: req.body.receiptNumber,
      terminalId: req.body.terminalId,
      branchId: req.body.branchId,
      cashierId: req.body.cashierId,
      customerId: req.body.customerId,
      shiftId: req.body.shiftId,
      heldSaleId: req.body.heldSaleId,
      lines: req.body.lines ?? [],
      payments: req.body.payments ?? [],
      discountTotal: req.body.discountTotal ?? 0,
      subtotal: req.body.subtotal ?? 0,
      taxTotal: req.body.taxTotal ?? 0,
      total: req.body.total ?? 0,
      marginTotal: req.body.marginTotal ?? 0,
    };
    const mappedTerminal = await prisma.terminal.findUnique({ where: { id: payload.terminalId } });
    if (!mappedTerminal) return res.status(400).json({ error: 'The terminal is not mapped to an inventory branch' });
    payload.branchId = mappedTerminal.branchId;

    const giftPayments = payload.payments.filter((payment) => payment.method === 'GIFT');
    for (const payment of giftPayments) {
      if (!payment.reference?.trim()) return res.status(400).json({ error: 'A voucher code is required for every gift-voucher payment' });
      const validationContext = {
        voucherCode: payment.reference.trim(),
        totalAmount: payload.total,
        hasDiscounts: payload.discountTotal > 0 || payload.lines.some((line) => line.discountAmount > 0),
        hasOtherVouchers: giftPayments.length > 1,
        items: payload.lines.map((line) => ({ skuId: line.productId, variantId: line.variantId, quantity: line.quantity, price: line.unitPrice })),
      };
      const validation = isLocalPosBackendMode()
        ? await validateUpstreamVoucher(validationContext)
        : await validateSharedVoucher(validationContext);
      if (!validation.isValid) return res.status(422).json({ error: validation.errors?.join('; ') || 'Voucher is invalid' });
      if (payment.amount > Number(validation.maxRedeemableAmount ?? 0)) {
        return res.status(422).json({ error: `Voucher ${payment.reference} can cover at most ${validation.maxRedeemableAmount}` });
      }
    }

    await applyWorkstationEvent(req, {
      aggregateType: 'sale',
      aggregateId: saleId,
      eventType: SyncEventType.SALE_COMPLETED,
      terminalId: payload.terminalId,
      payload,
    });

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { customer: true, lines: { include: { returnLines: true } }, payments: true },
    });

    const userMap = await getUserMap();
    return res.status(201).json(sale ? mapSale(sale, userMap) : null);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to complete sale');
  }
});

router.get('/sales', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId.trim() : '';
    const cashierId = typeof req.query.cashierId === 'string' ? req.query.cashierId.trim() : '';
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(1000, Math.max(1, Math.trunc(requestedLimit)))
      : 1000;
    const sales = await prisma.sale.findMany({
      where: {
        terminalId: terminalId || undefined,
        userId: cashierId || undefined,
      },
      include: { customer: true, lines: { include: { returnLines: true } }, payments: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const userMap = await getUserMap();
    return res.json(sales.map((sale) => mapSale(sale, userMap)));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load sales');
  }
});

router.get('/sales/:id', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const sale = await prisma.sale.findUnique({
      where: { id: req.params.id },
      include: { customer: true, lines: { include: { returnLines: true } }, payments: true },
    });

    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    const userMap = await getUserMap();
    return res.json(mapSale(sale, userMap));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load sale');
  }
});

router.post('/sales/:id/void', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    await applyWorkstationEvent(req, {
      aggregateType: 'sale',
      aggregateId: req.params.id,
      eventType: SyncEventType.SALE_VOIDED,
      terminalId: req.body.terminalId,
      payload: {
        saleId: req.params.id,
        reason: req.body.reason,
        managerId: req.body.managerId,
      },
    });

    const sale = await prisma.sale.findUnique({
      where: { id: req.params.id },
      include: { customer: true, lines: { include: { returnLines: true } }, payments: true },
    });
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    const userMap = await getUserMap();
    return res.json(mapSale(sale, userMap));
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to void sale');
  }
});

router.post('/returns', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const returnId = req.body.returnId ?? uuidv4();
    await applyWorkstationEvent(req, {
      aggregateType: 'return',
      aggregateId: returnId,
      eventType: SyncEventType.RETURN_CREATED,
      terminalId: req.body.terminalId,
      payload: {
        saleId: req.body.saleId,
        terminalId: req.body.terminalId,
        cashierId: req.body.cashierId,
        reason: req.body.reason,
        lines: req.body.lines ?? [],
      },
    });

    const record = await prisma.return.findUnique({
      where: { id: returnId },
      include: { lines: true },
    });
    return res.status(201).json(record);
  } catch (error) {
    await reportBackgroundServerError(error, 'backend.return.rejected', {
      saleId: typeof req.body?.saleId === 'string' ? req.body.saleId : undefined,
      terminalId: typeof req.body?.terminalId === 'string' ? req.body.terminalId : undefined,
    });
    // Rejections here are almost always the "only N remain returnable" /
    // "only a completed sale can be returned" validation thrown while
    // applying the event — surface that instead of a generic message so the
    // cashier sees why, e.g. that the line was already refunded.
    const message = error instanceof Error ? error.message : 'Failed to create return';
    return res.status(400).json({ error: message });
  }
});

router.patch('/customers/:id', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const customerId = req.params.id;
    const existing = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const patch: Record<string, unknown> = {};
    if (req.body.creditLimit !== undefined) patch.creditLimit = Number(req.body.creditLimit);
    if (req.body.phone !== undefined) patch.phone = req.body.phone;
    if (req.body.email !== undefined) patch.email = req.body.email;
    if (req.body.notes !== undefined) patch.notes = req.body.notes;
    if (req.body.tier !== undefined) patch.tier = req.body.tier;

    await applyWorkstationEvent(req, {
      aggregateType: 'customer',
      aggregateId: customerId,
      eventType: SyncEventType.CUSTOMER_UPSERTED,
      terminalId: req.body.terminalId,
      // Send a full profile snapshot so a central Inventory projection can
      // create this customer even when it has never seen the local POS seed.
      payload: { ...mapCustomer(existing), ...patch },
    });

    const updated = await prisma.customer.findUnique({ where: { id: customerId } });
    return res.json(updated ? mapCustomer(updated) : null);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to update customer');
  }
});

router.post('/customers/:id/credit-payments', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const customerId = req.params.id;
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A credit payment requires a positive amount' });
    }

    const paymentId = req.body.paymentId ?? uuidv4();
    // A payment may be the first customer-related event sent by this POS.
    // Queue the customer snapshot first so upstream projections can preserve
    // the ledger relationship without placeholder customer records.
    await applyWorkstationEvent(req, {
      aggregateType: 'customer',
      aggregateId: customerId,
      eventType: SyncEventType.CUSTOMER_UPSERTED,
      terminalId: req.body.terminalId,
      payload: mapCustomer(customer),
    });
    await applyWorkstationEvent(req, {
      aggregateType: 'credit-payment',
      aggregateId: paymentId,
      eventType: SyncEventType.CREDIT_PAYMENT_RECORDED,
      terminalId: req.body.terminalId,
      payload: {
        customerId,
        amount,
        method: req.body.method ?? 'CASH',
        note: req.body.note,
        terminalId: req.body.terminalId,
        userId: req.body.userId,
        shiftId: req.body.shiftId,
      },
    });

    const record = await prisma.creditPayment.findUnique({ where: { id: paymentId } });
    const userMap = await getUserMap();
    return res.status(201).json(record ? mapCreditPayment(record, userMap) : null);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to record credit payment');
  }
});

router.get('/customers/:id/account', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const customerId = req.params.id;
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const [creditSales, payments] = await Promise.all([
      prisma.sale.findMany({
        where: { customerId, status: SaleStatus.COMPLETED },
        include: { payments: true },
      }),
      prisma.creditPayment.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } }),
    ]);

    // v1 simplification: refunds/voids against a credit sale are not netted out
    // of the owed total automatically yet.
    const creditOwed = creditSales.reduce((sum, sale) => (
      sum + sale.payments
        .filter((payment) => payment.method === 'CREDIT')
        .reduce((paymentSum, payment) => paymentSum + payment.amount, 0)
    ), 0);
    const creditRepaid = payments.reduce((sum, payment) => sum + payment.amount, 0);
    const creditBalance = Math.max(0, creditOwed - creditRepaid);

    const userMap = await getUserMap();
    return res.json({
      customer: mapCustomer(customer),
      creditBalance,
      availableCredit: Math.max(0, (customer.creditLimit ?? 0) - creditBalance),
      creditPayments: payments.map((payment) => mapCreditPayment(payment, userMap)),
    });
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load customer account');
  }
});

router.get('/local/sync/status', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    return res.json(
      await getLocalSyncStatus(
        typeof req.query.deviceId === 'string' ? req.query.deviceId : getLocalPosDeviceId(),
        typeof req.query.terminalId === 'string' ? req.query.terminalId : getLocalPosTerminalId(),
      ),
    );
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load local sync status');
  }
});

router.get('/local/sync/dashboard', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    return res.json(
      await getLocalSyncDashboard(
        typeof req.query.deviceId === 'string' ? req.query.deviceId : getLocalPosDeviceId(),
        typeof req.query.terminalId === 'string' ? req.query.terminalId : getLocalPosTerminalId(),
        Number.isFinite(limit) && limit && limit > 0 ? Math.min(limit, 100) : 20,
      ),
    );
  } catch (error) {
    return respondWithServerError(req, res, error, 'Failed to load local sync dashboard');
  }
});

router.post('/local/sync/now', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    return res.json(
      await syncWithUpstream({
        deviceId: typeof req.body.deviceId === 'string' ? req.body.deviceId : resolveDeviceId(req),
        terminalId: typeof req.body.terminalId === 'string' ? req.body.terminalId : resolveTerminalId(req),
      }),
    );
  } catch (error) {
    return respondWithServerError(req, res, error, 'Local sync failed');
  }
});

router.post('/sync/handshake', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    await mergeHandshakeReferenceData(
      Array.isArray(req.body.users) ? req.body.users : [],
      Array.isArray(req.body.customers) ? req.body.customers : [],
    );
    const serverClock = await getServerVectorClock();
    const allEvents = await prisma.syncEvent.findMany();
    const clientClock = typeof req.body.vectorClock === 'object' && req.body.vectorClock != null
      ? req.body.vectorClock
      : {};
    const pendingRemoteCount = allEvents.filter((event) => event.sequenceNum > (clientClock[event.deviceId] ?? 0)).length;
    const conflictCount = await prisma.syncConflict.count({ where: { status: SyncConflictStatus.OPEN } });

    return res.json({
      serverVectorClock: serverClock,
      pendingRemoteCount,
      conflictCount,
    });
  } catch (error) {
    return respondWithServerError(req, res, error, 'Sync handshake failed');
  }
});

router.post('/sync/playback', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const result = await playbackEvents({
      deviceId: req.body.deviceId,
      terminalId: req.body.terminalId,
      vectorClock: req.body.vectorClock ?? {},
      events: req.body.events ?? [],
    });
    return res.json(result);
  } catch (error) {
    return respondWithServerError(req, res, error, 'Playback sync failed');
  }
});

router.post('/sync/confirm', async (req: Request, res: Response) => {
  try {
    await ensureSeedData();
    const serverClock = await confirmPlayback({
      deviceId: req.body.deviceId,
      terminalId: req.body.terminalId,
      vectorClock: req.body.vectorClock ?? {},
    });
    return res.json({ serverVectorClock: serverClock });
  } catch (error) {
    return respondWithServerError(req, res, error, 'Sync confirm failed');
  }
});

export default router;
