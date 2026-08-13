/**
 * ESC/POS encoder for thermal receipt printers.
 *
 * Targets the Epson command set, which Bixolon, Star (in ESC/POS mode), Rongta,
 * Xprinter and most 58/80mm clones implement closely enough that a single byte
 * stream drives all of them. Everything here is plain bytes: no native module,
 * no vendor driver, no rasterization.
 */
import type {
  POSBarcodeSymbology,
  POSPrintBlock,
  POSPrintDocument,
  POSPrinterConfig,
} from '@jingles/shared';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/**
 * Code page 437 is the power-on default on virtually every ESC/POS printer, so
 * we fold the typography the receipt UI uses down to characters that survive it
 * rather than shipping a code-page switch the printer may not honour.
 */
const CHARACTER_FOLDING: Array<[RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/[·•]/g, '-'],
  [/[×]/g, 'x'],
  [/…/g, '...'],
  [/₨|₹/g, 'Rs'],
  [/ /g, ' '],
];

function foldToAscii(value: string) {
  let result = value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  for (const [pattern, replacement] of CHARACTER_FOLDING) {
    result = result.replace(pattern, replacement);
  }

  // Anything still outside printable ASCII would render as a random glyph.
  return result.replace(/[^\x20-\x7e]/g, '');
}

function clampColumns(columns: number) {
  return Number.isFinite(columns) && columns >= 24 && columns <= 96 ? Math.floor(columns) : 42;
}

/** Greedy word wrap that falls back to hard breaks for unbroken runs. */
function wrapText(value: string, width: number): string[] {
  if (!value) {
    return [''];
  }

  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (word.length > width) {
        if (current) {
          lines.push(current);
          current = '';
        }
        for (let index = 0; index < word.length; index += width) {
          const chunk = word.slice(index, index + width);
          if (chunk.length === width) {
            lines.push(chunk);
          } else {
            current = chunk;
          }
        }
        continue;
      }

      if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }

    lines.push(current);
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Lays a label against an amount with the amount flush right. When the pair does
 * not fit, the label wraps and the amount sits alone on the closing line so the
 * money column stays readable.
 */
function layoutColumns(left: string, right: string, width: number, indent: number): string[] {
  const pad = ' '.repeat(Math.max(0, indent));
  const available = width - pad.length;
  const value = right.slice(0, available);

  if (pad.length + left.length + 1 + value.length <= width) {
    const gap = width - pad.length - left.length - value.length;
    return [`${pad}${left}${' '.repeat(Math.max(1, gap))}${value}`];
  }

  const labelLines = wrapText(left, Math.max(1, available - value.length - 1));
  const lines = labelLines.slice(0, -1).map((line) => `${pad}${line}`);
  const lastLabel = labelLines[labelLines.length - 1] ?? '';
  const gap = width - pad.length - lastLabel.length - value.length;

  if (gap >= 1) {
    lines.push(`${pad}${lastLabel}${' '.repeat(gap)}${value}`);
  } else {
    lines.push(`${pad}${lastLabel}`);
    lines.push(value.padStart(width));
  }

  return lines;
}

class ByteWriter {
  private readonly chunks: number[] = [];

  raw(...bytes: number[]) {
    this.chunks.push(...bytes);
    return this;
  }

  ascii(value: string) {
    for (const byte of Buffer.from(value, 'ascii')) {
      this.chunks.push(byte);
    }
    return this;
  }

  line(value = '') {
    return this.ascii(value).raw(LF);
  }

  toBuffer() {
    return Buffer.from(this.chunks);
  }
}

function align(writer: ByteWriter, mode: 'left' | 'center' | 'right') {
  const value = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
  writer.raw(ESC, 0x61, value);
}

function bold(writer: ByteWriter, enabled: boolean) {
  writer.raw(ESC, 0x45, enabled ? 1 : 0);
}

function doubleSize(writer: ByteWriter, enabled: boolean) {
  // GS ! n — high nibble is width, low nibble is height.
  writer.raw(GS, 0x21, enabled ? 0x11 : 0x00);
}

const BARCODE_SELECTORS: Record<POSBarcodeSymbology, number> = {
  // GS k m, function B (m >= 65) which takes an explicit length byte.
  CODE39: 69,
  EAN13: 67,
  CODE128: 73,
};

function isPrintableBarcode(value: string, symbology: POSBarcodeSymbology) {
  if (symbology === 'EAN13') {
    return /^\d{12,13}$/.test(value);
  }

  if (symbology === 'CODE39') {
    return /^[0-9A-Z\-. $/+%]+$/.test(value);
  }

  return /^[\x20-\x7e]+$/.test(value);
}

