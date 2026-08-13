import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POS_CUSTOMER_DISPLAY,
  PaymentMethod,
  SaleStatus,
  createIdleCustomerDisplayState,
  normalizeCustomerDisplaySettings,
  parseCustomerDisplayState,
  type CartLine,
  type SaleSummary,
} from '@jingles/shared';
import {
  buildCartDisplayState,
  buildCompletedSaleDisplayState,
  buildIdleDisplayState,
  type CustomerDisplayContext,
} from '../utils/customerDisplay';
import { calcCartTotals } from '../utils/pos';
import {
  persistCustomerDisplaySettings,
  publishCustomerDisplayState,
  readStoredCustomerDisplaySettings,
  subscribeCustomerDisplayState,
} from '../customerDisplay';

const context: CustomerDisplayContext = {
  settings: {
    ...DEFAULT_POS_CUSTOMER_DISPLAY,
    enabled: true,
    welcomeMessage: 'Welcome to Jingles',
    storeName: '',
  },
  themeMode: 'dark',
  branchName: 'Colombo',
  terminalCode: 'TERM-01',
  cashierName: 'Nimal',
  customerName: 'Walk-in',
};

function cartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    uid: 'line-1',
    productId: 'product-1',
    sku: 'SKU-1',
    name: 'Rice 5kg',
    categoryId: 'category-1',
    subcategory: 'Staples',
    packSize: 1,
    quantity: 2,
    unitPrice: 500,
    tierLabel: 'Retail',
    priceTiers: [],
    salespersonId: 'user-1',
    salespersonName: 'Nimal',
    salespersonInitials: 'NI',
    discountPercent: 0,
    discountAmount: 0,
    costBasis: 350,
    stockOnHand: 20,
    lineTotal: 1000,
    ...overrides,
  };
}

describe('normalizeCustomerDisplaySettings', () => {
  it('falls back to the defaults for missing or blank wording', () => {
    const settings = normalizeCustomerDisplaySettings({ welcomeMessage: '   ' });

    expect(settings.welcomeMessage).toBe(DEFAULT_POS_CUSTOMER_DISPLAY.welcomeMessage);
    expect(settings.thankYouMessage).toBe(DEFAULT_POS_CUSTOMER_DISPLAY.thankYouMessage);
    expect(settings.enabled).toBe(false);
  });

  it('keeps a deliberately emptied subtitle', () => {
    expect(normalizeCustomerDisplaySettings({ welcomeSubtitle: '' }).welcomeSubtitle).toBe('');
  });

  it('clamps a nonsensical dwell time', () => {
    expect(normalizeCustomerDisplaySettings({ completedSaleTimeoutSeconds: -5 }).completedSaleTimeoutSeconds)
      .toBe(DEFAULT_POS_CUSTOMER_DISPLAY.completedSaleTimeoutSeconds);
    expect(normalizeCustomerDisplaySettings({ completedSaleTimeoutSeconds: 99_999 }).completedSaleTimeoutSeconds)
      .toBe(600);
  });
});

describe('parseCustomerDisplayState', () => {
  it('rejects a payload that is not a snapshot', () => {
    expect(parseCustomerDisplayState(null)).toBeNull();
    expect(parseCustomerDisplayState({ mode: 'not-a-mode' })).toBeNull();
  });

  it('drops lines with no name and coerces broken numbers', () => {
    const parsed = parseCustomerDisplayState({
      ...createIdleCustomerDisplayState(DEFAULT_POS_CUSTOMER_DISPLAY),
      mode: 'sale',
      total: 'not-a-number',
      lines: [{ uid: 'a', name: '', quantity: 1 }, { uid: 'b', name: 'Tea', quantity: 1, lineTotal: 250.005 }],
    });

    expect(parsed?.total).toBe(0);
    expect(parsed?.lines).toHaveLength(1);
    expect(parsed?.lines[0]?.lineTotal).toBe(250.01);
  });
});

