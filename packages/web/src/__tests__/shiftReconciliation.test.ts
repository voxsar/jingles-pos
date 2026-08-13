import { describe, expect, it } from 'vitest';
import {
  CashCountMode,
  Customer,
  PaymentMethod,
  POSShiftReconciliationSettings,
  TENDER_TOTAL_KEY,
  ZReportSummary,
} from '@jingles/shared';
import {
  buildCashDeclaration,
  resolveDefaultCustomerId,
  summarizeShiftReconciliation,
} from '../utils/pos';

const settings: POSShiftReconciliationSettings = {
  tenderDeclarationMode: 'category',
  alertThresholdAmount: 500,
  alertThresholdPercent: 2,
  requireConfirmationOnAlert: true,
};

function buildReport(overrides: Partial<ZReportSummary> = {}): ZReportSummary {
  return {
    shiftId: 'shift-1',
    grossSales: 20_000,
    discounts: 0,
    refunds: 0,
    netSales: 20_000,
    transactionCount: 10,
    paymentBreakdown: {
      [PaymentMethod.CASH]: 12_000,
      [PaymentMethod.VISA]: 5_000,
      [PaymentMethod.MASTER]: 3_000,
    },
    expectedDrawer: 12_000,
    openingFloat: 0,
    cashPaidIn: 0,
    cashPaidOut: 0,
    paymentCounts: {},
    discountedLineCount: 0,
    productCount: 10,
    cashMovements: [],
    ...overrides,
  };
}

describe('resolveDefaultCustomerId', () => {
  const walkIn: Customer = { id: 'cust-walk-in', code: 'C0001', name: 'Walk-in', tier: 'Retail' };
  const wholesale: Customer = { id: 'cust-c0411', code: 'C0411', name: 'Amila Fashions', tier: 'Wholesale' };

  it('picks the walk-in account rather than whichever customer sorts first', () => {
    // Customers arrive sorted by name, so the wholesale account leads the list.
    expect(resolveDefaultCustomerId([wholesale, walkIn])).toBe('cust-walk-in');
  });

  it('falls back to matching on name when the walk-in row came from an upstream import', () => {
    const imported: Customer = { id: 'inv-9931', code: 'C0001', name: 'Walk In', tier: 'Retail' };

    expect(resolveDefaultCustomerId([wholesale, imported])).toBe('inv-9931');
  });

  it('falls back to the first customer only when there is no walk-in account', () => {
    expect(resolveDefaultCustomerId([wholesale])).toBe('cust-c0411');
    expect(resolveDefaultCustomerId([])).toBe('');
  });
});

describe('buildCashDeclaration', () => {
  it('totals the counted denominations', () => {
    const declaration = buildCashDeclaration(CashCountMode.CLOSING, { '5000': 2, '100': 3, '5': 4 });

    expect(declaration.total).toBe(10_320);
    expect(declaration.tenders).toBeUndefined();
    expect(declaration.tenderMode).toBeUndefined();
  });

  it('omits declared tender entirely when tender declaration is off', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 1 },
      { tenders: { VISA: 250 }, tenderMode: 'off' },
    );

    expect(declaration.tenders).toBeUndefined();
  });

  it('rounds declared tender to currency precision', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 1 },
      { tenders: { VISA: 250.005, MASTER: 99.999 }, tenderMode: 'category' },
    );

    expect(declaration.tenders).toEqual({ VISA: 250.01, MASTER: 100 });
    expect(declaration.tenderMode).toBe('category');
  });
});

