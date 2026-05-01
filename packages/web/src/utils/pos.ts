import { BatchPrice, CartLine } from '@jingles/shared';

export function resolvePrice(basePrice: number, quantity: number, batchPrices: BatchPrice[]): number {
  if (!batchPrices || batchPrices.length === 0) return basePrice;
  const sorted = [...batchPrices].sort((a, b) => b.minQty - a.minQty);
  for (const tier of sorted) {
    if (quantity >= tier.minQty) return tier.price;
  }
  return basePrice;
}

export function calcCartTotals(lines: CartLine[]) {
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const discountTotal = lines.reduce((s, l) => s + l.discountAmount, 0);
  const taxTotal = 0; // extend for tax support
  const total = Math.max(0, subtotal - discountTotal + taxTotal);
  return { subtotal, discountTotal, taxTotal, total };
}

export function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function generateReceiptNumber(): string {
  const date = new Date();
  const datePart = date.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `RCP-${datePart}-${rand}`;
}
