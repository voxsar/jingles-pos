import {
  createIdleCustomerDisplayState,
  type CartLine,
  type PaymentInput,
  type POSCustomerDisplayLine,
  type POSCustomerDisplayPayment,
  type POSCustomerDisplaySettings,
  type POSCustomerDisplayState,
  type POSThemeMode,
  type SaleSummary,
} from '@jingles/shared';
import { getLineVariantSummary, PAYMENT_METHOD_LABELS, roundCurrency } from './pos';
import type { CartTotals } from './pos';

/** Everything about the till that does not change from one keystroke to the next. */
export interface CustomerDisplayContext {
  settings: POSCustomerDisplaySettings;
  themeMode: POSThemeMode;
  branchName: string;
  terminalCode: string;
  cashierName: string;
  customerName: string;
  /** When the current bill was started; falls back to now. */
  saleStartedAt?: string;
}

/** Live tender state while the payment window is open. */
export interface CustomerDisplayPaymentProgress {
  payments: PaymentInput[];
  /** Amount the cashier has keyed but not yet added to the payment list. */
  tendered: number;
  balanceDue: number;
  changeDue: number;
}

function toDisplayLine(line: CartLine): POSCustomerDisplayLine {
  const variant = getLineVariantSummary(line);

  return {
    uid: line.uid,
    name: line.name,
    variant: variant ?? undefined,
    quantity: line.quantity,
    unitPrice: roundCurrency(line.unitPrice),
    discountAmount: roundCurrency(line.discountAmount),
    lineTotal: roundCurrency(line.lineTotal),
  };
}

function toDisplayPayment(payment: PaymentInput): POSCustomerDisplayPayment {
  return {
    method: payment.method,
    label: PAYMENT_METHOD_LABELS[payment.method] ?? payment.method,
    amount: roundCurrency(payment.amount),
    tenderedAmount: payment.tenderedAmount == null ? undefined : roundCurrency(payment.tenderedAmount),
  };
}

function baseState(context: CustomerDisplayContext): POSCustomerDisplayState {
  return createIdleCustomerDisplayState(context.settings, {
    // A blank store name in settings means "use whatever branch this till is on".
    storeName: context.settings.storeName || context.branchName,
    branchName: context.branchName,
    terminalCode: context.terminalCode,
    cashierName: context.cashierName,
    themeMode: context.themeMode,
  });
}

/** The between-sales screen: welcome message only, no bill on show. */
export function buildIdleDisplayState(context: CustomerDisplayContext): POSCustomerDisplayState {
  return baseState(context);
}

/**
 * The live bill. `payment` is supplied only while the payment window is open,
 * which is also what moves the display into its payment layout.
 */
export function buildCartDisplayState(
  context: CustomerDisplayContext,
  cart: CartLine[],
  totals: CartTotals,
  payment?: CustomerDisplayPaymentProgress | null,
): POSCustomerDisplayState {
  if (cart.length === 0 && payment == null) {
    return buildIdleDisplayState(context);
  }

  const state = baseState(context);
  const payments = (payment?.payments ?? []).map(toDisplayPayment);
  const amountPaid = roundCurrency(payments.reduce((sum, entry) => sum + entry.amount, 0));

  return {
    ...state,
    mode: payment ? 'payment' : 'sale',
    saleDate: context.saleStartedAt ?? state.saleDate,
    customerName: context.customerName,
    lines: cart.map(toDisplayLine),
    itemCount: totals.itemCount,
    subtotal: roundCurrency(totals.rawSubtotal),
    discountTotal: roundCurrency(totals.discountTotal),
    taxTotal: roundCurrency(totals.taxTotal),
    total: roundCurrency(totals.total),
    payments,
    amountPaid,
    balanceDue: payment ? Math.max(0, roundCurrency(payment.balanceDue)) : roundCurrency(totals.total),
    changeDue: payment ? Math.max(0, roundCurrency(payment.changeDue)) : 0,
  };
}

/**
 * The closed sale, as the customer should read it back: what they bought, what
 * they paid with, and the change owed to them.
 */
export function buildCompletedSaleDisplayState(
  context: CustomerDisplayContext,
  sale: SaleSummary,
): POSCustomerDisplayState {
  const state = baseState(context);
  const payments = sale.payments.map(toDisplayPayment);
  const amountPaid = roundCurrency(sale.payments.reduce(
    (sum, payment) => sum + (payment.tenderedAmount ?? payment.amount),
    0,
  ));
  const changeDue = roundCurrency(sale.payments.reduce((sum, payment) => sum + (payment.changeDue ?? 0), 0));
  const settled = roundCurrency(payments.reduce((sum, payment) => sum + payment.amount, 0));

  return {
    ...state,
    mode: 'complete',
    saleDate: sale.createdAt,
    customerName: sale.customerName ?? context.customerName,
    cashierName: sale.cashierName || context.cashierName,
    receiptNumber: sale.receiptNumber,
    lines: sale.lines.map((line) => ({
      uid: line.id,
      name: line.name,
      variant: getLineVariantSummary(line) ?? undefined,
      quantity: line.quantity,
      unitPrice: roundCurrency(line.unitPrice),
      discountAmount: roundCurrency(line.discountAmount),
      lineTotal: roundCurrency(line.lineTotal),
    })),
    itemCount: sale.lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: roundCurrency(sale.subtotal),
    discountTotal: roundCurrency(sale.discountTotal),
    taxTotal: roundCurrency(sale.taxTotal),
    total: roundCurrency(sale.total),
    payments,
    amountPaid,
    // A short payment leaves a balance the customer still owes; it is theirs to
    // see rather than something the display quietly rounds away.
    balanceDue: Math.max(0, roundCurrency(sale.total - settled)),
    changeDue: Math.max(0, changeDue),
  };
}
