import { describe, expect, it } from 'vitest';
import { SaleStatus, type SaleSummary } from '@jingles/shared';
import { buildRefundReceiptDocument } from '../printing';

describe('buildRefundReceiptDocument', () => {
  it('prints a clearly labelled refund receipt with returned items and the original receipt', () => {
    const sale: SaleSummary = {
      id: 'sale-1',
      receiptNumber: '260814-TE01-0042',
      terminalId: 'terminal-1',
      branchId: 'branch-1',
      cashierId: 'cashier-1',
      cashierName: 'Original Cashier',
      customerName: 'Jane Customer',
      status: SaleStatus.COMPLETED,
      subtotal: 250,
      discountTotal: 0,
      taxTotal: 0,
      total: 250,
      marginTotal: 50,
      createdAt: '2026-08-14T09:00:00.000Z',
      updatedAt: '2026-08-14T09:00:00.000Z',
      lines: [{
        id: 'line-1',
        saleId: 'sale-1',
        productId: 'product-1',
        sku: 'SKU-001',
        name: 'Blue Shirt',
        subcategory: 'Shirts',
        quantity: 2,
        unitPrice: 125,
        tierLabel: 'Retail',
        discountPercent: 0,
        discountAmount: 0,
        salespersonId: 'staff-1',
        salespersonName: 'Sales Person',
        salespersonInitials: 'SP',
        costBasis: 100,
        marginAmount: 50,
        lineTotal: 250,
      }],
      payments: [],
    };

    const receipt = buildRefundReceiptDocument({
      id: 'return-1',
      sale,
      cashierName: 'Refund Cashier',
      reason: 'Damaged item',
      createdAt: '2026-08-14T10:00:00.000Z',
      lines: [{
        saleLineId: 'line-1',
        productId: 'product-1',
        quantity: 1,
        refundAmount: 125,
      }],
    }, 'TERM-01');

    expect(receipt.title).toBe('Refund 260814-TE01-0042');
    expect(receipt.openDrawer).toBe(false);
    expect(receipt.cut).toBe(true);
    expect(receipt.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', value: 'REFUND RECEIPT' }),
      expect.objectContaining({ type: 'text', value: 'REFUNDED' }),
      expect.objectContaining({ type: 'columns', left: 'Original receipt', right: '260814-TE01-0042' }),
      expect.objectContaining({ type: 'columns', left: 'Reason', right: 'Damaged item' }),
      expect.objectContaining({ type: 'text', value: 'Blue Shirt' }),
      expect.objectContaining({ type: 'columns', left: 'Refunded qty 1', right: '-Rs 125.00' }),
      expect.objectContaining({ type: 'columns', left: 'TOTAL REFUNDED', right: 'Rs 125.00' }),
    ]));
  });
});
