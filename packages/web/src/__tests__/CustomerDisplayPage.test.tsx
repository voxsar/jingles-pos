import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POS_CUSTOMER_DISPLAY, PaymentMethod } from '@jingles/shared';
import CustomerDisplayPage from '../pages/CustomerDisplayPage';
import { publishCustomerDisplayState } from '../customerDisplay';
import { buildCartDisplayState, type CustomerDisplayContext } from '../utils/customerDisplay';
import { calcCartTotals } from '../utils/pos';

const context: CustomerDisplayContext = {
  settings: { ...DEFAULT_POS_CUSTOMER_DISPLAY, enabled: true, welcomeMessage: 'Ayubowan' },
  themeMode: 'light',
  branchName: 'Colombo',
  terminalCode: 'TERM-01',
  cashierName: 'Nimal',
  customerName: 'Walk-in',
};

const cart = [{
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
}];

describe('CustomerDisplayPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the configured welcome message when no sale has been published', () => {
    publishCustomerDisplayState(buildCartDisplayState(context, [], calcCartTotals([])));
    render(<CustomerDisplayPage />);

    expect(screen.getByText('Ayubowan')).toBeTruthy();
    expect(screen.getByText('Colombo')).toBeTruthy();
    expect(screen.getByText(/Served by Nimal/)).toBeTruthy();
  });

  it('renders the bill a window opened mid-sale is handed', () => {
    publishCustomerDisplayState(buildCartDisplayState(context, cart, calcCartTotals(cart), {
      payments: [{ method: PaymentMethod.CASH, amount: 600 }],
      tendered: 600,
      balanceDue: 400,
      changeDue: 0,
    }));

    render(<CustomerDisplayPage />);

    expect(screen.getByText('Rice 5kg')).toBeTruthy();
    expect(screen.getByText('Sub total')).toBeTruthy();
    expect(screen.getByText('Cash')).toBeTruthy();
    expect(screen.getByText('Balance due')).toBeTruthy();
    expect(screen.queryByText('Ayubowan')).toBeNull();
  });
});
