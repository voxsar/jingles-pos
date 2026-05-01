import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../prisma';
import { resolveUnitPrice } from '../pricing';
import {
  InventoryState,
  InventoryEventType,
  SaleStatus,
  ShiftStatus,
} from '@jingles/shared';

const router = Router();

// ── Product search for POS ─────────────────────────────────────────────────

router.get('/products/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query as { q: string };
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

    const products = await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: q } },
          { sku: { contains: q } },
          { barcode: q },
        ],
      },
      include: {
        batchPrices: true,
        inventory: { where: { state: InventoryState.ShelfReady } },
      },
      take: 20,
    });

    return res.json(products);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/products/barcode/:barcode', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { barcode: req.params.barcode },
      include: {
        batchPrices: true,
        inventory: { where: { state: InventoryState.ShelfReady } },
      },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    return res.json(product);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sales ──────────────────────────────────────────────────────────────────

router.post('/sales', async (req: Request, res: Response) => {
  try {
    const {
      receiptNumber,
      terminalId,
      branchId,
      userId,
      customerId,
      shiftId,
      lines,
      payment,
      subtotal,
      discountTotal,
      taxTotal,
      total,
      offlineId,
    } = req.body;

    if (!lines || lines.length === 0) {
      return res.status(400).json({ error: 'Sale must have at least one line' });
    }

    // Check if offline sale already synced
    if (offlineId) {
      const existing = await prisma.sale.findUnique({ where: { offlineId } });
      if (existing) return res.json(existing);
    }

    const sale = await prisma.$transaction(async (tx) => {
      // For each line, validate and deduct inventory
      for (const line of lines) {
        const availableStock = await tx.inventory.findMany({
          where: {
            productId: line.productId,
            state: InventoryState.ShelfReady,
          },
          take: line.quantity,
        });

        if (availableStock.length < line.quantity) {
          throw new Error(
            `Insufficient stock for product ${line.productId}. ` +
            `Available: ${availableStock.length}, Required: ${line.quantity}`
          );
        }

        // Deduct inventory (mark as Sold)
        const stockIds = availableStock.map((s) => s.id);
        await tx.inventory.updateMany({
          where: { id: { in: stockIds } },
          data: { state: InventoryState.Sold },
        });

        // Record inventory event
        await tx.inventoryEvent.create({
          data: {
            id: uuidv4(),
            productId: line.productId,
            eventType: InventoryEventType.SALE_DEDUCTED,
            quantity: line.quantity,
            reference: receiptNumber,
            notes: `Sale: ${receiptNumber}`,
          },
        });
      }

      // Create the sale record
      const createdSale = await tx.sale.create({
        data: {
          receiptNumber,
          terminalId,
          branchId,
          userId,
          customerId,
          shiftId,
          status: SaleStatus.COMPLETED,
          subtotal,
          discountTotal: discountTotal ?? 0,
          taxTotal: taxTotal ?? 0,
          total,
          offlineId,
          synced: true,
          lines: {
            create: lines.map((l: any) => ({
              productId: l.productId,
              sku: l.sku,
              name: l.name,
              barcode: l.barcode,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              discountAmount: l.discountAmount ?? 0,
              lineTotal: l.lineTotal,
            })),
          },
          payments: {
            create: [
              {
                method: payment.method,
                amount: payment.amount,
                cashReceived: payment.cashReceived,
                changeDue: payment.changeDue,
                reference: payment.reference,
              },
            ],
          },
        },
        include: { lines: true, payments: true },
      });

      return createdSale;
    });

    return res.status(201).json(sale);
  } catch (error: any) {
    console.error(error);
    if (error.message?.includes('Insufficient stock')) {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sales', async (_req: Request, res: Response) => {
  try {
    const sales = await prisma.sale.findMany({
      include: { lines: true, payments: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(sales);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sales/:id', async (req: Request, res: Response) => {
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: req.params.id },
      include: { lines: true, payments: true, returns: { include: { lines: true } } },
    });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    return res.json(sale);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/sales/:id/void', async (req: Request, res: Response) => {
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: req.params.id },
      include: { lines: true },
    });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (sale.status !== SaleStatus.COMPLETED) {
      return res.status(400).json({ error: 'Only completed sales can be voided' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Restore inventory
      for (const line of sale.lines) {
        // Create new ShelfReady inventory records
        for (let i = 0; i < line.quantity; i++) {
          await tx.inventory.create({
            data: {
              id: uuidv4(),
              productId: line.productId,
              state: InventoryState.ShelfReady,
            },
          });
        }

        await tx.inventoryEvent.create({
          data: {
            id: uuidv4(),
            productId: line.productId,
            eventType: InventoryEventType.RETURNED,
            quantity: line.quantity,
            reference: sale.receiptNumber,
            notes: `Void: ${sale.receiptNumber}`,
          },
        });
      }

      return tx.sale.update({
        where: { id: sale.id },
        data: { status: SaleStatus.VOIDED },
      });
    });

    return res.json(updated);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Returns ────────────────────────────────────────────────────────────────

router.post('/returns', async (req: Request, res: Response) => {
  try {
    const { saleId, lines, reason, userId, terminalId } = req.body;

    if (!lines || lines.length === 0) {
      return res.status(400).json({ error: 'Return must have at least one line' });
    }

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { lines: true },
    });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const totalRefund = lines.reduce(
      (sum: number, l: any) => sum + l.refundAmount,
      0
    );

    const returnRecord = await prisma.$transaction(async (tx) => {
      const ret = await tx.return.create({
        data: {
          saleId,
          userId,
          terminalId,
          reason,
          totalRefund,
          lines: {
            create: lines.map((l: any) => ({
              saleLineId: l.saleLineId,
              productId: l.productId,
              quantity: l.quantity,
              refundAmount: l.refundAmount,
            })),
          },
        },
        include: { lines: true },
      });

      // Restore inventory
      for (const line of lines) {
        for (let i = 0; i < line.quantity; i++) {
          await tx.inventory.create({
            data: {
              id: uuidv4(),
              productId: line.productId,
              state: InventoryState.Returned,
            },
          });
        }

        await tx.inventoryEvent.create({
          data: {
            id: uuidv4(),
            productId: line.productId,
            eventType: InventoryEventType.RETURNED,
            quantity: line.quantity,
            reference: saleId,
            notes: `Return for sale: ${saleId}`,
          },
        });
      }

      // Update sale status
      const allReturnedQty = await tx.returnLine.findMany({
        where: {
          return: { saleId },
        },
      });

      const totalSaleQty = sale.lines.reduce((s, l) => s + l.quantity, 0);
      const totalReturnedQty = allReturnedQty.reduce((s, l) => s + l.quantity, 0);

      const newStatus =
        totalReturnedQty >= totalSaleQty
          ? SaleStatus.RETURNED
          : SaleStatus.PARTIALLY_RETURNED;

      await tx.sale.update({
        where: { id: saleId },
        data: { status: newStatus },
      });

      return ret;
    });

    return res.status(201).json(returnRecord);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Shifts ─────────────────────────────────────────────────────────────────

router.post('/shifts/open', async (req: Request, res: Response) => {
  try {
    const { terminalId, branchId, userId, openingFloat } = req.body;

    // Check no active shift for this terminal
    const existing = await prisma.pOSShift.findFirst({
      where: { terminalId, status: ShiftStatus.OPEN },
    });
    if (existing) {
      return res.status(409).json({ error: 'A shift is already open for this terminal', shift: existing });
    }

    const shift = await prisma.pOSShift.create({
      data: {
        terminalId,
        branchId,
        userId,
        openingFloat: openingFloat ?? 0,
        status: ShiftStatus.OPEN,
      },
    });
    return res.status(201).json(shift);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/shifts/:id/close', async (req: Request, res: Response) => {
  try {
    const { closingFloat, notes } = req.body;
    const shift = await prisma.pOSShift.findUnique({ where: { id: req.params.id } });
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (shift.status !== ShiftStatus.OPEN) {
      return res.status(400).json({ error: 'Shift is not open' });
    }

    const updated = await prisma.pOSShift.update({
      where: { id: req.params.id },
      data: {
        status: ShiftStatus.CLOSED,
        closingFloat,
        closedAt: new Date(),
        notes,
      },
    });
    return res.json(updated);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/shifts/active', async (req: Request, res: Response) => {
  try {
    const { terminalId } = req.query as { terminalId: string };
    const where = terminalId
      ? { terminalId, status: ShiftStatus.OPEN }
      : { status: ShiftStatus.OPEN };

    const shift = await prisma.pOSShift.findFirst({ where });
    return res.json(shift ?? null);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/shifts', async (_req: Request, res: Response) => {
  try {
    const shifts = await prisma.pOSShift.findMany({
      orderBy: { openedAt: 'desc' },
      include: { sales: { select: { id: true, total: true } } },
    });
    return res.json(shifts);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