describe('summarizeShiftReconciliation', () => {
  it('reports no alert when the declaration matches the transaction log', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 12 },
      { tenders: { VISA: 5_000, MASTER: 3_000 }, tenderMode: 'category' },
    );

    const result = summarizeShiftReconciliation(buildReport(), declaration, settings);

    expect(result.cash.variance).toBe(0);
    expect(result.hasAlert).toBe(false);
    expect(result.overall.declared).toBe(20_000);
    expect(result.overall.expected).toBe(20_000);
  });

  it('flags a cash count that is short by more than the amount threshold', () => {
    const declaration = buildCashDeclaration(CashCountMode.CLOSING, { '1000': 11 });

    const result = summarizeShiftReconciliation(buildReport(), declaration, {
      ...settings,
      tenderDeclarationMode: 'off',
    });

    expect(result.cash.variance).toBe(-1_000);
    expect(result.cash.flagged).toBe(true);
    expect(result.flaggedRows.map((row) => row.key)).toEqual([PaymentMethod.CASH]);
  });

  it('leaves a small variance under both thresholds unflagged', () => {
    // 100 short: under the 500 amount threshold and under 2% of 12,000.
    const declaration = buildCashDeclaration(CashCountMode.CLOSING, { '1000': 11, '100': 9 });

    const result = summarizeShiftReconciliation(buildReport(), declaration, {
      ...settings,
      tenderDeclarationMode: 'off',
    });

    expect(result.cash.variance).toBe(-100);
    expect(result.hasAlert).toBe(false);
  });

  it('flags on the percentage threshold even when the amount threshold is not reached', () => {
    // 400 short against an expected 1,000 drawer is 40%, but below the 500 amount rule.
    const declaration = buildCashDeclaration(CashCountMode.CLOSING, { '500': 1, '100': 1 });

    const result = summarizeShiftReconciliation(
      buildReport({ expectedDrawer: 1_000, paymentBreakdown: { [PaymentMethod.CASH]: 1_000 } }),
      declaration,
      { ...settings, tenderDeclarationMode: 'off' },
    );

    expect(result.cash.variance).toBe(-400);
    expect(result.cash.flagged).toBe(true);
  });

  it('flags the individual card type that does not settle', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 12 },
      { tenders: { VISA: 5_000, MASTER: 1_850 }, tenderMode: 'category' },
    );

    const result = summarizeShiftReconciliation(buildReport(), declaration, settings);

    expect(result.hasAlert).toBe(true);
    expect(result.flaggedRows.map((row) => row.key)).toEqual([PaymentMethod.MASTER]);
    expect(result.flaggedRows[0].variance).toBe(-1_150);
  });

  it('reconciles a single lump non-cash figure in total mode', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 12 },
      { tenders: { [TENDER_TOTAL_KEY]: 7_000 }, tenderMode: 'total' },
    );

    const result = summarizeShiftReconciliation(buildReport(), declaration, {
      ...settings,
      tenderDeclarationMode: 'total',
    });

    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].expected).toBe(8_000);
    expect(result.tenders[0].variance).toBe(-1_000);
    expect(result.hasAlert).toBe(true);
  });

  it('hides tender rows that were neither expected nor declared', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 12 },
      { tenders: { VISA: 5_000, MASTER: 3_000 }, tenderMode: 'category' },
    );

    const result = summarizeShiftReconciliation(buildReport(), declaration, settings);

    expect(result.tenders.map((row) => row.key)).toEqual([PaymentMethod.VISA, PaymentMethod.MASTER]);
  });

  it('flags money declared against a tender the log expected nothing for', () => {
    const declaration = buildCashDeclaration(
      CashCountMode.CLOSING,
      { '1000': 12 },
      { tenders: { VISA: 5_000, MASTER: 3_000, AMEX: 900 }, tenderMode: 'category' },
    );

    const result = summarizeShiftReconciliation(buildReport(), declaration, settings);

    // A percentage of zero is meaningless, so the amount threshold has to catch this.
    expect(result.flaggedRows.map((row) => row.key)).toEqual([PaymentMethod.AMEX]);
  });

  it('treats a zeroed threshold as switching that check off', () => {
    const declaration = buildCashDeclaration(CashCountMode.CLOSING, { '1000': 11 });

    const result = summarizeShiftReconciliation(buildReport(), declaration, {
      ...settings,
      tenderDeclarationMode: 'off',
      alertThresholdAmount: 0,
      alertThresholdPercent: 0,
    });

    expect(result.cash.variance).toBe(-1_000);
    expect(result.hasAlert).toBe(false);
  });
});
