import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  CashCountMode,
  CompleteSaleInput,
  DEFAULT_DEVICE_ID,
  DEFAULT_TERMINAL_ID,
  HoldSaleInput,
  POSSyncDashboard,
  ProductVariant,
  ReturnInput,
  SaleStatus,
  SharedCatalogSnapshot,
  ShiftCloseInput,
  ShiftOpenInput,
  ShiftStatus,
  SyncConflict,
  SyncConflictPolicy,
  SyncConflictStatus,
  SyncConfirmRequest,
  SyncEvent,
  SyncEventState,
  SyncEventType,
  SyncPlaybackRequest,
  SyncPlaybackResponse,
  SyncStatusSummary,
  VectorClock,
  ZReportSummary,
} from '@jingles/shared';
import prisma from '../prisma';
import {
  getLocalPosDeviceId,
  getLocalPosTerminalId,
  getPosSyncAppToken,
  getPosUpstreamUrl,
  isLocalPosBackendMode,
} from '../localMode';
import {
  applySharedInventoryReturn,
  applySharedInventorySale,
  applySharedInventoryVoid,
} from '../sharedInventory';
import {
  getLocalCatalogSnapshot,
  replaceLocalCatalogSnapshot,
} from './localCatalog';
import {
  HOST_SYNC_AUTH_REQUIRED_ERROR,
  clearStoredSyncAuth,
  readStoredSyncAuth,
} from './syncCredentials';

type Tx = Prisma.TransactionClient;
const POS_SYNC_APP_TOKEN_HEADER = 'x-jingles-pos-app-token';
const POS_SYNC_APP_TOKEN_REJECTED_ERROR =
  'The POS app sync token was rejected by the inventory backend. Check the shared POS sync token configuration.';
type SyncRunResult = {
  accepted: number;
  remoteApplied: number;
  conflicts: number;
  status: SyncStatusSummary;
};
const inFlightSyncRuns = new Map<string, Promise<SyncRunResult>>();
let legacyRefreshInFlight: Promise<number> | null = null;

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

function normalizeClock(value: unknown): VectorClock {
  return parseJson<VectorClock>(value, {});
}

function compareVectorClocks(left: VectorClock, right: VectorClock): 'equal' | 'lt' | 'gt' | 'concurrent' {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftGreater = false;
  let rightGreater = false;

  for (const key of keys) {
    const a = left[key] ?? 0;
    const b = right[key] ?? 0;
    if (a > b) {
      leftGreater = true;
    }
    if (a < b) {
      rightGreater = true;
    }
  }

  if (!leftGreater && !rightGreater) {
    return 'equal';
  }
  if (leftGreater && !rightGreater) {
    return 'gt';
  }
  if (!leftGreater && rightGreater) {
    return 'lt';
  }
  return 'concurrent';
}

function compareEventOrder(
  leftSequence: number,
  leftDeviceId: string,
  rightSequence: number,
  rightDeviceId: string,
): number {
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return leftDeviceId.localeCompare(rightDeviceId);
}

