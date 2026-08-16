import { describe, expect, it } from 'vitest';
import { CartLine, PaymentMethod, Product, UserRole } from '@jingles/shared';
import {
  appendScanToPendingBarcodeModifier,
  calcCartTotals,
  buildProductScanCodeIndex,
  createCartLine,
  formatCurrency,
  findSaleByReceiptScan,
  formatShiftReference,
  generateReceiptNumber,
  parseModifiedProductCode,
  parseModifiedProductCodeCandidates,
  parsePricePrefixedCode,
  parseQuantityPrefixedCode,
  resolveModifiedProductScan,
  pickPriceTier,
  recalculateCartLine,
  saleIncludesCash,
} from '../utils/pos';

describe('appendScanToPendingBarcodeModifier', () => {
  it('appends a scan to a pending quantity multiplier', () => {
    expect(appendScanToPendingBarcodeModifier('5*', '1234567890123')).toBe('5*1234567890123');
    expect(appendScanToPendingBarcodeModifier('12 @ ', 'SKU-1')).toBe('12 @SKU-1');
  });

  it('appends a scan to a pending enabled price override', () => {
    expect(appendScanToPendingBarcodeModifier('150-', '1234567890123')).toBe('150-1234567890123');
    expect(appendScanToPendingBarcodeModifier('99.50 # ', 'GENERAL', '#')).toBe('99.50 #GENERAL');
  });

  it('appends a scan after combined decimal modifiers in either direction', () => {
    expect(appendScanToPendingBarcodeModifier('2.5*150-', '285')).toBe('2.5*150-285');
    expect(appendScanToPendingBarcodeModifier('3-500*', '285')).toBe('3-500*285');
  });

  it('does not append arbitrary input or a disabled price modifier', () => {
    expect(appendScanToPendingBarcodeModifier('partial', '1234567890123')).toBe('1234567890123');
    expect(appendScanToPendingBarcodeModifier('150-', '1234567890123', null)).toBe('1234567890123');
    expect(appendScanToPendingBarcodeModifier('0*', '1234567890123')).toBe('1234567890123');
  });
});

describe('buildProductScanCodeIndex', () => {
  it('matches every saved barcode and preserves exact variant scans', () => {
    const product = {
      id: 'prod-1', sku: 'SKU-1', barcode: '111', barcodes: ['111', '222', '333'], name: 'Widget',
      categoryId: 'cat-1', subcategory: 'Tools', packSize: 1, unitLabel: 'pcs', stockOnHand: 10,
      priceTiers: [],
      variants: [{
        id: 'variant-1', productId: 'prod-1', variantCode: 'SKU-1', barcodes: ['333'],
        stockOnHand: 2, attributes: [],
      }],
    } satisfies Product;

    const index = buildProductScanCodeIndex([product]);

    expect(index.get('222')?.product.id).toBe('prod-1');
    expect(index.get('333')?.variant?.id).toBe('variant-1');
    expect(index.get('sku-1')?.variant?.id).toBe('variant-1');
  });
});

describe('parseQuantityPrefixedCode', () => {
  it('splits a leading quantity off "*" and "@" shorthand', () => {
    expect(parseQuantityPrefixedCode('25*3RL')).toEqual({ quantity: 25, code: '3RL' });
    expect(parseQuantityPrefixedCode('5@1234567890123')).toEqual({ quantity: 5, code: '1234567890123' });
  });

  it('tolerates stray spacing around the separator', () => {
    expect(parseQuantityPrefixedCode(' 12 * SKU-1 ')).toEqual({ quantity: 12, code: 'SKU-1' });
  });

  it('supports decimal quantities', () => {
    expect(parseQuantityPrefixedCode('2.5*285')).toEqual({ quantity: 2.5, code: '285' });
  });

  it('returns null for a plain code, so ordinary scans and searches pass through', () => {
    expect(parseQuantityPrefixedCode('3RL')).toBeNull();
    expect(parseQuantityPrefixedCode('1234567890123')).toBeNull();
    expect(parseQuantityPrefixedCode('7-Up')).toBeNull();
  });

  it('rejects a zero quantity or an empty code', () => {
    expect(parseQuantityPrefixedCode('0*SKU-1')).toBeNull();
    expect(parseQuantityPrefixedCode('25*')).toBeNull();
  });
});