function writeBarcode(
  writer: ByteWriter,
  value: string,
  symbology: POSBarcodeSymbology,
  height: number,
  showText: boolean,
) {
  const payload = symbology === 'CODE128' ? `{B${value}` : value;

  writer.raw(GS, 0x68, Math.min(255, Math.max(24, Math.round(height)))); // GS h — height in dots
  writer.raw(GS, 0x77, 2); // GS w — module width
  writer.raw(GS, 0x48, showText ? 2 : 0); // GS H — HRI below the bars, or off
  writer.raw(GS, 0x6b, BARCODE_SELECTORS[symbology], payload.length);
  writer.ascii(payload);
  writer.raw(LF);
}

function writeQrCode(writer: ByteWriter, value: string, size: number) {
  const data = Buffer.from(value, 'ascii');
  const length = data.length + 3;

  writer.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0); // model 2
  writer.raw(GS, 0x28, 0x6b, 3, 0, 49, 67, Math.min(16, Math.max(1, size))); // module size
  writer.raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 48); // error correction L
  writer.raw(GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 49, 80, 48);
  for (const byte of data) {
    writer.raw(byte);
  }
  writer.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48); // print
}

function writeBlock(writer: ByteWriter, block: POSPrintBlock, columns: number) {
  switch (block.type) {
    case 'text': {
      const wide = block.wide === true;
      const width = wide ? Math.floor(columns / 2) : columns;
      align(writer, block.align ?? 'left');
      if (block.bold) {
        bold(writer, true);
      }
      if (wide) {
        doubleSize(writer, true);
      }

      for (const line of wrapText(foldToAscii(block.value), width)) {
        writer.line(line);
      }

      if (wide) {
        doubleSize(writer, false);
      }
      if (block.bold) {
        bold(writer, false);
      }
      align(writer, 'left');
      return;
    }

    case 'columns': {
      align(writer, 'left');
      if (block.bold) {
        bold(writer, true);
      }

      const lines = layoutColumns(
        foldToAscii(block.left),
        foldToAscii(block.right),
        columns,
        block.indent ?? 0,
      );
      for (const line of lines) {
        writer.line(line);
      }

      if (block.bold) {
        bold(writer, false);
      }
      return;
    }

    case 'divider': {
      const char = foldToAscii(block.char ?? '-').slice(0, 1) || '-';
      align(writer, 'left');
      writer.line(char.repeat(columns));
      return;
    }

    case 'feed': {
      const count = Math.min(12, Math.max(1, Math.round(block.lines ?? 1)));
      writer.raw(ESC, 0x64, count);
      return;
    }

    case 'barcode': {
      const symbology = block.symbology ?? 'CODE128';
      const value = foldToAscii(block.value).trim();
      if (!value || !isPrintableBarcode(value, symbology)) {
        return;
      }

      align(writer, 'center');
      writeBarcode(writer, value, symbology, block.height ?? 60, block.showText !== false);
      align(writer, 'left');
      return;
    }

    case 'qr': {
      const value = foldToAscii(block.value).trim();
      if (!value) {
        return;
      }

      align(writer, 'center');
      writeQrCode(writer, value, block.size ?? 6);
      writer.raw(LF);
      align(writer, 'left');
      return;
    }

    default:
      // Exhaustive today; ignoring unknown future block types beats throwing
      // away an otherwise printable receipt.
      return;
  }
}

/** Pulse connector pin 2 for 100ms — the standard cash drawer kick. */
export function encodeDrawerKick() {
  return Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);
}

export function encodeReceipt(document: POSPrintDocument, printer: POSPrinterConfig): Buffer {
  const columns = clampColumns(printer.columns);
  const writer = new ByteWriter();

  writer.raw(ESC, 0x40); // ESC @ — reset to a known state
  writer.raw(ESC, 0x74, 0); // ESC t — code page 437

  if (document.openDrawer ?? printer.openDrawer) {
    for (const byte of encodeDrawerKick()) {
      writer.raw(byte);
    }
  }

  for (const block of document.blocks) {
    writeBlock(writer, block, columns);
  }

  writer.raw(ESC, 0x64, 4); // trailing feed clears the tear bar

  if (document.cut ?? printer.cutPaper) {
    writer.raw(GS, 0x56, 0x42, 0x00); // GS V B — partial cut after feeding
  }

  return writer.toBuffer();
}

export const __testing = {
  foldToAscii,
  layoutColumns,
  wrapText,
};