function resolveConflictPolicy(eventType: SyncEventType): SyncConflictPolicy {
  switch (eventType) {
    case SyncEventType.SALE_COMPLETED:
    case SyncEventType.SALE_VOIDED:
    case SyncEventType.RETURN_CREATED:
    case SyncEventType.SHIFT_CLOSED:
      return SyncConflictPolicy.SERVER_WINS;
    default:
      return SyncConflictPolicy.LAST_WRITE_WINS;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseProductVariants(value: unknown): ProductVariant[] {
  const parsed = parseJson<ProductVariant[]>(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function applyVariantStockDelta(
  variants: ProductVariant[],
  variantId: string | null | undefined,
  delta: number,
  branchId?: string | null,
): ProductVariant[] {
  if (!variantId) {
    return variants;
  }

  return variants.map((variant) => (
    variant.id === variantId
      ? {
          ...variant,
          stockOnHand: variant.stockOnHand + delta,
          stockByBranch: branchId
            ? {
                ...(variant.stockByBranch ?? {}),
                [branchId]: Math.max(0, Number(variant.stockByBranch?.[branchId] ?? 0) + delta),
              }
            : variant.stockByBranch,
        }
      : variant
  ));
}

async function updateProductStock(
  tx: Tx,
  input: {
    productId: string;
    variantId?: string | null;
    delta: number;
    branchId?: string | null;
    vectorClock: VectorClock;
  },
): Promise<void> {
  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: { sku: true, stockOnHand: true, stockByBranchJson: true, variantsJson: true },
  });
  if (!product) {
    throw new Error(`Product ${input.productId} was not found`);
  }

  const variants = parseProductVariants(product.variantsJson);
  const variant = input.variantId ? variants.find((entry) => entry.id === input.variantId) : undefined;
  if (input.variantId && !variant) {
    throw new Error(`Variant ${input.variantId} was not found for ${product.sku}`);
  }
  if (input.delta < 0) {
    const requested = Math.abs(input.delta);
    const branchStock = parseJson<Record<string, number>>(product.stockByBranchJson, {});
    const available = input.branchId
      ? Number(variant?.stockByBranch?.[input.branchId] ?? branchStock[input.branchId] ?? 0)
      : (variant?.stockOnHand ?? product.stockOnHand);
    if (requested > available || requested > product.stockOnHand) {
      throw new Error(`Insufficient stock for ${variant?.variantCode ?? product.sku}: ${available} available`);
    }
  }

  const stockByBranch = parseJson<Record<string, number>>(product.stockByBranchJson, {});
  if (input.branchId) {
    stockByBranch[input.branchId] = Math.max(0, Number(stockByBranch[input.branchId] ?? 0) + input.delta);
  }

  await tx.product.update({
    where: { id: input.productId },
    data: {
      stockOnHand: input.delta >= 0
        ? { increment: input.delta }
        : { decrement: Math.abs(input.delta) },
      stockByBranchJson: json(stockByBranch),
      variantsJson: input.variantId
        ? JSON.stringify(
            applyVariantStockDelta(
              variants,
              input.variantId,
              input.delta,
              input.branchId,
            ),
          )
        : undefined,
      lastVectorClock: json(input.vectorClock),
    },
  });
}

function isConfirmedEvent(event: Pick<SyncEvent, 'state'>) {
  return event.state === SyncEventState.CONFIRMED;
}

function eventWins(
  incoming: Pick<SyncEvent, 'deviceId' | 'sequenceNum' | 'conflictPolicy'>,
  current: Pick<SyncEvent, 'deviceId' | 'sequenceNum'>,
): boolean {
  if (incoming.conflictPolicy === SyncConflictPolicy.SERVER_WINS) {
    const incomingServer = incoming.deviceId.startsWith('server:');
    const currentServer = current.deviceId.startsWith('server:');
    if (incomingServer !== currentServer) {
      return incomingServer;
    }
  }

  return compareEventOrder(
    incoming.sequenceNum,
    incoming.deviceId,
    current.sequenceNum,
    current.deviceId,
  ) >= 0;
}

export async function getServerVectorClock(tx: Tx = prisma): Promise<VectorClock> {
  const rows = await tx.syncDeviceState.findMany();
  return rows.reduce<VectorClock>((clock, row) => {
    if (row.lastSequenceNum > 0) {
      clock[row.deviceId] = row.lastSequenceNum;
    }
    return clock;
  }, {});
}

async function updateDeviceState(
  tx: Tx,
  deviceId: string,
  terminalId: string | null | undefined,
  sequenceNum: number,
  vectorClock: VectorClock,
  confirmedVectorClock?: VectorClock,
  options?: {
    markLastSyncAt?: boolean;
  },
): Promise<void> {
  const current = await tx.syncDeviceState.findUnique({ where: { deviceId } });
  const markLastSyncAt = options?.markLastSyncAt ?? false;
  await tx.syncDeviceState.upsert({
    where: { deviceId },
    create: {
      id: current?.id ?? `sync-device-${deviceId}`,
      deviceId,
      terminalId: terminalId ?? null,
      lastSequenceNum: sequenceNum,
      vectorClock: json(vectorClock),
      confirmedVectorClock: json(confirmedVectorClock ?? normalizeClock(current?.confirmedVectorClock)),
      online: current?.online ?? false,
      lastError: current?.lastError ?? null,
      lastSeenAt: new Date(),
      lastSyncAt: markLastSyncAt ? new Date() : current?.lastSyncAt ?? null,
    },
    update: {
      terminalId: terminalId ?? current?.terminalId ?? null,
      lastSequenceNum: Math.max(sequenceNum, current?.lastSequenceNum ?? 0),
      vectorClock: json(vectorClock),
      confirmedVectorClock: json(confirmedVectorClock ?? normalizeClock(current?.confirmedVectorClock)),
      online: current?.online ?? false,
      lastError: current?.lastError ?? null,
      lastSeenAt: new Date(),
      lastSyncAt: markLastSyncAt ? new Date() : current?.lastSyncAt ?? null,
    },
  });
}

async function saveCashCount(
  tx: Tx,
  shiftId: string,
  declaration: ShiftOpenInput['declaration'] | ShiftCloseInput['declaration'],
  idPrefix: string,
): Promise<void> {
  if (!declaration) {
    return;
  }

  const mode = declaration.mode
    ?? (idPrefix.endsWith('-closing') ? CashCountMode.CLOSING : CashCountMode.OPENING);

  await tx.shiftCashCount.upsert({
    where: { id: `${idPrefix}-${mode}` },
    create: {
      id: `${idPrefix}-${mode}`,
      shiftId,
      mode,
      total: declaration.total,
      denominations: json(declaration.denominations),
      variance: declaration.variance ?? null,
    },
    update: {
      total: declaration.total,
      denominations: json(declaration.denominations),
      variance: declaration.variance ?? null,
    },
  });
}

async function applyShiftOpenedEvent(tx: Tx, event: SyncEvent<ShiftOpenInput>): Promise<void> {
  const payload = event.payload;
  const existingOpenShift = await tx.pOSShift.findFirst({
    where: { terminalId: payload.terminalId, status: ShiftStatus.OPEN },
  });
  if (existingOpenShift && existingOpenShift.id !== event.aggregateId) {
    throw new Error(`Terminal ${payload.terminalId} already has an open shift`);
  }
  await tx.pOSShift.upsert({
    where: { id: event.aggregateId },
    create: {
      id: event.aggregateId,
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      userId: payload.cashierId,
      status: ShiftStatus.OPEN,
      openingFloat: payload.openingFloat,
      notes: payload.notes ?? null,
      synced: isConfirmedEvent(event),
      lastVectorClock: json(event.vectorClock),
    },
    update: {
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      userId: payload.cashierId,
      status: ShiftStatus.OPEN,
      openingFloat: payload.openingFloat,
      notes: payload.notes ?? null,
      synced: isConfirmedEvent(event),
      lastVectorClock: json(event.vectorClock),
    },
  });

  await saveCashCount(tx, event.aggregateId, payload.declaration, `${event.aggregateId}-opening`);
}

async function applyShiftClosedEvent(tx: Tx, event: SyncEvent<ShiftCloseInput>): Promise<void> {
  const payload = event.payload;
  await tx.pOSShift.update({
    where: { id: payload.shiftId },
    data: {
      status: ShiftStatus.CLOSED,
      closingFloat: payload.closingFloat,
      notes: payload.notes ?? null,
      closedAt: new Date(),
      lastVectorClock: json(event.vectorClock),
      synced: isConfirmedEvent(event),
    },
  });

  await saveCashCount(tx, payload.shiftId, payload.declaration, `${payload.shiftId}-closing`);
}

async function applyCashDeclaredEvent(
  tx: Tx,
  event: SyncEvent<{ shiftId: string; declaration: ShiftOpenInput['declaration'] | ShiftCloseInput['declaration'] }>,
): Promise<void> {
  const declaration = event.payload.declaration;
  if (!declaration) {
    return;
  }

  await tx.shiftCashCount.create({
    data: {
      id: `${event.aggregateId}-${event.id}`,
      shiftId: event.payload.shiftId,
      mode: declaration.mode,
      total: declaration.total,
      denominations: json(declaration.denominations),
      variance: declaration.variance ?? null,
    },
  });
}

async function applyHeldSaleSavedEvent(tx: Tx, event: SyncEvent<HoldSaleInput>): Promise<void> {
  const payload = event.payload;
  const customer = payload.customerId
    ? await tx.customer.findUnique({ where: { id: payload.customerId } })
    : null;

  await tx.heldSale.upsert({
    where: { id: event.aggregateId },
    create: {
      id: event.aggregateId,
      holdNumber: payload.holdNumber,
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      userId: payload.cashierId,
      customerId: payload.customerId ?? null,
      customerName: customer?.name ?? null,
      status: SaleStatus.HELD,
      subtotal: payload.subtotal,
      discountTotal: payload.discountTotal,
      total: payload.total,
      lastVectorClock: json(event.vectorClock),
    },
    update: {
      holdNumber: payload.holdNumber,
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      userId: payload.cashierId,
      customerId: payload.customerId ?? null,
      customerName: customer?.name ?? null,
      status: SaleStatus.HELD,
      subtotal: payload.subtotal,
      discountTotal: payload.discountTotal,
      total: payload.total,
      lastVectorClock: json(event.vectorClock),
    },
  });

  await tx.heldSaleLine.deleteMany({ where: { heldSaleId: event.aggregateId } });
  if (payload.lines.length > 0) {
    await tx.heldSaleLine.createMany({
      data: payload.lines.map((line) => ({
        id: line.uid,
        heldSaleId: event.aggregateId,
        productId: line.productId,
        sku: line.sku,
        name: line.name,
        variantId: line.variantId ?? null,
        variantCode: line.variantCode ?? null,
        variantName: line.variantName ?? null,
        variantAttributesJson: line.variantAttributes ? json(line.variantAttributes) : null,
        subcategory: line.subcategory,
        salespersonId: line.salespersonId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        tierLabel: line.tierLabel,
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
        costBasis: line.costBasis,
        lineTotal: line.lineTotal,
      })),
    });
  }
}

async function applyHeldSaleRecalledEvent(
  tx: Tx,
  event: SyncEvent<{ heldSaleId: string }>,
): Promise<void> {
  await tx.heldSale.update({
    where: { id: event.payload.heldSaleId },
    data: {
      status: SaleStatus.RECALLED,
      lastVectorClock: json(event.vectorClock),
    },
  });
}

async function applySaleCompletedEvent(tx: Tx, event: SyncEvent<CompleteSaleInput>): Promise<void> {
  const payload = event.payload;
  const existingSale = await tx.sale.findUnique({ where: { id: event.aggregateId } });
  if (existingSale) {
    return;
  }
  if (!payload.lines.length || payload.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    throw new Error('A sale requires at least one line with a positive whole-number quantity');
  }
  if (!payload.payments.length || payload.payments.some((payment) => !Number.isFinite(payment.amount) || payment.amount < 0)) {
    throw new Error('A sale requires valid payment amounts');
  }
  const paymentTotal = payload.payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (Math.abs(paymentTotal - payload.total) > 0.01) {
    throw new Error('Payment total does not match the sale total');
  }

  for (const line of payload.lines) {
    await updateProductStock(tx, {
      productId: line.productId,
      variantId: line.variantId,
      delta: -line.quantity,
      branchId: payload.branchId,
      vectorClock: event.vectorClock,
    });

    await tx.inventoryEvent.create({
      data: {
        id: `${event.id}-inventory-${line.productId}`,
        productId: line.productId,
        eventType: 'SALE_DEDUCTED',
        quantity: line.quantity,
        reference: payload.receiptNumber,
        notes: `Sale ${payload.receiptNumber}`,
      },
    });
  }

  await tx.sale.create({
    data: {
      id: event.aggregateId,
      receiptNumber: payload.receiptNumber,
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      userId: payload.cashierId,
      customerId: payload.customerId ?? null,
      shiftId: payload.shiftId ?? null,
      status: SaleStatus.COMPLETED,
      subtotal: payload.subtotal,
      discountTotal: payload.discountTotal,
      taxTotal: payload.taxTotal,
      total: payload.total,
      marginTotal: payload.marginTotal,
      heldSaleId: payload.heldSaleId ?? null,
      sourceDeviceId: event.deviceId,
      sourceSequenceNum: event.sequenceNum,
      synced: isConfirmedEvent(event),
      lastVectorClock: json(event.vectorClock),
      lines: {
        create: payload.lines.map((line) => ({
          id: line.uid,
          productId: line.productId,
          sku: line.sku,
          name: line.name,
          barcode: line.barcode ?? null,
          variantId: line.variantId ?? null,
          variantCode: line.variantCode ?? null,
          variantName: line.variantName ?? null,
          variantAttributesJson: line.variantAttributes ? json(line.variantAttributes) : null,
          subcategory: line.subcategory,
          salespersonId: line.salespersonId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          tierLabel: line.tierLabel,
          discountPercent: line.discountPercent,
          discountAmount: line.discountAmount,
          costBasis: line.costBasis,
          marginAmount: line.quantity * (line.unitPrice - line.costBasis) - line.discountAmount,
          lineTotal: line.lineTotal,
        })),
      },
      payments: {
        create: payload.payments.map((payment) => ({
          id: uuidv4(),
          method: payment.method,
          amount: payment.amount,
          tenderedAmount: payment.tenderedAmount ?? null,
          changeDue: payment.changeDue ?? null,
          reference: payment.reference ?? null,
          metadata: payment.metadata ? json(payment.metadata) : undefined,
        })),
      },
    },
  });

  if (payload.heldSaleId) {
    await tx.heldSale.updateMany({
      where: { id: payload.heldSaleId },
      data: {
        status: SaleStatus.RECALLED,
        lastVectorClock: json(event.vectorClock),
      },
    });
  }

  if (!isLocalPosBackendMode()) {
    await applySharedInventorySale({
      aggregateId: event.aggregateId,
      receiptNumber: payload.receiptNumber,
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      cashierId: payload.cashierId,
      payments: payload.payments,
      lines: payload.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        quantity: line.quantity,
        name: line.name,
        variantId: line.variantId ?? null,
        variantCode: line.variantCode ?? null,
        variantName: line.variantName ?? null,
      })),
    });
  }
}