describe('buildCartDisplayState', () => {
  it('shows the welcome screen while the cart is empty', () => {
    const state = buildCartDisplayState(context, [], calcCartTotals([]));

    expect(state.mode).toBe('idle');
    expect(state.welcomeMessage).toBe('Welcome to Jingles');
    expect(state.themeMode).toBe('dark');
  });

  it('falls back to the branch name when no store name is configured', () => {
    expect(buildIdleDisplayState(context).storeName).toBe('Colombo');
  });

  it('mirrors the bill while items are rung up', () => {
    const cart = [cartLine(), cartLine({ uid: 'line-2', name: 'Tea 400g', quantity: 1, unitPrice: 250, lineTotal: 250 })];
    const state = buildCartDisplayState(context, cart, calcCartTotals(cart));

    expect(state.mode).toBe('sale');
    expect(state.lines.map((line) => line.name)).toEqual(['Rice 5kg', 'Tea 400g']);
    expect(state.itemCount).toBe(3);
    expect(state.total).toBe(1250);
    expect(state.balanceDue).toBe(1250);
    expect(state.changeDue).toBe(0);
  });

  it('switches to the payment layout and reports the outstanding balance', () => {
    const cart = [cartLine()];
    const state = buildCartDisplayState(context, cart, calcCartTotals(cart), {
      payments: [{ method: PaymentMethod.VISA, amount: 400 }],
      tendered: 0,
      balanceDue: 600,
      changeDue: 0,
    });

    expect(state.mode).toBe('payment');
    expect(state.payments).toEqual([{ method: 'VISA', label: 'Visa', amount: 400, tenderedAmount: undefined }]);
    expect(state.amountPaid).toBe(400);
    expect(state.balanceDue).toBe(600);
  });
});

describe('buildCompletedSaleDisplayState', () => {
  const sale: SaleSummary = {
    id: 'sale-1',
    receiptNumber: '260814-TE01-0042',
    terminalId: 'terminal-1',
    branchId: 'branch-1',
    cashierId: 'user-1',
    cashierName: 'Nimal',
    customerName: 'Walk-in',
    status: SaleStatus.COMPLETED,
    subtotal: 1000,
    discountTotal: 0,
    taxTotal: 0,
    total: 1000,
    marginTotal: 300,
    createdAt: '2026-08-14T04:30:00.000Z',
    updatedAt: '2026-08-14T04:30:00.000Z',
    lines: [{
      id: 'sale-line-1',
      saleId: 'sale-1',
      productId: 'product-1',
      sku: 'SKU-1',
      name: 'Rice 5kg',
      subcategory: 'Staples',
      quantity: 2,
      unitPrice: 500,
      tierLabel: 'Retail',
      discountPercent: 0,
      discountAmount: 0,
      salespersonId: 'user-1',
      salespersonName: 'Nimal',
      salespersonInitials: 'NI',
      costBasis: 350,
      marginAmount: 300,
      lineTotal: 1000,
    }],
    payments: [{ method: PaymentMethod.CASH, amount: 1000, tenderedAmount: 2000, changeDue: 1000 }],
  };

  it('reads back the receipt, what was paid and the change owed', () => {
    const state = buildCompletedSaleDisplayState(context, sale);

    expect(state.mode).toBe('complete');
    expect(state.receiptNumber).toBe('260814-TE01-0042');
    expect(state.saleDate).toBe('2026-08-14T04:30:00.000Z');
    expect(state.payments).toEqual([
      { method: 'CASH', label: 'Cash', amount: 1000, tenderedAmount: 2000 },
    ]);
    expect(state.amountPaid).toBe(2000);
    expect(state.changeDue).toBe(1000);
    expect(state.balanceDue).toBe(0);
  });

  it('leaves a short payment visible as a balance still owed', () => {
    const state = buildCompletedSaleDisplayState(context, {
      ...sale,
      payments: [{ method: PaymentMethod.CASH, amount: 600, tenderedAmount: 600, changeDue: 0 }],
    });

    expect(state.balanceDue).toBe(400);
    expect(state.changeDue).toBe(0);
  });
});

describe('browser transport', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a snapshot through storage for a display window opened mid-sale', () => {
    const cart = [cartLine()];
    publishCustomerDisplayState(buildCartDisplayState(context, cart, calcCartTotals(cart)));

    const received: string[] = [];
    const unsubscribe = subscribeCustomerDisplayState((state) => received.push(`${state.mode}:${state.total}`));
    unsubscribe();

    expect(received).toEqual(['sale:1000']);
  });

  it('keeps the display wording for the next browser session', () => {
    persistCustomerDisplaySettings({ ...DEFAULT_POS_CUSTOMER_DISPLAY, welcomeMessage: 'Ayubowan' });

    expect(readStoredCustomerDisplaySettings().welcomeMessage).toBe('Ayubowan');
  });

  it('ignores a corrupt stored snapshot instead of rendering it', () => {
    window.localStorage.setItem('jingles-pos-customer-display-state', '{not json');

    const received: unknown[] = [];
    subscribeCustomerDisplayState((state) => received.push(state))();

    expect(received).toEqual([]);
  });
});