describe('parseModifiedProductCode', () => {
  it('detects quantity and price in either order without losing the product code', () => {
    expect(parseModifiedProductCode('2.5*150-285')).toEqual({ code: '285', quantity: 2.5, price: 150, order: ['quantity', 'price'] });
    expect(parseModifiedProductCode('3-500*285')).toEqual({ code: '285', quantity: 500, price: 3, order: ['price', 'quantity'] });
  });

  it('uses the actual catalog to preserve hyphenated codes without losing combined modifiers', () => {
    const index = new Map([
      ['5', 'short-code'],
      ['285', 'ordinary-code'],
      ['1002361-5', 'hyphenated-code'],
    ]);

    expect(resolveModifiedProductScan('2.5*1002361-5', index)?.match).toBe('hyphenated-code');
    expect(parseModifiedProductCodeCandidates('2.5*1002361-5')).toHaveLength(2);
    expect(resolveModifiedProductScan('3-500*285', index)).toMatchObject({
      match: 'ordinary-code',
      modified: { price: 3, quantity: 500, code: '285' },
    });
  });
});

describe('parsePricePrefixedCode', () => {
  it('splits a leading price off the default "-" separator', () => {
    expect(parsePricePrefixedCode('150-GENERAL')).toEqual({ price: 150, code: 'GENERAL' });
    expect(parsePricePrefixedCode('99.50-1234567890123')).toEqual({ price: 99.5, code: '1234567890123' });
  });

  it('tolerates stray spacing around the separator', () => {
    expect(parsePricePrefixedCode(' 150 - GENERAL ')).toEqual({ price: 150, code: 'GENERAL' });
  });

  it('honours a reconfigured separator', () => {
    expect(parsePricePrefixedCode('150#GENERAL', '#')).toEqual({ price: 150, code: 'GENERAL' });
    expect(parsePricePrefixedCode('150-GENERAL', '#')).toBeNull();
  });

  it('only splits at the first separator, so a code with its own dash stays whole', () => {
    expect(parsePricePrefixedCode('150-3-RL')).toEqual({ price: 150, code: '3-RL' });
  });

  it('returns null for a plain code with no separator', () => {
    expect(parsePricePrefixedCode('3RL')).toBeNull();
    expect(parsePricePrefixedCode('1234567890123')).toBeNull();
  });

  // "7-Up" itself parses as price 7 for code "Up" - the parser has no way to
  // know that's a real SKU. Safety against that comes from the caller trying
  // an exact scan-code match first and only falling back to this parse when
  // that fails (see `handleBarcodeScan`), not from this function.
  it('parses a numeric-prefixed real-looking SKU the same as any other shorthand', () => {
    expect(parsePricePrefixedCode('7-Up')).toEqual({ price: 7, code: 'Up' });
  });

  it('rejects a zero price, an empty code, or a reserved separator', () => {
    expect(parsePricePrefixedCode('0-GENERAL')).toBeNull();
    expect(parsePricePrefixedCode('150-')).toBeNull();
    expect(parsePricePrefixedCode('150*GENERAL', '*')).toBeNull();
    expect(parsePricePrefixedCode('150@GENERAL', '@')).toBeNull();
  });
});

describe('findSaleByReceiptScan', () => {
  const sales = [
    { id: 'sale-1', receiptNumber: '260815-TE01-0042' },
    { id: 'SALE-UUID-2', receiptNumber: '260815-TE01-0043' },
  ] as never;

  it('matches the exact printed receipt QR value regardless of case or surrounding whitespace', () => {
    expect(findSaleByReceiptScan(sales, ' 260815-te01-0042 ')?.id).toBe('sale-1');
    expect(findSaleByReceiptScan(sales, 'sale-uuid-2')?.receiptNumber).toBe('260815-TE01-0043');
    expect(findSaleByReceiptScan(sales, '0042')).toBeNull();
  });
});

describe('formatShiftReference', () => {
  it('shows the terminal and opening date instead of an internal UUID', () => {
    const openedAt = new Date(2026, 7, 3, 21, 7).toISOString();

    expect(formatShiftReference({ openedAt, terminalId: 'terminal-uuid' }, 'TERM-01'))
      .toBe('TERM-01 · 03 Aug 2026, 21:07');
  });
});

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

  it('uses the explicitly selected price tier for a new cart line', () => {
    const product: Product = {
      id: 'prod-tier', sku: 'SKU-TIER', name: 'Tiered widget', categoryId: 'cat-1', subcategory: 'Tools',
      packSize: 1, unitLabel: 'pcs', stockOnHand: 10,
      priceTiers: [
        { id: 'retail', label: 'Retail', price: 100, priority: 1, isDefault: true },
        { id: 'wholesale', label: 'Wholesale', price: 80, priority: 2 },
      ],
    };
    const line = createCartLine(
      product,
      { id: 'u1', code: 'U1', name: 'Cashier', initials: 'CA', role: UserRole.CASHIER },
      ['Wholesale', 'Retail'],
    );

    expect(line.tierLabel).toBe('Wholesale');
    expect(line.unitPrice).toBe(80);
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