async function applySaleVoidedEvent(
  tx: Tx,
  event: SyncEvent<{ saleId: string; reason?: string; managerId?: string }>,
): Promise<void> {
  const sale = await tx.sale.findUnique({
    where: { id: event.payload.saleId },
    include: { lines: true, returns: true },
  });

  if (!sale || sale.status === SaleStatus.VOIDED) {
    return;
  }
  if (sale.status !== SaleStatus.COMPLETED || sale.returns.length > 0) {
    throw new Error('Only a completed sale with no returns can be voided');
  }

  for (const line of sale.lines) {
    await updateProductStock(tx, {
      productId: line.productId,
      variantId: line.variantId,
      delta: line.quantity,
      branchId: sale.branchId,
      vectorClock: event.vectorClock,
    });

    await tx.inventoryEvent.create({
      data: {
        id: `${event.id}-void-${line.productId}`,
        productId: line.productId,
        eventType: 'VOID_RESTORED',
        quantity: line.quantity,
        reference: sale.receiptNumber,
        notes: event.payload.reason ?? 'Void sale',
      },
    });
  }

  await tx.sale.update({
    where: { id: sale.id },
    data: {
      status: SaleStatus.VOIDED,
      lastVectorClock: json(event.vectorClock),
    },
  });

  if (!isLocalPosBackendMode()) {
    await applySharedInventoryVoid({
      aggregateId: sale.id,
      receiptNumber: sale.receiptNumber,
      terminalId: sale.terminalId,
      branchId: sale.branchId,
      reason: event.payload.reason ?? null,
      lines: sale.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        quantity: line.quantity,
        name: line.name,
        variantId: line.variantId ?? null,
        variantCode: line.variantCode ?? null,
        variantName: line.variantName ?? null,
      })),
    });
  }
}

