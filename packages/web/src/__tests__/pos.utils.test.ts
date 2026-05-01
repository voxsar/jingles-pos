import { describe, it, expect } from 'vitest';
import { resolvePrice, calcCartTotals, formatCurrency, generateReceiptNumber } from '../utils/pos';
import { CartLine } from '@jingles/shared';

describe('resolvePrice', () => {
  const batchPrices = [
    { id: '1', productId: 'p1', minQty: 5, price: 8.0 },
    { id: '2', productId: 'p1', minQty: 10, price: 6.0 },
  ];

  it('returns base price when no batch prices', () => {
    expect(resolvePrice(10.0, 3, [])).toBe(10.0);
  });

  it('returns batch price when qty meets threshold', () => {
    expect(resolvePrice(10.0, 5, batchPrices)).toBe(8.0);
    expect(resolvePrice(10.0, 10, batchPrices)).toBe(6.0);
  });

  it('returns base price when qty is below all thresholds', () => {
    expect(resolvePrice(10.0, 3, batchPrices)).toBe(10.0);
  });

  it('picks highest qualifying tier', () => {
    expect(resolvePrice(10.0, 12, batchPrices)).toBe(6.0);
  });
});

describe('calcCartTotals', () => {
  const lines: CartLine[] = [
    { productId: 'p1', sku: 'S1', name: 'Widget', unitPrice: 10, quantity: 2, discountAmount: 2, lineTotal: 18 },
    { productId: 'p2', sku: 'S2', name: 'Gadget', unitPrice: 5, quantity: 3, discountAmount: 0, lineTotal: 15 },
  ];

  it('calculates subtotal correctly', () => {
    const totals = calcCartTotals(lines);
    expect(totals.subtotal).toBe(35); // 10*2 + 5*3
  });

  it('calculates discount total correctly', () => {
    const totals = calcCartTotals(lines);
    expect(totals.discountTotal).toBe(2);
  });

  it('calculates total as subtotal minus discount', () => {
    const totals = calcCartTotals(lines);
    expect(totals.total).toBe(33); // 35 - 2
  });

  it('handles empty cart', () => {
    const totals = calcCartTotals([]);
    expect(totals.subtotal).toBe(0);
    expect(totals.total).toBe(0);
  });
});

describe('formatCurrency', () => {
  it('formats to 2 decimal places with dollar sign', () => {
    expect(formatCurrency(10)).toBe('$10.00');
    expect(formatCurrency(10.5)).toBe('$10.50');
    expect(formatCurrency(0)).toBe('$0.00');
  });
});

describe('generateReceiptNumber', () => {
  it('starts with RCP-', () => {
    expect(generateReceiptNumber()).toMatch(/^RCP-\d{8}-\d{4}$/);
  });
});
