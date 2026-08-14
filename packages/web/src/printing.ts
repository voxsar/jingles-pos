/**
 * Renderer half of the printing stack.
 *
 * The receipt and Z-report layouts live here as device-independent block lists;
 * the Electron main process turns them into ESC/POS or ZPL bytes. Outside the
 * desktop app there is no bridge, so callers fall back to `window.print()`.
 */
import type {
  CartLine,
  POSLabelDocument,
  POSPrintBlock,
  POSPrintDocument,
  POSPrintResult,
  POSPrinterConfig,
  POSPrinterDiscoveryResult,
  Product,
  ReturnInput,
  SaleSummary,
  ShiftSummary,
  ZReportSummary,
} from '@jingles/shared';
import {
  formatCurrency,
  formatDateTime,
  formatInteger,
  formatShiftReference,
  getLineVariantSummary,
  type CartTotals,
} from './utils/pos';

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  VISA: 'Visa',
  MASTER: 'Master',
  AMEX: 'Amex',
  CREDIT: 'Credit',
  GIFT: 'Gift voucher',
  INSTALLMENT: 'Installment plan',
};

export interface ReceiptBranding {
  name: string;
  addressLines: string[];
  footerLines: string[];
}

export const DEFAULT_RECEIPT_BRANDING: ReceiptBranding = {
  name: 'JINGLES',
  addressLines: ['42 Main Street, Colombo'],
  footerLines: ['System by The Red Sun', 'Live Long and Prosper', 'theredsun.org'],
};

/** Distinct salespeople credited across a sale's lines, in first-seen order. */
function saleSalespeople(lines: Array<{ salespersonName?: string }>): string {
  const seen = new Set<string>();
  for (const line of lines) {
    const name = line.salespersonName?.trim();
    if (name) seen.add(name);
  }
  return seen.size ? [...seen].join(', ') : 'N/A';
}

function getPrintingBridge() {
  return typeof window !== 'undefined' ? window.electronAPI?.printing : undefined;
}

export function hasPrintingBridge() {
  return typeof getPrintingBridge() !== 'undefined';
}

export async function listPrinters(): Promise<POSPrinterConfig[]> {
  return getPrintingBridge()?.list() ?? [];
}

export async function discoverPrinters(options?: { includeNetwork?: boolean }): Promise<POSPrinterDiscoveryResult> {
  const bridge = getPrintingBridge();
  if (!bridge) {
    throw new Error('Printer discovery is only available in the Electron app.');
  }

  return bridge.discover(options);
}

export async function testPrinter(printer: POSPrinterConfig): Promise<POSPrintResult> {
  const bridge = getPrintingBridge();
  if (!bridge) {
    throw new Error('Printer testing is only available in the Electron app.');
  }

  return bridge.test(printer);
}

export async function openCashDrawer(printerId?: string): Promise<POSPrintResult> {
  const bridge = getPrintingBridge();
  if (!bridge) {
    return { ok: false, message: 'The cash drawer can only be opened from the Electron app.' };
  }

  return bridge.openCashDrawer(printerId);
}

/**
 * Sends a document to the configured receipt printer, falling back to the
 * browser print dialog when there is no bridge or no printer answers. The
 * fallback is what keeps a terminal usable while its printer is being set up.
 */
export async function printReceiptDocument(
  document: POSPrintDocument,
  options: { printerId?: string; allowBrowserFallback?: boolean } = {},
): Promise<POSPrintResult> {
  const bridge = getPrintingBridge();

  if (bridge) {
    const result = await bridge.printReceipt(document, { printerId: options.printerId });
    if (result.ok || options.allowBrowserFallback === false) {
      return result;
    }

    window.print();
    return { ...result, message: `${result.message ?? 'Printing failed.'} Opened the system print dialog instead.` };
  }

  if (options.allowBrowserFallback === false) {
    return { ok: false, message: 'Direct printing is only available in the Electron app.' };
  }

  window.print();
  return { ok: true, message: 'Opened the system print dialog.' };
}

export async function printLabelDocument(
  document: POSLabelDocument,
  options: { printerId?: string } = {},
): Promise<POSPrintResult> {
  const bridge = getPrintingBridge();
  if (!bridge) {
    return { ok: false, message: 'Label printing is only available in the Electron app.' };
  }

  return bridge.printLabel(document, options);
}