async function applyReturnCreatedEvent(tx: Tx, event: SyncEvent<ReturnInput>): Promise<void> {
  const payload = event.payload;
  const existingReturn = await tx.return.findUnique({ where: { id: event.aggregateId } });
  if (existingReturn) {
    return;
  }

  const sale = await tx.sale.findUnique({
    where: { id: payload.saleId },
    include: { lines: true },
  });

  if (!sale) {
    throw new Error('Sale not found');
  }
  if (sale.status !== SaleStatus.COMPLETED) {
    throw new Error('Only a completed sale can be returned');
  }
  if (!payload.lines.length) {
    throw new Error('A return requires at least one line');
  }

  const normalizedLines = [] as ReturnInput['lines'];
  for (const line of payload.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error('Return quantities must be positive whole numbers');
    }
    const saleLine = sale.lines.find((entry) => entry.id === line.saleLineId);
    if (!saleLine || saleLine.productId !== line.productId) {
      throw new Error('Return line does not belong to the selected sale');
    }
    const alreadyReturned = await tx.returnLine.aggregate({
      where: { saleLineId: saleLine.id },
      _sum: { quantity: true },
    });
    const remaining = saleLine.quantity - (alreadyReturned._sum.quantity ?? 0);
    if (line.quantity > remaining) {
      throw new Error(`Only ${remaining} unit(s) remain returnable for ${saleLine.sku}`);
    }
    normalizedLines.push({
      ...line,
      productId: saleLine.productId,
      variantId: saleLine.variantId ?? undefined,
      refundAmount: Math.round((saleLine.lineTotal / saleLine.quantity) * line.quantity * 100) / 100,
    });
  }

  const totalRefund = normalizedLines.reduce((sum, line) => sum + line.refundAmount, 0);

  for (const line of normalizedLines) {
    await updateProductStock(tx, {
      productId: line.productId,
      variantId: line.variantId,
      delta: line.quantity,
      branchId: sale.branchId,
      vectorClock: event.vectorClock,
    });

    await tx.inventoryEvent.create({
      data: {
        id: `${event.id}-return-${line.productId}`,
        productId: line.productId,
        eventType: 'RETURNED',
        quantity: line.quantity,
        reference: payload.saleId,
        notes: payload.reason ?? 'Return created',
      },
    });
  }

  await tx.return.create({
    data: {
      id: event.aggregateId,
      saleId: payload.saleId,
      userId: payload.cashierId,
      terminalId: payload.terminalId,
      reason: payload.reason ?? null,
      totalRefund,
      sourceDeviceId: event.deviceId,
      sourceSequenceNum: event.sequenceNum,
      lastVectorClock: json(event.vectorClock),
      lines: {
        create: normalizedLines.map((line) => ({
          id: uuidv4(),
          saleLineId: line.saleLineId,
          productId: line.productId,
          variantId: line.variantId ?? null,
          quantity: line.quantity,
          refundAmount: line.refundAmount,
        })),
      },
    },
  });

  const returnedRows = await tx.returnLine.findMany({
    where: { saleLine: { saleId: sale.id } },
    select: { saleLineId: true, quantity: true },
  });
  const returnedByLine = new Map<string, number>();
  returnedRows.forEach((line) => returnedByLine.set(
    line.saleLineId,
    (returnedByLine.get(line.saleLineId) ?? 0) + line.quantity,
  ));
  const fullyRefunded = sale.lines.every((line) => (returnedByLine.get(line.id) ?? 0) >= line.quantity);
  await tx.sale.update({
    where: { id: sale.id },
    data: {
      status: fullyRefunded ? SaleStatus.REFUNDED : SaleStatus.COMPLETED,
      lastVectorClock: json(event.vectorClock),
    },
  });

  if (!isLocalPosBackendMode()) {
    await applySharedInventoryReturn({
      aggregateId: event.aggregateId,
      saleId: payload.saleId,
      terminalId: payload.terminalId,
      branchId: sale.branchId,
      reason: payload.reason ?? null,
      refundAmount: totalRefund,
      lines: normalizedLines.map((line) => {
        const saleLine = sale?.lines.find((entry) => entry.id === line.saleLineId);
        return {
          productId: line.productId,
          sku: saleLine?.sku ?? line.productId,
          quantity: line.quantity,
          name: saleLine?.name,
          variantId: line.variantId ?? saleLine?.variantId ?? null,
          variantCode: saleLine?.variantCode ?? null,
          variantName: saleLine?.variantName ?? null,
        };
      }),
    });
  }
}

async function getAggregateClock(
  tx: Tx,
  aggregateType: string,
  aggregateId: string,
): Promise<VectorClock> {
  switch (aggregateType) {
    case 'shift': {
      const shift = await tx.pOSShift.findUnique({
        where: { id: aggregateId },
        select: { lastVectorClock: true },
      });
      return normalizeClock(shift?.lastVectorClock);
    }
    case 'sale': {
      const sale = await tx.sale.findUnique({
        where: { id: aggregateId },
        select: { lastVectorClock: true },
      });
      return normalizeClock(sale?.lastVectorClock);
    }
    case 'held-sale': {
      const held = await tx.heldSale.findUnique({
        where: { id: aggregateId },
        select: { lastVectorClock: true },
      });
      return normalizeClock(held?.lastVectorClock);
    }
    case 'return': {
      const value = await tx.return.findUnique({
        where: { id: aggregateId },
        select: { lastVectorClock: true },
      });
      return normalizeClock(value?.lastVectorClock);
    }
    default:
      return {};
  }
}

async function getLatestAggregateEvent(
  tx: Tx,
  aggregateType: string,
  aggregateId: string,
): Promise<SyncEvent | null> {
  const events = await tx.syncEvent.findMany({
    where: { aggregateType, aggregateId },
    orderBy: [{ createdAt: 'desc' }],
    take: 10,
  });

  if (events.length === 0) {
    return null;
  }

  const sorted = events
    .map((event) => ({
      id: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType as SyncEventType,
      payload: parseJson<unknown>(event.payload, {}),
      deviceId: event.deviceId,
      sequenceNum: event.sequenceNum,
      lamport: event.lamport,
      vectorClock: normalizeClock(event.vectorClock),
      conflictPolicy: (event.conflictPolicy as SyncConflictPolicy) ?? SyncConflictPolicy.LAST_WRITE_WINS,
      state: (event.state as SyncEventState) ?? SyncEventState.CONFIRMED,
      createdAt: event.createdAt.toISOString(),
      appliedAt: event.appliedAt?.toISOString(),
    }))
    .sort((left, right) =>
      compareEventOrder(right.sequenceNum, right.deviceId, left.sequenceNum, left.deviceId),
    );

  return sorted[0] ?? null;
}

