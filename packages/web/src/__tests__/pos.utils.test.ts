import { describe, expect, it } from 'vitest';
import { CartLine, PaymentMethod, Product, UserRole } from '@jingles/shared';
import {
  calcCartTotals,
  createCartLine,
  formatCurrency,
  generateReceiptNumber,
  pickPriceTier,
  recalculateCartLine,
  saleIncludesCash,
} from '../utils/pos';

describe('saleIncludesCash', () => {
  it('recognises cash-only and mixed cash payments', () => {
    expect(saleIncludesCash({ payments: [{ method: PaymentMethod.CASH, amount: 100 }] })).toBe(true);
    expect(saleIncludesCash({ payments: [
      { method: PaymentMethod.VISA, amount: 50 },
      { method: PaymentMethod.CASH, amount: 50 },
    ] })).toBe(true);
  });

  it('keeps non-cash sales visible', () => {
    expect(saleIncludesCash({ payments: [{ method: PaymentMethod.MASTER, amount: 100 }] })).toBe(false);
  });
});

describe('pickPriceTier', () => {
  const priceTiers = [
    { id: 'tier-retail', label: 'Retail', price: 100, priority: 2 },
    { id: 'tier-wholesale', label: 'Wholesale', price: 80, priority: 3 },
    { id: 'tier-default', label: 'Promo', price: 90, priority: 1, isDefault: true },
  ];

  it('prefers an explicit label match', () => {
    expect(pickPriceTier(priceTiers, ['Wholesale']).label).toBe('Wholesale');
  });

  it('falls back to the default tier', () => {
    expect(pickPriceTier(priceTiers, ['Missing']).label).toBe('Promo');
  });

  it('selects the highest eligible quantity breakpoint', () => {
    const tiers = [
      { id: 'retail-1', label: 'Retail', price: 100, priority: 1, minQty: 0, isDefault: true },
      { id: 'retail-10', label: 'Retail', price: 85, priority: 1, minQty: 10 },
    ];
    expect(pickPriceTier(tiers, ['Retail'], 9).price).toBe(100);
    expect(pickPriceTier(tiers, ['Retail'], 10).price).toBe(85);
  });
});

describe('createCartLine', () => {
  it('builds a new cart line from product and salesperson data', () => {
    const product: Product = {
      id: 'prod-1',
      sku: 'SKU-1',
      name: 'Widget',
      categoryId: 'cat-1',
      subcategory: 'Tools',
      packSize: 1,
      unitLabel: 'pcs',
      stockOnHand: 10,
      priceTiers: [
        { id: 'tier-retail', label: 'Retail', price: 100, priority: 1, isDefault: true },
      ],
    };

    const line = createCartLine(product, {
      id: 'user-1',
      code: 'E1',
      name: 'Cashier',
      initials: 'CA',
      role: UserRole.CASHIER,
    });

    expect(line.productId).toBe('prod-1');
    expect(line.lineTotal).toBe(100);
    expect(line.salespersonInitials).toBe('CA');
  });

  it('uses current variant pricing when a variant is selected', () => {
    const product: Product = {
      id: 'prod-1', sku: 'SKU-1', name: 'Widget', categoryId: 'cat-1', subcategory: 'Tools',
      packSize: 1, unitLabel: 'pcs', stockOnHand: 10,
      priceTiers: [{ id: 'base', label: 'Retail', price: 100, priority: 1, isDefault: true }],
      variants: [{ id: 'variant-1', productId: 'prod-1', variantCode: 'SKU-1-BLUE', stockOnHand: 2, attributes: [],
        priceTiers: [{ id: 'variant-price', label: 'Retail', price: 125, priority: 1, isDefault: true }] }],
    };
    const line = createCartLine(product, { id: 'u1', code: 'U1', name: 'Cashier', initials: 'CA', role: UserRole.CASHIER }, [], product.variants![0]);
    expect(line.unitPrice).toBe(125);
  });
});

describe('calcCartTotals', () => {
  const lines: CartLine[] = [
    recalculateCartLine({
      uid: 'l1',
      productId: 'p1',
      sku: 'S1',
      name: 'Widget',
      categoryId: 'cat-1',
      subcategory: 'Tools',
      packSize: 1,
      quantity: 2,
      unitPrice: 10,
      tierLabel: 'Retail',
      priceTiers: [],
      salespersonId: 'u1',
      salespersonName: 'Cashier',
      salespersonInitials: 'CA',
      discountPercent: 10,
      discountAmount: 0,
      costBasis: 6,
      stockOnHand: 5,
      lineTotal: 20,
    }),
    recalculateCartLine({
      uid: 'l2',
      productId: 'p2',
      sku: 'S2',
      name: 'Gadget',
      categoryId: 'cat-1',
      subcategory: 'Tools',
      packSize: 1,
      quantity: 3,
      unitPrice: 5,
      tierLabel: 'Retail',
      priceTiers: [],
      salespersonId: 'u1',
      salespersonName: 'Cashier',
      salespersonInitials: 'CA',
      discountPercent: 0,
      discountAmount: 0,
      costBasis: 2,
      stockOnHand: 5,
      lineTotal: 15,
    }),
  ];

  it('calculates subtotal and bill discount', () => {
    const totals = calcCartTotals(lines, 3);
    expect(totals.subtotal).toBe(33);
    expect(totals.billDiscount).toBe(3);
  });

  it('calculates total discount correctly', () => {
    const totals = calcCartTotals(lines, 3);
    expect(totals.discountTotal).toBe(5);
  });

  it('calculates total after line and bill discounts', () => {
    const totals = calcCartTotals(lines, 3);
    expect(totals.total).toBe(30);
  });

  it('handles empty carts', () => {
    const totals = calcCartTotals([]);
    expect(totals.subtotal).toBe(0);
    expect(totals.total).toBe(0);
  });
});

describe('formatCurrency', () => {
  it('formats values with the rupee prefix', () => {
    expect(formatCurrency(10)).toBe('Rs 10.00');
    expect(formatCurrency(10.5)).toBe('Rs 10.50');
    expect(formatCurrency(0)).toBe('Rs 0.00');
  });
});

describe('generateReceiptNumber', () => {
  it('includes the terminal code fragment', () => {
    expect(generateReceiptNumber('TERM-03')).toMatch(/^\d{6}-(TERM|RM03)-\d{4}$/);
  });
});
