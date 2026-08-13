/**
 * ZPL II encoder for Zebra label printers (ZD/ZT/GK/GX families, plus the many
 * TSC and Godex units that accept ZPL emulation).
 *
 * Labels are laid out in dots, so every millimetre in the printer config is
 * converted through the head resolution — 203dpi on most desktop units, 300dpi
 * on the higher-resolution ones.
 */
import type { POSBarcodeSymbology, POSLabelDocument, POSPrinterConfig } from '@jingles/shared';

const MM_PER_INCH = 25.4;

function mmToDots(millimetres: number, dpi: number) {
  return Math.max(1, Math.round((millimetres / MM_PER_INCH) * dpi));
}

function clampDpi(dpi: number) {
  // The four head resolutions Zebra actually ships.
  const supported = [152, 203, 300, 600];
  return supported.includes(dpi) ? dpi : 203;
}

/**
 * `^`, `~` and `\` start control sequences inside field data. Rather than
 * switching the whole label to hex escapes we drop them — they never carry
 * meaning in a product name or SKU.
 */
function escapeFieldData(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\^~\\]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
}

function isPrintableBarcode(value: string, symbology: POSBarcodeSymbology) {
  if (symbology === 'EAN13') {
    return /^\d{12,13}$/.test(value);
  }

  if (symbology === 'CODE39') {
    return /^[0-9A-Z\-. $/+%]+$/.test(value);
  }

  return /^[\x20-\x7e]+$/.test(value);
}

function barcodeCommand(symbology: POSBarcodeSymbology, heightDots: number, showText: boolean) {
  const hri = showText ? 'Y' : 'N';
  switch (symbology) {
    case 'EAN13':
      return `^BEN,${heightDots},${hri},N`;
    case 'CODE39':
      return `^B3N,N,${heightDots},${hri},N`;
    default:
      return `^BCN,${heightDots},${hri},N,N`;
  }
}

/** Modules (narrowest bar units) an encoded symbol occupies, quiet zones aside. */
function moduleCount(value: string, symbology: POSBarcodeSymbology) {
  if (symbology === 'EAN13') {
    return 113; // 95 symbol modules plus the mandatory quiet zones.
  }

  if (symbology === 'CODE39') {
    return (value.length + 2) * 16; // 13 modules per character plus inter-character gaps.
  }

  return value.length * 11 + 35; // CODE128 subset B, plus start, checksum and stop.
}

/**
 * Picks the widest module width that still fits the symbol inside the label, so
 * a short SKU prints boldly while a long one shrinks instead of overflowing.
 */
function moduleWidth(value: string, symbology: POSBarcodeSymbology, widthDots: number) {
  const fitted = Math.floor(widthDots / moduleCount(value, symbology));
  return Math.min(6, Math.max(1, fitted));
}

export function encodeLabel(document: POSLabelDocument, printer: POSPrinterConfig): Buffer {
  const dpi = clampDpi(printer.dpi);
  const labelWidth = mmToDots(printer.labelWidthMm, dpi);
  const labelHeight = mmToDots(printer.labelHeightMm, dpi);
  const margin = Math.round(dpi / 25); // ~1mm quiet zone on every edge
  const contentWidth = Math.max(1, labelWidth - margin * 2);
  const scale = dpi / 203; // The layout below is tuned at 203dpi and scales up.

  const name = escapeFieldData(document.name);
  const sku = escapeFieldData(document.sku);
  const price = escapeFieldData(document.price ?? '');
  const secondary = escapeFieldData(document.secondaryText ?? '');
  const barcode = escapeFieldData(document.barcode);
  const symbology = document.symbology ?? 'CODE128';
  const copies = Math.min(999, Math.max(1, Math.round(document.copies ?? printer.copies ?? 1)));

  const nameFont = Math.round(26 * scale);
  const metaFont = Math.round(20 * scale);
  const priceFont = Math.round(34 * scale);

  // Media type and sensor calibration stay with whatever the printer is already
  // configured for; overriding them here would break correctly set-up hardware.
  const lines: string[] = ['^XA', '^CI28', `^PW${labelWidth}`, `^LL${labelHeight}`, '^LH0,0'];

  if (printer.darkness !== 0) {
    lines.push(`^MD${Math.min(30, Math.max(-30, Math.round(printer.darkness)))}`);
  }

  let cursor = margin;

  if (name) {
    // Two wrapped, centred lines of product name.
    lines.push(`^FO${margin},${cursor}^A0N,${nameFont},${nameFont}^FB${contentWidth},2,0,C,0^FD${name}^FS`);
    cursor += nameFont * 2 + Math.round(4 * scale);
  }

  if (secondary) {
    lines.push(`^FO${margin},${cursor}^A0N,${metaFont},${metaFont}^FB${contentWidth},1,0,C,0^FD${secondary}^FS`);
    cursor += metaFont + Math.round(4 * scale);
  }

  // Give the barcode whatever vertical space is left once the price line is
  // reserved, but never let it collapse below a scannable height.
  const priceHeight = price ? priceFont + Math.round(6 * scale) : 0;
  const barcodeHeight = Math.max(
    Math.round(30 * scale),
    labelHeight - margin - cursor - priceHeight - Math.round(24 * scale),
  );

  if (barcode && isPrintableBarcode(barcode, symbology)) {
    // ^FB is a text-block command and is ignored (or misapplied) on barcode
    // fields, so the symbol is centred by computing its origin from its width.
    const barWidth = moduleWidth(barcode, symbology, contentWidth);
    const symbolWidth = moduleCount(barcode, symbology) * barWidth;
    const originX = margin + Math.max(0, Math.round((contentWidth - symbolWidth) / 2));

    lines.push(
      `^FO${originX},${cursor}`
      + `^BY${barWidth},3,${barcodeHeight}`
      + `${barcodeCommand(symbology, barcodeHeight, true)}`
      + `^FD${barcode}^FS`,
    );
    cursor += barcodeHeight + Math.round(24 * scale);
  } else if (sku) {
    // No usable barcode: fall back to a readable SKU so the label is still useful.
    lines.push(`^FO${margin},${cursor}^A0N,${metaFont},${metaFont}^FB${contentWidth},1,0,C,0^FD${sku}^FS`);
    cursor += metaFont + Math.round(4 * scale);
  }

  if (price) {
    lines.push(`^FO${margin},${cursor}^A0N,${priceFont},${priceFont}^FB${contentWidth},1,0,C,0^FD${price}^FS`);
  }

  lines.push(`^PQ${copies},0,0,N`, '^XZ');

  // ^CI28 above puts the printer in UTF-8 mode, so the payload must match.
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function encodeZplTestLabel(printer: POSPrinterConfig) {
  return encodeLabel(
    {
      title: 'Test label',
      sku: 'TEST-0001',
      name: 'Jingles POS test label',
      price: 'Rs 1,234.00',
      barcode: 'TEST0001',
      symbology: 'CODE128',
      secondaryText: printer.name,
      copies: 1,
    },
    printer,
  );
}

export const __testing = {
  escapeFieldData,
  mmToDots,
  moduleCount,
  moduleWidth,
};
