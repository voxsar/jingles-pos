import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  CashCountMode,
  CompleteSaleInput,
  HoldSaleInput,
  ReturnInput,
  SaleStatus,
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
  VectorClock,
  ZReportSummary,
} from '@jingles/shared';
import prisma from '../prisma';

type Tx = Prisma.TransactionClient;

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
): Promise<void> {
  const current = await tx.syncDeviceState.findUnique({ where: { deviceId } });
  await tx.syncDeviceState.upsert({
    where: { deviceId },
    create: {
      id: current?.id ?? `sync-device-${deviceId}`,
      deviceId,
      terminalId: terminalId ?? null,
      lastSequenceNum: sequenceNum,
      vectorClock: json(vectorClock),
      confirmedVectorClock: json(confirmedVectorClock ?? normalizeClock(current?.confirmedVectorClock)),
      lastSeenAt: new Date(),
      lastSyncAt: new Date(),
    },
    update: {
      terminalId: terminalId ?? current?.terminalId ?? null,
      lastSequenceNum: Math.max(sequenceNum, current?.lastSequenceNum ?? 0),
      vectorClock: json(vectorClock),
      confirmedVectorClock: json(confirmedVectorClock ?? normalizeClock(current?.confirmedVectorClock)),
      lastSeenAt: new Date(),
      lastSyncAt: new Date(),
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

  await tx.shiftCashCount.upsert({
    where: { id: `${idPrefix}-${declaration.mode}` },
    create: {
      id: `${idPrefix}-${declaration.mode}`,
      shiftId,
      mode: declaration.mode,
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
      synced: true,
      lastVectorClock: json(event.vectorClock),
    },
    update: {
      terminalId: payload.terminalId,
      branchId: payload.branchId,
      userId: payload.cashierId,
      status: ShiftStatus.OPEN,
      openingFloat: payload.openingFloat,
      notes: payload.notes ?? null,
      synced: true,
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
      synced: true,
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

  for (const line of payload.lines) {
    await tx.product.update({
      where: { id: line.productId },
      data: {
        stockOnHand: { decrement: line.quantity },
        lastVectorClock: json(event.vectorClock),
      },
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
      synced: true,
      lastVectorClock: json(event.vectorClock),
      lines: {
        create: payload.lines.map((line) => ({
          id: line.uid,
          productId: line.productId,
          sku: line.sku,
          name: line.name,
          barcode: line.barcode ?? null,
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
}

async function applySaleVoidedEvent(
  tx: Tx,
  event: SyncEvent<{ saleId: string; reason?: string; managerId?: string }>,
): Promise<void> {
  const sale = await tx.sale.findUnique({
    where: { id: event.payload.saleId },
    include: { lines: true },
  });

  if (!sale || sale.status === SaleStatus.VOIDED) {
    return;
  }

  for (const line of sale.lines) {
    await tx.product.update({
      where: { id: line.productId },
      data: {
        stockOnHand: { increment: line.quantity },
        lastVectorClock: json(event.vectorClock),
      },
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

  const totalRefund = payload.lines.reduce((sum, line) => sum + line.refundAmount, 0);

  for (const line of payload.lines) {
    await tx.product.update({
      where: { id: line.productId },
      data: {
        stockOnHand: { increment: line.quantity },
        lastVectorClock: json(event.vectorClock),
      },
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
        create: payload.lines.map((line) => ({
          id: uuidv4(),
          saleLineId: line.saleLineId,
          productId: line.productId,
          quantity: line.quantity,
          refundAmount: line.refundAmount,
        })),
      },
    },
  });

  if (sale) {
    await tx.sale.update({
      where: { id: sale.id },
      data: {
        status: SaleStatus.REFUNDED,
        lastVectorClock: json(event.vectorClock),
      },
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
      state: applyEvent ? SyncEventState.CONFIRMED : SyncEventState.PENDING,
      appliedAt: applyEvent ? new Date() : null,
    },
  });

  if (applyEvent) {
    await applyProjectionEvent(tx, event);
  }

  await updateDeviceState(tx, event.deviceId, stored.terminalId, event.sequenceNum, event.vectorClock);

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
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
      },
      update: {
        terminalId: input.terminalId,
        confirmedVectorClock: json(input.vectorClock),
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
      },
    });

    return getServerVectorClock(tx);
  });
}

export async function buildZReport(shiftId: string): Promise<ZReportSummary> {
  return prisma.$transaction(async (tx) => {
    const shift = await tx.pOSShift.findUnique({
      where: { id: shiftId },
      include: { cashCounts: true, sales: { include: { payments: true, returns: true } } },
    });

    if (!shift) {
      throw new Error('Shift not found');
    }

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
    };
  });
}