function toConflictDto(conflict: {
  id: string;
  aggregateType: string;
  aggregateId: string;
  localEventId: string | null;
  remoteEventId: string | null;
  policy: string;
  status: string;
  detail: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
}): SyncConflict {
  return {
    id: conflict.id,
    aggregateType: conflict.aggregateType,
    aggregateId: conflict.aggregateId,
    localEventId: conflict.localEventId ?? undefined,
    remoteEventId: conflict.remoteEventId ?? undefined,
    policy: conflict.policy as SyncConflictPolicy,
    status: conflict.status as SyncConflictStatus,
    detail: parseJson<Record<string, unknown> | undefined>(conflict.detail, undefined),
    createdAt: conflict.createdAt.toISOString(),
    resolvedAt: conflict.resolvedAt?.toISOString(),
  };
}

async function recordConflict(
  tx: Tx,
  incoming: SyncEvent,
  existing: SyncEvent,
  relation: 'concurrent',
): Promise<SyncConflict> {
  const conflict = await tx.syncConflict.create({
    data: {
      id: uuidv4(),
      aggregateType: incoming.aggregateType,
      aggregateId: incoming.aggregateId,
      localEventId: existing.id,
      remoteEventId: incoming.id,
      policy: incoming.conflictPolicy,
      status: SyncConflictStatus.OPEN,
      detail: json({
        relation,
        localVectorClock: existing.vectorClock,
        remoteVectorClock: incoming.vectorClock,
      }),
    },
  });

  return toConflictDto(conflict);
}

async function applyProjectionEvent(tx: Tx, event: SyncEvent): Promise<void> {
  switch (event.eventType) {
    case SyncEventType.SHIFT_OPENED:
      await applyShiftOpenedEvent(tx, event as SyncEvent<ShiftOpenInput>);
      return;
    case SyncEventType.SHIFT_CLOSED:
      await applyShiftClosedEvent(tx, event as SyncEvent<ShiftCloseInput>);
      return;
    case SyncEventType.CASH_DECLARED:
      await applyCashDeclaredEvent(
        tx,
        event as SyncEvent<{ shiftId: string; declaration: ShiftOpenInput['declaration'] | ShiftCloseInput['declaration'] }>,
      );
      return;
    case SyncEventType.HELD_SALE_SAVED:
      await applyHeldSaleSavedEvent(tx, event as SyncEvent<HoldSaleInput>);
      return;
    case SyncEventType.HELD_SALE_RECALLED:
      await applyHeldSaleRecalledEvent(tx, event as SyncEvent<{ heldSaleId: string }>);
      return;
    case SyncEventType.SALE_COMPLETED:
      await applySaleCompletedEvent(tx, event as SyncEvent<CompleteSaleInput>);
      return;
    case SyncEventType.SALE_VOIDED:
      await applySaleVoidedEvent(tx, event as SyncEvent<{ saleId: string; reason?: string; managerId?: string }>);
      return;
    case SyncEventType.RETURN_CREATED:
      await applyReturnCreatedEvent(tx, event as SyncEvent<ReturnInput>);
      return;
    default:
      return;
  }
}

function toStoredEventDto(event: {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  vectorClock: unknown;
  deviceId: string;
  terminalId: string | null;
  sequenceNum: number;
  lamport: number;
  conflictPolicy: string;
  state: string;
  createdAt: Date;
  appliedAt: Date | null;
}): SyncEvent {
  return {
    id: event.id,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType as SyncEventType,
    payload: parseJson<unknown>(event.payload, {}),
    deviceId: event.deviceId,
    sequenceNum: event.sequenceNum,
    lamport: event.lamport,
    vectorClock: normalizeClock(event.vectorClock),
    conflictPolicy: event.conflictPolicy as SyncConflictPolicy,
    state: event.state as SyncEventState,
    createdAt: event.createdAt.toISOString(),
    appliedAt: event.appliedAt?.toISOString(),
  };
}

export async function appendEvent(
  tx: Tx,
  event: SyncEvent,
  options?: {
    preservePendingState?: boolean;
  },
): Promise<{ storedEvent: SyncEvent; applied: boolean; conflict?: SyncConflict }> {
  const duplicate = await tx.syncEvent.findFirst({
    where: {
      OR: [
        { id: event.id },
        { deviceId: event.deviceId, sequenceNum: event.sequenceNum },
      ],
    },
  });

  if (duplicate) {
    return { storedEvent: toStoredEventDto(duplicate), applied: duplicate.appliedAt != null };
  }

  const aggregateClock = await getAggregateClock(tx, event.aggregateType, event.aggregateId);
  const relation = compareVectorClocks(event.vectorClock, aggregateClock);
  const latestEvent = await getLatestAggregateEvent(tx, event.aggregateType, event.aggregateId);

  let applyEvent = relation !== 'lt' && relation !== 'equal';
  let conflict: SyncConflict | undefined;

  if (relation === 'concurrent' && latestEvent) {
    conflict = await recordConflict(tx, event, latestEvent, relation);
    applyEvent = eventWins(event, latestEvent);
  }

  const storedState =
    options?.preservePendingState
      ? SyncEventState.PENDING
      : applyEvent
        ? SyncEventState.CONFIRMED
        : SyncEventState.PENDING;

  const stored = await tx.syncEvent.create({
    data: {
      id: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: json(event.payload),
      vectorClock: json(event.vectorClock),
      deviceId: event.deviceId,
      terminalId: (event.payload as Record<string, unknown>).terminalId as string | undefined ?? null,
      sequenceNum: event.sequenceNum,
      lamport: event.lamport ?? event.sequenceNum,
      conflictPolicy: event.conflictPolicy,
      state: storedState,
      appliedAt: applyEvent ? new Date() : null,
    },
  });

  if (applyEvent) {
    await applyProjectionEvent(tx, event);
  }

  await updateDeviceState(tx, event.deviceId, stored.terminalId, event.sequenceNum, event.vectorClock, undefined, {
    markLastSyncAt: false,
  });

  return { storedEvent: toStoredEventDto(stored), applied: applyEvent, conflict };
}

