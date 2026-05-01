import { BatchPrice } from '@prisma/client';

/**
 * Resolve unit price using batch pricing if applicable.
 * Falls back to base price if no batch price matches.
 */
export function resolveUnitPrice(
  basePrice: number,
  quantity: number,
  batchPrices: BatchPrice[]
): number {
  if (!batchPrices || batchPrices.length === 0) return basePrice;

  // Sort descending by minQty to find highest qualifying tier
  const sorted = [...batchPrices].sort((a, b) => b.minQty - a.minQty);
  for (const tier of sorted) {
    if (quantity >= tier.minQty) {
      return tier.price;
    }
  }
  return basePrice;
}
