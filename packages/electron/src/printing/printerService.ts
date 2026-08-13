/**
 * Resolves a configured printer, encodes a document for its command language and
 * hands the bytes to the transport layer.
 */
import type {
  POSLabelDocument,
  POSPrintDocument,
  POSPrintResult,
  POSPrinterConfig,
  POSPrinterRole,
} from '@jingles/shared';
import { readDesktopSettings } from '../desktopSettings';
import { encodeDrawerKick, encodeReceipt } from './escpos';
import { encodeLabel, encodeZplTestLabel } from './zpl';
import { probePrinter, sendToPrinter } from './transport';

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function listConfiguredPrinters(): POSPrinterConfig[] {
  return readDesktopSettings().printers;
}

/**
 * Picks the printer a job should go to: an explicit id when the caller names
 * one, otherwise the default for the role, otherwise the first enabled printer
 * that can speak for that role.
 */
export function resolvePrinter(role: POSPrinterRole, printerId?: string): POSPrinterConfig | null {
  const printers = listConfiguredPrinters().filter((printer) => printer.enabled);

  if (printerId) {
    return printers.find((printer) => printer.id === printerId) ?? null;
  }

  const forRole = printers.filter((printer) => printer.role === role);
  return forRole.find((printer) => printer.isDefault) ?? forRole[0] ?? null;
}

function encodeFor(printer: POSPrinterConfig, document: POSPrintDocument | POSLabelDocument): Buffer {
  if (printer.language === 'zpl') {
    if ('blocks' in document) {
      throw new Error(
        `"${printer.name}" is a ZPL label printer and cannot print receipts. `
        + 'Configure an ESC/POS receipt printer for this job.',
      );
    }

    return encodeLabel(document, printer);
  }

  if (!('blocks' in document)) {
    throw new Error(
      `"${printer.name}" is an ESC/POS receipt printer. `
      + 'Configure a ZPL label printer to print product labels.',
    );
  }

  return encodeReceipt(document, printer);
}

async function print(
  printer: POSPrinterConfig,
  document: POSPrintDocument | POSLabelDocument,
): Promise<POSPrintResult> {
  const payload = encodeFor(printer, document);

  // ZPL carries its own copy count in ^PQ, so repeating the job would multiply it.
  const copies = printer.language === 'zpl'
    ? 1
    : Math.min(5, Math.max(1, Math.round(('copies' in document && document.copies) || printer.copies || 1)));

  let bytesSent = 0;
  for (let attempt = 0; attempt < copies; attempt += 1) {
    bytesSent += await sendToPrinter(payload, printer, document.title);
  }

  return {
    ok: true,
    printerId: printer.id,
    printerName: printer.name,
    bytesSent,
  };
}

export async function printDocument(
  document: POSPrintDocument,
  options: { printerId?: string; role?: POSPrinterRole } = {},
): Promise<POSPrintResult> {
  const role = options.role ?? 'receipt';
  const printer = resolvePrinter(role, options.printerId);

  if (!printer) {
    return {
      ok: false,
      message: `No enabled ${role} printer is configured. Add one under Settings > Printers.`,
    };
  }

  try {
    return await print(printer, document);
  } catch (error) {
    return {
      ok: false,
      printerId: printer.id,
      printerName: printer.name,
      message: describeError(error),
    };
  }
}

export async function printLabel(
  document: POSLabelDocument,
  options: { printerId?: string } = {},
): Promise<POSPrintResult> {
  const printer = resolvePrinter('label', options.printerId);

  if (!printer) {
    return {
      ok: false,
      message: 'No enabled label printer is configured. Add one under Settings > Printers.',
    };
  }

  try {
    return await print(printer, document);
  } catch (error) {
    return {
      ok: false,
      printerId: printer.id,
      printerName: printer.name,
      message: describeError(error),
    };
  }
}

function buildEscPosTestDocument(printer: POSPrinterConfig): POSPrintDocument {
  return {
    title: 'Printer test',
    blocks: [
      { type: 'text', value: 'JINGLES POS', align: 'center', bold: true, wide: true },
      { type: 'text', value: 'Printer test page', align: 'center' },
      { type: 'divider' },
      { type: 'columns', left: 'Printer', right: printer.name },
      { type: 'columns', left: 'Transport', right: printer.transport },
      { type: 'columns', left: 'Target', right: printer.transport === 'network' ? `${printer.address}:${printer.port}` : printer.address },
      { type: 'columns', left: 'Columns', right: String(printer.columns) },
      { type: 'columns', left: 'Printed', right: new Date().toLocaleString() },
      { type: 'divider' },
      { type: 'text', value: 'The quick brown fox jumps over the lazy dog 0123456789', align: 'left' },
      { type: 'feed', lines: 1 },
      { type: 'barcode', value: 'JINGLES123', symbology: 'CODE128', height: 60 },
      { type: 'text', value: 'If this reads cleanly, the printer is ready.', align: 'center' },
    ],
    openDrawer: false,
    cut: printer.cutPaper,
    copies: 1,
  };
}

/** Confirms reachability, then puts a single test page on the paper. */
export async function testPrinter(printer: POSPrinterConfig): Promise<POSPrintResult> {
  try {
    await probePrinter(printer);
  } catch (error) {
    return {
      ok: false,
      printerId: printer.id,
      printerName: printer.name,
      message: `Could not reach the printer: ${describeError(error)}`,
    };
  }

  try {
    const payload = printer.language === 'zpl'
      ? encodeZplTestLabel(printer)
      : encodeReceipt(buildEscPosTestDocument(printer), printer);

    const bytesSent = await sendToPrinter(payload, printer, 'Jingles POS printer test');
    return { ok: true, printerId: printer.id, printerName: printer.name, bytesSent };
  } catch (error) {
    return {
      ok: false,
      printerId: printer.id,
      printerName: printer.name,
      message: describeError(error),
    };
  }
}

/** Pulses the cash drawer without printing anything. */
export async function openCashDrawer(printerId?: string): Promise<POSPrintResult> {
  const printer = resolvePrinter('receipt', printerId);

  if (!printer) {
    return { ok: false, message: 'No enabled receipt printer is configured.' };
  }

  if (printer.language !== 'escpos') {
    return { ok: false, printerId: printer.id, printerName: printer.name, message: 'Only ESC/POS printers can pulse a cash drawer.' };
  }

  try {
    const bytesSent = await sendToPrinter(encodeDrawerKick(), printer, 'Jingles POS drawer');
    return { ok: true, printerId: printer.id, printerName: printer.name, bytesSent };
  } catch (error) {
    return {
      ok: false,
      printerId: printer.id,
      printerName: printer.name,
      message: describeError(error),
    };
  }
}