export async function createServerEvent(
  tx: Tx,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: SyncEventType;
    payload: unknown;
    terminalId?: string | null;
    deviceId?: string;
  },
): Promise<SyncEvent> {
  const deviceId = input.deviceId ?? `server:${input.terminalId ?? 'api'}`;
  const currentState = await tx.syncDeviceState.findUnique({ where: { deviceId } });
  const nextSequence = (currentState?.lastSequenceNum ?? 0) + 1;
  const clock = await getServerVectorClock(tx);
  clock[deviceId] = nextSequence;

  return {
    id: uuidv4(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload,
    deviceId,
    sequenceNum: nextSequence,
    lamport: nextSequence,
    vectorClock: clock,
    conflictPolicy: resolveConflictPolicy(input.eventType),
    state: SyncEventState.PENDING,
    createdAt: new Date().toISOString(),
  };
}

export async function createLocalEvent(
  tx: Tx,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: SyncEventType;
    payload: unknown;
    terminalId?: string | null;
    deviceId?: string;
  },
): Promise<SyncEvent> {
  const deviceId = input.deviceId ?? getLocalPosDeviceId();
  const currentState = await tx.syncDeviceState.findUnique({ where: { deviceId } });
  const nextSequence = (currentState?.lastSequenceNum ?? 0) + 1;
  const clock = await getServerVectorClock(tx);
  clock[deviceId] = nextSequence;

  return {
    id: uuidv4(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload,
    deviceId,
    sequenceNum: nextSequence,
    lamport: nextSequence,
    vectorClock: clock,
    conflictPolicy: resolveConflictPolicy(input.eventType),
    state: SyncEventState.PENDING,
    createdAt: new Date().toISOString(),
  };
}

export async function applyServerEvent(
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: SyncEventType;
    payload: unknown;
    terminalId?: string | null;
    deviceId?: string;
  },
): Promise<SyncEvent> {
  return prisma.$transaction(async (tx) => {
    const event = await createServerEvent(tx, input);
    await appendEvent(tx, event);
    return event;
  });
}

export async function applyLocalEvent(
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: SyncEventType;
    payload: unknown;
    terminalId?: string | null;
    deviceId?: string;
  },
): Promise<SyncEvent> {
  return prisma.$transaction(async (tx) => {
    const event = await createLocalEvent(tx, input);
    await appendEvent(tx, event, { preservePendingState: true });
    return event;
  });
}

export async function playbackEvents(input: SyncPlaybackRequest): Promise<SyncPlaybackResponse> {
  return prisma.$transaction(async (tx) => {
    const acceptedEventIds: string[] = [];
    const conflicts: SyncConflict[] = [];

    const sortedIncoming = [...input.events].sort((left, right) =>
      compareEventOrder(left.sequenceNum, left.deviceId, right.sequenceNum, right.deviceId),
    );

    for (const event of sortedIncoming) {
      const normalizedEvent: SyncEvent = {
        ...event,
        conflictPolicy: event.conflictPolicy ?? resolveConflictPolicy(event.eventType),
        state: event.state ?? SyncEventState.PENDING,
      };

      const result = await appendEvent(tx, normalizedEvent);
      acceptedEventIds.push(result.storedEvent.id);
      if (result.conflict) {
        conflicts.push(result.conflict);
      }
    }

    const serverVectorClock = await getServerVectorClock(tx);
    const allEvents = await tx.syncEvent.findMany({ orderBy: [{ createdAt: 'asc' }] });
    const remoteEvents = allEvents
      .filter((event) => event.sequenceNum > (input.vectorClock[event.deviceId] ?? 0))
      .map(toStoredEventDto);

    return {
      acceptedEventIds,
      remoteEvents,
      serverVectorClock,
      conflicts,
    };
  });
}

export async function confirmPlayback(input: SyncConfirmRequest): Promise<VectorClock> {
  return prisma.$transaction(async (tx) => {
    const state = await tx.syncDeviceState.findUnique({ where: { deviceId: input.deviceId } });
    await tx.syncDeviceState.upsert({
      where: { deviceId: input.deviceId },
      create: {
        id: state?.id ?? `sync-device-${input.deviceId}`,
        deviceId: input.deviceId,
        terminalId: input.terminalId,
        lastSequenceNum: state?.lastSequenceNum ?? 0,
        vectorClock: json(normalizeClock(state?.vectorClock)),
        confirmedVectorClock: json(input.vectorClock),
        online: true,
        lastError: null,
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
      },
      update: {
        terminalId: input.terminalId,
        confirmedVectorClock: json(input.vectorClock),
        online: true,
        lastError: null,
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
      },
    });

    return getServerVectorClock(tx);
  });
}

async function buildLocalSyncStatusInTransaction(
  tx: Tx,
  deviceId: string,
  terminalId: string,
): Promise<SyncStatusSummary> {
  const appToken = getPosSyncAppToken();
  const state = await tx.syncDeviceState.findUnique({ where: { deviceId } });
  const pendingEvents = await tx.syncEvent.count({ where: { state: SyncEventState.PENDING } });
  const conflictCount = await tx.syncConflict.count({ where: { status: SyncConflictStatus.OPEN } });
  const localVectorClock = await getServerVectorClock(tx);
  const syncAuth = appToken ? null : await readStoredSyncAuth(tx);

  return {
    online: state?.online ?? false,
    pendingEvents,
    conflictCount,
    deviceId,
    localVectorClock,
    remoteVectorClock: normalizeClock(state?.confirmedVectorClock),
    lastSyncAt: state?.lastSyncAt?.toISOString(),
    lastError:
      appToken && state?.lastError === HOST_SYNC_AUTH_REQUIRED_ERROR
        ? undefined
        : state?.lastError ?? undefined,
    syncAuthConfigured: Boolean(appToken || syncAuth?.token),
    syncAuthIdentity: syncAuth?.identity,
    syncAuthMode: appToken ? 'app_token' : syncAuth?.token ? 'user_token' : undefined,
    needsSyncAuth: !appToken && !syncAuth?.token,
  };
}

export async function getLocalSyncStatus(
  deviceId: string = getLocalPosDeviceId(),
  terminalId: string = getLocalPosTerminalId(),
): Promise<SyncStatusSummary> {
  return prisma.$transaction((tx) => buildLocalSyncStatusInTransaction(tx, deviceId, terminalId));
}

