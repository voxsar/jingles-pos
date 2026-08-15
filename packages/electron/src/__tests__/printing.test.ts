import { DEFAULT_POS_PRINTER_CONFIG, type POSPrinterConfig } from '@jingles/shared';
import { encodeReceipt, encodeDrawerKick, __testing as escposTesting } from '../printing/escpos';
import { encodeLabel, __testing as zplTesting } from '../printing/zpl';
import { __testing as discoveryTesting } from '../printing/discovery';
import { __testing as transportTesting } from '../printing/transport';

const receiptPrinter: POSPrinterConfig = {
  ...DEFAULT_POS_PRINTER_CONFIG,
  id: 'receipt-1',
  name: 'Counter receipt',
  columns: 42,
};

const labelPrinter: POSPrinterConfig = {
  ...DEFAULT_POS_PRINTER_CONFIG,
  id: 'label-1',
  name: 'Shelf labels',
  role: 'label',
  language: 'zpl',
  labelWidthMm: 50,
  labelHeightMm: 25,
  dpi: 203,
};

describe('Windows printer port discovery', () => {
  it('parses serial and parallel device-map entries', () => {
    const serial = discoveryTesting.parseWindowsDeviceMap(`
HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM
    \\Device\\Serial0    REG_SZ    COM3
    \\Device\\VCP0       REG_SZ    COM12
`, 'serial');
    const parallel = discoveryTesting.parseWindowsDeviceMap(`
HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\PARALLEL PORTS
    \\Device\\Parallel0  REG_SZ    LPT1
`, 'parallel');

    expect(serial.map((port) => port.address)).toEqual(['COM3', 'COM12']);
    expect(parallel.map((port) => port.address)).toEqual(['LPT1']);
  });

  it('normalizes Windows COM and LPT names to device namespace paths', () => {
    expect(transportTesting.normalizeWindowsPortPath('COM3')).toBe('\\\\.\\COM3');
    expect(transportTesting.normalizeWindowsPortPath('\\\\.\\COM12')).toBe('\\\\.\\COM12');
    expect(transportTesting.normalizeWindowsPortPath('LPT1')).toBe('\\\\.\\LPT1');
    expect(transportTesting.normalizeWindowsPortPath('USB001')).toBeNull();
  });
});

describe('ESC/POS encoding', () => {
  it('opens with an initialize command and closes with a cut', () => {
    const bytes = encodeReceipt(
      { title: 'Receipt', blocks: [{ type: 'text', value: 'Hello' }] },
      receiptPrinter,
    );

    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.subarray(-4))).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });

  it('omits the cut when the printer has cutting disabled', () => {
    const bytes = encodeReceipt(
      { title: 'Receipt', blocks: [] },
      { ...receiptPrinter, cutPaper: false },
    );

    expect(bytes.includes(Buffer.from([0x1d, 0x56, 0x42]))).toBe(false);
  });

  it('emits the drawer pulse only when the document asks for it', () => {
    const kick = encodeDrawerKick();

    const withDrawer = encodeReceipt(
      { title: 'Receipt', blocks: [], openDrawer: true },
      receiptPrinter,
    );
    const withoutDrawer = encodeReceipt(
      { title: 'Receipt', blocks: [], openDrawer: false },
      receiptPrinter,
    );

    expect(withDrawer.includes(kick)).toBe(true);
    expect(withoutDrawer.includes(kick)).toBe(false);
  });

  it('right-aligns an amount against its label across the paper width', () => {
    const [line] = escposTesting.layoutColumns('Total', 'Rs 1,250.00', 42, 0);

    expect(line).toHaveLength(42);
    expect(line.startsWith('Total')).toBe(true);
    expect(line.endsWith('Rs 1,250.00')).toBe(true);
  });

  it('wraps a long label and drops the amount onto the closing line', () => {
    const lines = escposTesting.layoutColumns(
      'Extremely long product description that will not fit',
      'Rs 99.00',
      32,
      0,
    );

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[lines.length - 1].endsWith('Rs 99.00')).toBe(true);
    expect(lines.every((line) => line.length <= 32)).toBe(true);
  });

  it('folds typography the printer cannot render down to ASCII', () => {
    expect(escposTesting.foldToAscii('Café · 2 × “item”')).toBe('Cafe - 2 x "item"');
  });

  it('skips a barcode whose characters the symbology cannot encode', () => {
    const withBadEan = encodeReceipt(
      { title: 'Receipt', blocks: [{ type: 'barcode', value: 'NOT-A-NUMBER', symbology: 'EAN13' }] },
      receiptPrinter,
    );

    // GS k would introduce the barcode; the invalid payload is dropped instead.
    expect(withBadEan.includes(Buffer.from([0x1d, 0x6b]))).toBe(false);
  });
});

