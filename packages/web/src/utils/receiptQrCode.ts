import qrcode from 'qrcode-generator';

/**
 * Renders `value` as a scalable inline QR-code SVG string for the on-screen
 * receipt preview / browser-print fallback. The real thermal-printer path
 * (packages/electron/src/printing/escpos.ts) encodes its own QR natively via
 * ESC/POS — this is only for when there's no printer bridge to talk to.
 *
 * `typeNumber: 0` auto-picks the smallest QR version that fits `value`, so a
 * short receipt number renders a small, dense code rather than an oversized
 * one.
 */
export function receiptQrSvg(value: string, sizeMm = 20): string {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const svg = qr.createSvgTag({ scalable: true });
  return svg.replace('<svg ', `<svg width="${sizeMm}mm" height="${sizeMm}mm" `);
}