export async function getLocalSyncDashboard(
  deviceId: string = getLocalPosDeviceId(),
  terminalId: string = getLocalPosTerminalId(),
  limit = 20,
): Promise<POSSyncDashboard> {
  return prisma.$transaction(async (tx) => {
    const status = await buildLocalSyncStatusInTransaction(tx, deviceId, terminalId);
    const pendingEvents = await tx.syncEvent.findMany({
      where: { state: SyncEventState.PENDING },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
    const recentEvents = await tx.syncEvent.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
    const conflicts = await tx.syncConflict.findMany({
      where: { status: SyncConflictStatus.OPEN },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });

    return {
      status,
      pendingEvents: pendingEvents.map(toStoredEventDto),
      recentEvents: recentEvents.map(toStoredEventDto),
      conflicts: conflicts.map(toConflictDto),
    };
  });
}

async function updateAggregateSyncState(
  tx: Tx,
  events: Array<{ aggregateType: string; aggregateId: string }>,
  synced: boolean,
) {
  const shiftIds = Array.from(
    new Set(events.filter((event) => event.aggregateType === 'shift').map((event) => event.aggregateId)),
  );
  const saleIds = Array.from(
    new Set(events.filter((event) => event.aggregateType === 'sale').map((event) => event.aggregateId)),
  );

  if (shiftIds.length > 0) {
    await tx.pOSShift.updateMany({
      where: { id: { in: shiftIds } },
      data: { synced },
    });
  }

  if (saleIds.length > 0) {
    await tx.sale.updateMany({
      where: { id: { in: saleIds } },
      data: { synced },
    });
  }
}

export async function markLocalEventsConfirmed(
  eventIds: string[],
  serverVectorClock: VectorClock,
  deviceId: string = getLocalPosDeviceId(),
  terminalId: string = getLocalPosTerminalId(),
) {
  return prisma.$transaction(async (tx) => {
    if (eventIds.length > 0) {
      await tx.syncEvent.updateMany({
        where: { id: { in: eventIds } },
        data: { state: SyncEventState.CONFIRMED },
      });

      const events = await tx.syncEvent.findMany({
        where: { id: { in: eventIds } },
        select: { aggregateType: true, aggregateId: true },
      });
      await updateAggregateSyncState(tx, events, true);
    }

    const state = await tx.syncDeviceState.findUnique({ where: { deviceId } });
    await tx.syncDeviceState.upsert({
      where: { deviceId },
      create: {
        id: state?.id ?? `sync-device-${deviceId}`,
        deviceId,
        terminalId,
        lastSequenceNum: state?.lastSequenceNum ?? 0,
        vectorClock: json(await getServerVectorClock(tx)),
        confirmedVectorClock: json(serverVectorClock),
        online: true,
        lastError: null,
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
      },
      update: {
        terminalId,
        vectorClock: json(await getServerVectorClock(tx)),
        confirmedVectorClock: json(serverVectorClock),
        online: true,
        lastError: null,
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
      },
    });
  });
}

export async function recordLocalSyncFailure(
  errorMessage: string,
  deviceId: string = getLocalPosDeviceId(),
  terminalId: string = getLocalPosTerminalId(),
) {
  return prisma.$transaction(async (tx) => {
    const state = await tx.syncDeviceState.findUnique({ where: { deviceId } });
    await tx.syncDeviceState.upsert({
      where: { deviceId },
      create: {
        id: state?.id ?? `sync-device-${deviceId}`,
        deviceId,
        terminalId,
        lastSequenceNum: state?.lastSequenceNum ?? 0,
        vectorClock: json(normalizeClock(state?.vectorClock)),
        confirmedVectorClock: json(normalizeClock(state?.confirmedVectorClock)),
        online: false,
        lastError: errorMessage,
        lastSeenAt: new Date(),
        lastSyncAt: state?.lastSyncAt ?? null,
      },
      update: {
        terminalId,
        online: false,
        lastError: errorMessage,
        lastSeenAt: new Date(),
      },
    });
  });
}

export async function appendRemoteEventsFromServer(
  events: SyncEvent[],
): Promise<SyncConflict[]> {
  return prisma.$transaction(async (tx) => {
    const conflicts: SyncConflict[] = [];

    for (const event of events) {
      const result = await appendEvent(
        tx,
        {
          ...event,
          state: SyncEventState.CONFIRMED,
        },
      );

      if (result.conflict) {
        conflicts.push(result.conflict);
      }
    }

    return conflicts;
  });
}

async function fetchUpstreamJson<T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown }) {
  const appToken = getPosSyncAppToken();
  const syncAuth = appToken ? null : await readStoredSyncAuth();
  if (!appToken && !syncAuth?.token) {
    throw new Error(HOST_SYNC_AUTH_REQUIRED_ERROR);
  }

  const response = await fetch(`${getPosUpstreamUrl()}${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(appToken
        ? { [POS_SYNC_APP_TOKEN_HEADER]: appToken }
        : { Authorization: `Bearer ${syncAuth!.token}` }),
    },
    ...(typeof options?.body === 'undefined'
      ? {}
      : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    if (response.status === 401 || response.status === 403) {
      if (!appToken) {
        await clearStoredSyncAuth(prisma, { preserveIdentity: true });
        throw new Error(HOST_SYNC_AUTH_REQUIRED_ERROR);
      }

      throw new Error(POS_SYNC_APP_TOKEN_REJECTED_ERROR);
    }

    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function validateUpstreamVoucher(context: unknown) {
  return fetchUpstreamJson<any>('/api/pos/vouchers/validate', { method: 'POST', body: context });
}

export async function refreshLocalCatalogFromUpstream(): Promise<SharedCatalogSnapshot> {
  const snapshot = await fetchUpstreamJson<SharedCatalogSnapshot>('/api/pos/catalog/snapshot');
  await replaceLocalCatalogSnapshot(snapshot);
  return snapshot;
}

type LegacyRecordPage = {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    source_table: string;
    source_id: string;
    payload: Record<string, unknown>;
    first_synced_at: string;
    last_synced_at: string;
  }>;
};

export async function refreshLegacyPosRecordsFromUpstream(): Promise<number> {
  const pageSize = 500;
  let page = 1;
  let imported = 0;
  while (true) {
    const result = await fetchUpstreamJson<LegacyRecordPage>(
      `/api/pos/legacy-records?page=${page}&pageSize=${pageSize}`,
    );
    if (result.items.length > 0) {
      await prisma.$transaction(
        result.items.map((item) => prisma.legacyPOSRecord.upsert({
          where: { sourceTable_sourceId: { sourceTable: item.source_table, sourceId: item.source_id } },
          create: {
            sourceTable: item.source_table,
            sourceId: item.source_id,
            payload: JSON.stringify(item.payload),
            firstSyncedAt: new Date(item.first_synced_at),
            lastSyncedAt: new Date(item.last_synced_at),
          },
          update: {
            payload: JSON.stringify(item.payload),
            lastSyncedAt: new Date(item.last_synced_at),
          },
        })),
      );
      imported += result.items.length;
    }
    if (page * pageSize >= result.total || result.items.length === 0) break;
    page += 1;
  }
  return imported;
}

function queueLegacyPosRecordRefresh() {
  if (legacyRefreshInFlight) {
    return;
  }

  legacyRefreshInFlight = refreshLegacyPosRecordsFromUpstream()
    .catch((error) => {
      console.error('Background legacy POS record refresh failed', error);
      return 0;
    })
    .finally(() => {
      legacyRefreshInFlight = null;
    });
}

async function runSyncWithUpstream(options?: {
  deviceId?: string;
  terminalId?: string;
}): Promise<SyncRunResult> {
  const deviceId = options?.deviceId ?? getLocalPosDeviceId();
  const terminalId = options?.terminalId ?? getLocalPosTerminalId();

  try {
    const currentStatus = await getLocalSyncStatus(deviceId, terminalId);
    await fetchUpstreamJson('/api/pos/sync/handshake', {
      method: 'POST',
      body: {
        deviceId,
        terminalId,
        vectorClock: currentStatus.localVectorClock,
      },
    });

    const pendingEvents = await prisma.syncEvent.findMany({
      where: { state: SyncEventState.PENDING },
      orderBy: [{ createdAt: 'asc' }],
    });

    const playback = await fetchUpstreamJson<SyncPlaybackResponse>('/api/pos/sync/playback', {
      method: 'POST',
      body: {
        deviceId,
        terminalId,
        vectorClock: currentStatus.localVectorClock,
        events: pendingEvents.map(toStoredEventDto),
      } satisfies SyncPlaybackRequest,
    });

    const remoteConflicts = await appendRemoteEventsFromServer(playback.remoteEvents);
    await markLocalEventsConfirmed(playback.acceptedEventIds, playback.serverVectorClock, deviceId, terminalId);

    const updatedStatus = await getLocalSyncStatus(deviceId, terminalId);
    await fetchUpstreamJson('/api/pos/sync/confirm', {
      method: 'POST',
      body: {
        deviceId,
        terminalId,
        vectorClock: updatedStatus.localVectorClock,
      } satisfies SyncConfirmRequest,
    });

    try {
      await refreshLocalCatalogFromUpstream();
      queueLegacyPosRecordRefresh();
    } catch (catalogError: any) {
      await recordLocalSyncFailure(`Projection refresh failed: ${catalogError.message}`, deviceId, terminalId);
    }

    return {
      accepted: playback.acceptedEventIds.length,
      remoteApplied: playback.remoteEvents.length,
      conflicts: playback.conflicts.length + remoteConflicts.length,
      status: await getLocalSyncStatus(deviceId, terminalId),
    };
  } catch (error: any) {
    // Catalog projection is independent from transactional event playback. A
    // rejected sale/shift event must not leave the workstation on a stale SKU
    // list or stale inventory quantities indefinitely.
    let failureMessage = error.message;
    try {
      await refreshLocalCatalogFromUpstream();
      queueLegacyPosRecordRefresh();
    } catch (catalogError: any) {
      failureMessage = `${failureMessage}; Projection refresh failed: ${catalogError.message}`;
    }

    await recordLocalSyncFailure(failureMessage, deviceId, terminalId);
    return {
      accepted: 0,
      remoteApplied: 0,
      conflicts: 0,
      status: await getLocalSyncStatus(deviceId, terminalId),
    };
  }
}

export async function syncWithUpstream(options?: {
  deviceId?: string;
  terminalId?: string;
}): Promise<SyncRunResult> {
  const deviceId = options?.deviceId ?? getLocalPosDeviceId();
  const terminalId = options?.terminalId ?? getLocalPosTerminalId();
  const key = `${deviceId}::${terminalId}`;
  const existingRun = inFlightSyncRuns.get(key);
  if (existingRun) {
    return existingRun;
  }

  const nextRun = runSyncWithUpstream({ deviceId, terminalId })
    .finally(() => {
      if (inFlightSyncRuns.get(key) === nextRun) {
        inFlightSyncRuns.delete(key);
      }
    });

  inFlightSyncRuns.set(key, nextRun);
  return nextRun;
}

const zReportInclude = { cashCounts: true, sales: { include: { payments: true, returns: true, lines: true } } } as const;
type ZReportShift = Prisma.POSShiftGetPayload<{ include: typeof zReportInclude }>;

function summarizeZShift(shift: ZReportShift): ZReportSummary {
    const shiftId = shift.id;
    const grossSales = shift.sales.reduce((sum, sale) => sum + sale.subtotal, 0);
    const discounts = shift.sales.reduce((sum, sale) => sum + sale.discountTotal, 0);
    const refunds = shift.sales.reduce(
      (sum, sale) => sum + sale.returns.reduce((returnSum, record) => returnSum + record.totalRefund, 0),
      0,
    );
    const netSales = shift.sales.reduce((sum, sale) => sum + sale.total, 0) - refunds;
    const paymentBreakdown = shift.sales.reduce<Record<string, number>>((bucket, sale) => {
      for (const payment of sale.payments) {
        bucket[payment.method] = (bucket[payment.method] ?? 0) + payment.amount;
      }
      return bucket;
    }, {});
    const paymentCounts = shift.sales.reduce<Record<string, number>>((bucket, sale) => {
      for (const payment of sale.payments) {
        bucket[payment.method] = (bucket[payment.method] ?? 0) + 1;
      }
      return bucket;
    }, {});
    const discountedLineCount = shift.sales.reduce(
      (count, sale) => count + (sale.lines ?? []).filter((line) => line.discountAmount > 0).length,
      0,
    );
    const productCount = shift.sales.reduce(
      (count, sale) => count + (sale.lines ?? []).reduce((lineCount, line) => lineCount + line.quantity, 0),
      0,
    );
    const countedDrawer = shift.cashCounts
      .filter((item) => item.mode === CashCountMode.CLOSING)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]?.total;
    const expectedDrawer = shift.openingFloat + (paymentBreakdown.CASH ?? 0) - refunds;

    return {
      shiftId,
      grossSales,
      discounts,
      refunds,
      netSales,
      transactionCount: shift.sales.length,
      paymentBreakdown,
      expectedDrawer,
      openingFloat: shift.openingFloat,
      countedDrawer,
      variance: countedDrawer == null ? undefined : countedDrawer - expectedDrawer,
      paymentCounts,
      discountedLineCount,
      productCount,
    };
}

export async function buildZReport(shiftId: string): Promise<ZReportSummary> {
  return prisma.$transaction(async (tx) => {
    const shift = await tx.pOSShift.findUnique({ where: { id: shiftId }, include: zReportInclude });
    if (!shift) throw new Error('Shift not found');
    return summarizeZShift(shift);
  });
}

export async function buildZReports(shiftIds: string[]): Promise<ZReportSummary[]> {
  if (shiftIds.length === 0) return [];
  const shifts = await prisma.pOSShift.findMany({
    where: { id: { in: shiftIds } },
    include: zReportInclude,
  });
  return shifts.map(summarizeZShift);
}