describe('ZPL encoding', () => {
  it('wraps the label in a format block sized from millimetres and dpi', () => {
    const zpl = encodeLabel(
      { title: 'Label', sku: 'SKU-1', name: 'Test product', barcode: 'ABC12345', price: 'Rs 10.00' },
      labelPrinter,
    ).toString('utf8');

    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl.trim().endsWith('^XZ')).toBe(true);
    // 50mm and 25mm at 203dpi.
    expect(zpl).toContain('^PW400');
    expect(zpl).toContain('^LL200');
  });

  it('carries the copy count in the print quantity command', () => {
    const zpl = encodeLabel(
      { title: 'Label', sku: 'SKU-1', name: 'Test', barcode: 'ABC12345', copies: 7 },
      labelPrinter,
    ).toString('utf8');

    expect(zpl).toContain('^PQ7,0,0,N');
  });

  it('selects the EAN-13 command for a 13-digit code and CODE128 otherwise', () => {
    const ean = encodeLabel(
      { title: 'Label', sku: 'S', name: 'N', barcode: '4006381333931', symbology: 'EAN13' },
      labelPrinter,
    ).toString('utf8');
    const code128 = encodeLabel(
      { title: 'Label', sku: 'S', name: 'N', barcode: 'MIXED-123', symbology: 'CODE128' },
      labelPrinter,
    ).toString('utf8');

    expect(ean).toContain('^BEN,');
    expect(code128).toContain('^BCN,');
  });

  it('strips characters that would be read as ZPL control sequences', () => {
    expect(zplTesting.escapeFieldData('Chair ^ Table ~ Desk \\ End')).toBe('Chair   Table   Desk   End');
  });

  it('falls back to the SKU when the barcode cannot be encoded', () => {
    const zpl = encodeLabel(
      { title: 'Label', sku: 'SKU-FALLBACK', name: 'N', barcode: 'not digits', symbology: 'EAN13' },
      labelPrinter,
    ).toString('utf8');

    expect(zpl).not.toContain('^BEN,');
    expect(zpl).toContain('SKU-FALLBACK');
  });

  it('narrows the module width so a long CODE128 payload still fits the label', () => {
    const narrow = zplTesting.moduleWidth('012345678901234567890123', 'CODE128', 400);
    const short = zplTesting.moduleWidth('AB', 'CODE128', 400);

    expect(narrow).toBeGreaterThanOrEqual(1);
    expect(narrow).toBeLessThan(short);
    // Whatever width is chosen, the encoded symbol has to fit the printable area.
    expect(zplTesting.moduleCount('012345678901234567890123', 'CODE128') * narrow).toBeLessThanOrEqual(400);
  });

  it('centres the barcode within the printable width', () => {
    const zpl = encodeLabel(
      { title: 'Label', sku: 'S', name: 'N', barcode: 'AB' },
      labelPrinter,
    ).toString('utf8');

    const origin = /\^FO(\d+),\d+\^BY(\d+)/.exec(zpl);
    expect(origin).not.toBeNull();

    const originX = Number(origin![1]);
    const symbolWidth = zplTesting.moduleCount('AB', 'CODE128') * Number(origin![2]);
    // 50mm at 203dpi is 400 dots, less an 8-dot margin on each edge.
    expect(originX + symbolWidth).toBeLessThanOrEqual(400 - 8);
    expect(originX).toBeGreaterThanOrEqual(8);
  });

  it('does not wrap the barcode in a text-block command', () => {
    const zpl = encodeLabel(
      { title: 'Label', sku: 'S', name: 'N', barcode: 'ABC12345' },
      labelPrinter,
    ).toString('utf8');

    expect(/\^FB[^\^]*\^BC/.test(zpl)).toBe(false);
  });
});