export function buildReceiptDocument(
  sale: SaleSummary,
  terminalCode: string,
  branding: ReceiptBranding = DEFAULT_RECEIPT_BRANDING,
): POSPrintDocument {
  const paidAmount = sale.payments.reduce((sum, payment) => sum + payment.amount, 0);
  const tenderedAmount = sale.payments.reduce(
    (sum, payment) => sum + (payment.tenderedAmount ?? payment.amount),
    0,
  );
  const changeDue = Math.max(0, sale.payments.reduce((sum, payment) => sum + (payment.changeDue ?? 0), 0));
  const balanceDue = Math.max(0, sale.total - paidAmount);
  const itemCount = sale.lines.reduce((sum, line) => sum + line.quantity, 0);

  const blocks: POSPrintBlock[] = [
    { type: 'text', value: branding.name, align: 'center', bold: true, wide: true },
    ...branding.addressLines.map((line): POSPrintBlock => ({ type: 'text', value: line, align: 'center' })),
    { type: 'divider' },
    // Cashier + terminal on the left half of each line, salesman(s) + receipt
    // number on the right half — same pairing a two-column paper till uses.
    { type: 'columns', left: `Cashier ${sale.cashierName}`, right: `Salesman ${saleSalespeople(sale.lines)}` },
    { type: 'columns', left: `Terminal ${terminalCode}`, right: `Receipt ${sale.receiptNumber}` },
    { type: 'columns', left: 'Date', right: formatDateTime(sale.createdAt) },
    { type: 'columns', left: 'Customer', right: sale.customerName ?? 'Walk-in customer' },
    { type: 'columns', left: 'Items', right: formatInteger(itemCount) },
    { type: 'divider' },
  ];

  for (const line of sale.lines) {
    blocks.push({ type: 'text', value: line.name });

    const variantSummary = getLineVariantSummary(line);
    if (variantSummary != null) {
      blocks.push({ type: 'text', value: `  ${variantSummary}` });
    }

    blocks.push({ type: 'text', value: `  SKU ${line.sku} - ${line.tierLabel}` });
    blocks.push({
      type: 'columns',
      left: `${formatInteger(line.quantity)} x ${formatCurrency(line.unitPrice)}`,
      right: formatCurrency(line.lineTotal),
      indent: 2,
    });

    if (line.discountAmount > 0) {
      blocks.push({
        type: 'columns',
        left: 'Discount',
        right: `-${formatCurrency(line.discountAmount)}`,
        indent: 2,
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    { type: 'columns', left: 'Subtotal', right: formatCurrency(sale.subtotal) },
    { type: 'columns', left: 'Discount', right: `-${formatCurrency(sale.discountTotal)}` },
    { type: 'columns', left: 'Tax', right: formatCurrency(sale.taxTotal) },
    { type: 'columns', left: 'TOTAL', right: formatCurrency(sale.total), bold: true },
    { type: 'divider' },
    { type: 'text', value: 'Payment(s)', bold: true },
  );

  for (const payment of sale.payments) {
    blocks.push({
      type: 'columns',
      left: PAYMENT_LABELS[payment.method] ?? payment.method,
      right: formatCurrency(payment.amount),
    });

    if (payment.reference) {
      blocks.push({ type: 'columns', left: 'Reference', right: payment.reference, indent: 2 });
    }

    if ((payment.tenderedAmount ?? payment.amount) !== payment.amount) {
      blocks.push({
        type: 'columns',
        left: 'Tendered',
        right: formatCurrency(payment.tenderedAmount ?? payment.amount),
        indent: 2,
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    { type: 'columns', left: 'Tendered', right: formatCurrency(tenderedAmount) },
    { type: 'columns', left: 'Paid', right: formatCurrency(paidAmount) },
    { type: 'columns', left: 'Balance due', right: formatCurrency(balanceDue) },
    { type: 'columns', left: 'Change', right: formatCurrency(changeDue), bold: true },
    { type: 'feed', lines: 1 },
    // A QR code packs the receipt number into a fraction of the vertical
    // space a CODE128 barcode wide enough to stay scannable would need.
    { type: 'qr', value: sale.receiptNumber, size: 6 },
    { type: 'text', value: sale.receiptNumber, align: 'center' },
    ...branding.footerLines.map((line): POSPrintBlock => ({ type: 'text', value: line, align: 'center' })),
  );

  return {
    title: `Receipt ${sale.receiptNumber}`,
    blocks,
    // Cash on the bill is the signal to pop the drawer.
    openDrawer: sale.payments.some((payment) => payment.method === 'CASH'),
    cut: true,
    copies: 1,
  };
}

export function buildRefundReceiptDocument(
  refund: {
    id: string;
    sale: SaleSummary;
    cashierName: string;
    reason?: string;
    lines: ReturnInput['lines'];
    createdAt?: string;
  },
  terminalCode: string,
  branding: ReceiptBranding = DEFAULT_RECEIPT_BRANDING,
): POSPrintDocument {
  const totalRefund = refund.lines.reduce((sum, line) => sum + line.refundAmount, 0);
  const itemCount = refund.lines.reduce((sum, line) => sum + line.quantity, 0);
  const saleLines = new Map(refund.sale.lines.map((line) => [line.id, line]));
  const createdAt = refund.createdAt ?? new Date().toISOString();

  const blocks: POSPrintBlock[] = [
    { type: 'text', value: branding.name, align: 'center', bold: true, wide: true },
    ...branding.addressLines.map((line): POSPrintBlock => ({ type: 'text', value: line, align: 'center' })),
    { type: 'text', value: 'REFUND RECEIPT', align: 'center', bold: true, wide: true },
    { type: 'text', value: 'REFUNDED', align: 'center', bold: true },
    { type: 'divider' },
    { type: 'columns', left: 'Original receipt', right: refund.sale.receiptNumber },
    { type: 'columns', left: 'Refund reference', right: refund.id },
    { type: 'columns', left: 'Date', right: formatDateTime(createdAt) },
    { type: 'columns', left: 'Terminal', right: terminalCode },
    { type: 'columns', left: 'Cashier', right: refund.cashierName },
    { type: 'columns', left: 'Customer', right: refund.sale.customerName ?? 'Walk-in customer' },
    { type: 'columns', left: 'Reason', right: refund.reason?.trim() || 'Customer return' },
    { type: 'columns', left: 'Items refunded', right: formatInteger(itemCount) },
    { type: 'divider' },
  ];

  for (const returnedLine of refund.lines) {
    const saleLine = saleLines.get(returnedLine.saleLineId);
    blocks.push({ type: 'text', value: saleLine?.name ?? `Product ${returnedLine.productId}` });

    if (saleLine != null) {
      const variantSummary = getLineVariantSummary(saleLine);
      if (variantSummary != null) {
        blocks.push({ type: 'text', value: `  ${variantSummary}` });
      }
      blocks.push({ type: 'text', value: `  SKU ${saleLine.sku}` });
    }

    blocks.push({
      type: 'columns',
      left: `Refunded qty ${formatInteger(returnedLine.quantity)}`,
      right: `-${formatCurrency(returnedLine.refundAmount)}`,
      indent: 2,
    });
  }

  blocks.push(
    { type: 'divider' },
    { type: 'columns', left: 'TOTAL REFUNDED', right: formatCurrency(totalRefund), bold: true },
    { type: 'feed', lines: 1 },
    { type: 'qr', value: refund.id, size: 6 },
    { type: 'text', value: refund.id, align: 'center' },
    { type: 'text', value: `Original receipt ${refund.sale.receiptNumber}`, align: 'center' },
    ...branding.footerLines.map((line): POSPrintBlock => ({ type: 'text', value: line, align: 'center' })),
  );

  return {
    title: `Refund ${refund.sale.receiptNumber}`,
    blocks,
    openDrawer: false,
    cut: true,
    copies: 1,
  };
}

/**
 * A price quotation for the cart as it currently stands.
 *
 * Deliberately not a receipt: nothing is persisted, no stock moves and no
 * payment is recorded, so the slip is labelled as a quotation and carries no
 * receipt barcode that could be mistaken for proof of purchase at the counter.
 */
export function buildQuotationDocument(
  input: {
    lines: CartLine[];
    totals: CartTotals;
    reference: string;
    cashierName: string;
    customerName?: string;
    validUntil?: string;
  },
  terminalCode: string,
  branding: ReceiptBranding = DEFAULT_RECEIPT_BRANDING,
): POSPrintDocument {
  const itemCount = input.lines.reduce((sum, line) => sum + line.quantity, 0);

  const blocks: POSPrintBlock[] = [
    { type: 'text', value: branding.name, align: 'center', bold: true, wide: true },
    ...branding.addressLines.map((line): POSPrintBlock => ({ type: 'text', value: line, align: 'center' })),
    { type: 'text', value: 'QUOTATION', align: 'center', bold: true },
    { type: 'text', value: 'This is not a receipt. No payment has been taken.', align: 'center' },
    { type: 'divider' },
    { type: 'columns', left: 'Quotation', right: input.reference },
    { type: 'columns', left: 'Date', right: formatDateTime(new Date().toISOString()) },
    { type: 'columns', left: 'Terminal', right: terminalCode },
    { type: 'columns', left: 'Prepared by', right: input.cashierName },
    { type: 'columns', left: 'Customer', right: input.customerName ?? 'Walk-in customer' },
    { type: 'columns', left: 'Items', right: formatInteger(itemCount) },
    { type: 'divider' },
  ];

  for (const line of input.lines) {
    blocks.push({ type: 'text', value: line.name });

    const variantSummary = getLineVariantSummary(line);
    if (variantSummary != null) {
      blocks.push({ type: 'text', value: `  ${variantSummary}` });
    }

    blocks.push({ type: 'text', value: `  SKU ${line.sku} - ${line.tierLabel}` });
    blocks.push({
      type: 'columns',
      left: `${formatInteger(line.quantity)} x ${formatCurrency(line.unitPrice)}`,
      right: formatCurrency(line.lineTotal),
      indent: 2,
    });

    if (line.discountAmount > 0) {
      blocks.push({
        type: 'columns',
        left: 'Discount',
        right: `-${formatCurrency(line.discountAmount)}`,
        indent: 2,
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    { type: 'columns', left: 'Subtotal', right: formatCurrency(input.totals.rawSubtotal) },
    { type: 'columns', left: 'Discount', right: `-${formatCurrency(input.totals.discountTotal)}` },
    { type: 'columns', left: 'QUOTED TOTAL', right: formatCurrency(input.totals.total), bold: true },
    { type: 'divider' },
  );

  if (input.validUntil) {
    blocks.push({ type: 'columns', left: 'Valid until', right: input.validUntil });
  }

  blocks.push(
    { type: 'text', value: 'Prices are subject to stock availability.', align: 'center' },
    { type: 'feed', lines: 1 },
  );

  return {
    title: `Quotation ${input.reference}`,
    blocks,
    openDrawer: false,
    cut: true,
    copies: 1,
  };
}

export function buildZReportDocument(
  report: ZReportSummary,
  shift: ShiftSummary,
  terminalCode: string,
  options: { cashSalesHidden?: boolean; branding?: ReceiptBranding } = {},
): POSPrintDocument {
  const branding = options.branding ?? DEFAULT_RECEIPT_BRANDING;
  const cashHidden = options.cashSalesHidden === true;
  const nonCashEntries = Object.entries(report.paymentBreakdown).filter(([method]) => method !== 'CASH');
  const nonCashTotal = nonCashEntries.reduce((sum, [, amount]) => sum + amount, 0);

  const blocks: POSPrintBlock[] = [
    { type: 'text', value: branding.name, align: 'center', bold: true, wide: true },
    { type: 'text', value: cashHidden ? 'X READING' : 'Z READING', align: 'center', bold: true },
    { type: 'text', value: terminalCode, align: 'center' },
    { type: 'text', value: formatShiftReference(shift, terminalCode), align: 'center' },
    { type: 'text', value: `Printed ${formatDateTime(new Date().toISOString())}`, align: 'center' },
    { type: 'divider' },
  ];

  if (cashHidden) {
    blocks.push({ type: 'columns', left: 'Visible non-cash sale', right: formatCurrency(nonCashTotal), bold: true });
  } else {
    blocks.push(
      { type: 'columns', left: 'Gross sale', right: formatCurrency(report.grossSales) },
      {
        type: 'columns',
        left: `Product discount (${formatInteger(report.discountedLineCount)})`,
        right: formatCurrency(report.discounts),
      },
      { type: 'columns', left: 'Refunds', right: formatCurrency(report.refunds) },
      { type: 'columns', left: 'Net sale', right: formatCurrency(report.netSales), bold: true },
      { type: 'divider' },
      {
        type: 'columns',
        left: `Cash sale (${formatInteger(report.paymentCounts.CASH ?? 0)})`,
        right: formatCurrency(report.paymentBreakdown.CASH ?? 0),
      },
      { type: 'columns', left: 'Opening float', right: formatCurrency(report.openingFloat) },
    );

    if (report.cashPaidIn > 0) {
      blocks.push({ type: 'columns', left: 'Cash in', right: formatCurrency(report.cashPaidIn) });
    }

    if (report.cashPaidOut > 0) {
      blocks.push({ type: 'columns', left: 'Cash out', right: `-${formatCurrency(report.cashPaidOut)}` });
    }

    blocks.push(
      { type: 'columns', left: 'Expected drawer', right: formatCurrency(report.expectedDrawer), bold: true },
    );

    if (report.countedDrawer != null) {
      blocks.push({ type: 'columns', left: 'Declared amount', right: formatCurrency(report.countedDrawer) });
    }

    if (report.variance != null) {
      blocks.push({ type: 'columns', left: 'Cash excess / (short)', right: formatCurrency(report.variance), bold: true });
    }
  }

  blocks.push({ type: 'divider' }, { type: 'text', value: 'Non cash sales', align: 'center', bold: true });

  for (const [method, amount] of nonCashEntries) {
    blocks.push({
      type: 'columns',
      left: `${PAYMENT_LABELS[method] ?? method} (${formatInteger(report.paymentCounts[method] ?? 0)})`,
      right: formatCurrency(amount),
    });
  }

  blocks.push({ type: 'columns', left: 'Non cash total', right: formatCurrency(nonCashTotal), bold: true });

  const creditSales = report.customerCreditSales ?? [];
  const collections = report.customerCollections ?? [];
  const sourcePayments = report.paymentDetails ?? [];
  if (creditSales.length > 0) {
    blocks.push({ type: 'divider' }, { type: 'text', value: 'Customer credit sales', align: 'center', bold: true });
    for (const sale of creditSales) {
      blocks.push(
        { type: 'columns', left: `${sale.customerName} / ${sale.receiptNumber}`, right: formatCurrency(sale.amount) },
      );
    }
  }
  if (collections.length > 0) {
    blocks.push({ type: 'divider' }, { type: 'text', value: 'Customer bill collections', align: 'center', bold: true });
    for (const payment of collections) {
      blocks.push({ type: 'columns', left: `${payment.customerName} / ${payment.method}`, right: formatCurrency(payment.amount) });
      if (payment.note) blocks.push({ type: 'text', value: payment.note });
    }
  }
  if (sourcePayments.length > 0) {
    blocks.push({ type: 'divider' }, { type: 'text', value: 'Cheque and bank transfers', align: 'center', bold: true });
    for (const payment of sourcePayments) {
      blocks.push(
        { type: 'columns', left: `${PAYMENT_LABELS[payment.method] ?? payment.method} / ${payment.receiptNumber}`, right: formatCurrency(payment.amount) },
        { type: 'text', value: [payment.bankName, payment.origin, payment.reference, payment.reason].filter(Boolean).join(' | ') },
      );
    }
  }

  if (!cashHidden) {
    blocks.push(
      { type: 'divider' },
      { type: 'columns', left: 'Bill count', right: formatInteger(report.transactionCount) },
      { type: 'columns', left: 'Product count', right: formatInteger(report.productCount) },
    );
  }

  return {
    title: `Z reading ${formatShiftReference(shift, terminalCode)}`,
    blocks,
    openDrawer: false,
    cut: true,
    copies: 1,
  };
}

/**
 * EAN-13 barcodes must be scanned as EAN-13 to read back correctly; anything
 * else is safest as CODE128, which encodes the full printable ASCII range.
 */
export function pickSymbology(value: string): POSLabelDocument['symbology'] {
  return /^\d{12,13}$/.test(value.trim()) ? 'EAN13' : 'CODE128';
}

export function buildProductLabelDocument(
  product: Product,
  options: { copies?: number; price?: number; variantCode?: string } = {},
): POSLabelDocument {
  const code = (options.variantCode ?? product.barcode ?? product.sku).trim();
  const price = options.price ?? product.priceTiers[0]?.price;

  return {
    title: `Label ${product.sku}`,
    sku: product.sku,
    name: product.name,
    price: price != null ? formatCurrency(price) : undefined,
    barcode: code,
    symbology: pickSymbology(code),
    secondaryText: options.variantCode ?? product.sku,
    copies: Math.min(999, Math.max(1, Math.round(options.copies ?? 1))),
  };
}
