import {
  CashCountMode,
  CartLine,
  CashDeclaration,
  POSUser,
  Product,
  ProductPriceTier,
  ProductVariant,
} from '@jingles/shared';

export interface DenominationDefinition {
  value: number;
  label: string;
  kind: 'note' | 'coin';
}

export interface CartTotals {
  itemCount: number;
  rawSubtotal: number;
  lineDiscountTotal: number;
  subtotal: number;
  billDiscount: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  margin: number;
}

export const DENOMINATIONS: DenominationDefinition[] = [
  { value: 5000, label: 'Rs 5000', kind: 'note' },
  { value: 2000, label: 'Rs 2000', kind: 'note' },
  { value: 1000, label: 'Rs 1000', kind: 'note' },
  { value: 500, label: 'Rs 500', kind: 'note' },
  { value: 100, label: 'Rs 100', kind: 'note' },
  { value: 50, label: 'Rs 50', kind: 'note' },
  { value: 20, label: 'Rs 20', kind: 'coin' },
  { value: 10, label: 'Rs 10', kind: 'coin' },
  { value: 5, label: 'Rs 5', kind: 'coin' },
  { value: 2, label: 'Rs 2', kind: 'coin' },
  { value: 1, label: 'Rs 1', kind: 'coin' },
];

export function sortPriceTiers(tiers: ProductPriceTier[]): ProductPriceTier[] {
  return [...tiers].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return (left.minQty ?? 0) - (right.minQty ?? 0);
  });
}

export function pickPriceTier(
  tiers: ProductPriceTier[],
  preferredLabels: string[] = [],
  quantity = 1,
): ProductPriceTier {
  const eligible = tiers.filter((tier) => (tier.minQty ?? 0) <= quantity);
  const orderedTiers = sortPriceTiers(eligible.length ? eligible : tiers);
  const normalised = preferredLabels.map((label) => label.trim().toLowerCase()).filter(Boolean);

  for (const label of normalised) {
    const matches = orderedTiers.filter((tier) => tier.label.trim().toLowerCase() === label);
    const match = matches.sort((a, b) => (b.minQty ?? 0) - (a.minQty ?? 0))[0];
    if (match) {
      return match;
    }
  }

  const defaultTier = orderedTiers.find((tier) => tier.isDefault);
  return defaultTier ?? orderedTiers[0];
}

export function recalculateCartLine(line: CartLine): CartLine {
  const safeQuantity = Math.max(1, Number.isFinite(line.quantity) ? line.quantity : 1);
  const resolvedTier = pickPriceTier(line.priceTiers, [line.tierLabel], safeQuantity);
  const safeUnitPrice = Number.isFinite(resolvedTier.price) ? resolvedTier.price : 0;
  const gross = safeQuantity * safeUnitPrice;
  const discountPercent = clampPercent(line.discountPercent);
  const discountAmount = roundCurrency(gross * (discountPercent / 100));
  const lineTotal = Math.max(0, roundCurrency(gross - discountAmount));

  return {
    ...line,
    quantity: safeQuantity,
    unitPrice: safeUnitPrice,
    tierLabel: resolvedTier.label,
    discountPercent,
    discountAmount,
    lineTotal,
  };
}

export function createCartLine(
  product: Product,
  salesperson: POSUser,
  preferredTierLabels: string[] = [],
  variant?: ProductVariant,
): CartLine {
  const tier = pickPriceTier(product.priceTiers, preferredTierLabels, 1);
  const estimatedCostBasis = roundCurrency(tier.costBasis ?? tier.price * 0.65);

  return recalculateCartLine({
    uid: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId: product.id,
    sku: variant?.variantCode ?? product.sku,
    name: product.name,
    barcode: product.barcode,
    variantId: variant?.id,
    variantCode: variant?.variantCode,
    variantName: variant?.name ?? undefined,
    variantAttributes: variant?.attributes,
    categoryId: product.categoryId,
    subcategory: product.subcategory,
    packSize: product.packSize,
    quantity: 1,
    unitPrice: tier.price,
    tierLabel: tier.label,
    priceTiers: sortPriceTiers(product.priceTiers),
    salespersonId: salesperson.id,
    salespersonName: salesperson.name,
    salespersonInitials: salesperson.initials,
    discountPercent: 0,
    discountAmount: 0,
    costBasis: estimatedCostBasis,
    stockOnHand: variant?.stockOnHand ?? product.stockOnHand,
    lineTotal: tier.price,
  });
}

export function getProductVariantLabel(variant: ProductVariant): string {
  if (variant.name?.trim()) {
    return variant.name.trim();
  }

  if (variant.attributes.length === 1) {
    return variant.attributes[0]?.value ?? variant.variantCode;
  }

  if (variant.attributes.length > 1) {
    return variant.attributes.map((attribute) => attribute.value).join(' / ');
  }

  return variant.variantCode;
}

export function getLineVariantSummary(
  line: Pick<CartLine, 'variantName' | 'variantCode' | 'variantAttributes'>,
): string | null {
  if (line.variantName?.trim()) {
    return line.variantName.trim();
  }

  if ((line.variantAttributes?.length ?? 0) > 0) {
    return line.variantAttributes!.map((attribute) => attribute.value).join(' / ');
  }

  if (line.variantCode?.trim()) {
    return line.variantCode.trim();
  }

  return null;
}

export function resolvePrice(
  priceTiers: ProductPriceTier[],
  preferredTierLabels: string[] = [],
): ProductPriceTier {
  return pickPriceTier(priceTiers, preferredTierLabels);
}

export function calcCartTotals(lines: CartLine[], billDiscount: number = 0): CartTotals {
  const rawSubtotal = roundCurrency(lines.reduce((sum, line) => sum + (line.unitPrice * line.quantity), 0));
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const lineDiscountTotal = roundCurrency(lines.reduce((sum, line) => sum + line.discountAmount, 0));
  const safeBillDiscount = Math.max(0, roundCurrency(billDiscount));
  const subtotal = Math.max(0, roundCurrency(rawSubtotal - lineDiscountTotal));
  const discountTotal = Math.min(rawSubtotal, roundCurrency(lineDiscountTotal + safeBillDiscount));
  const taxTotal = 0;
  const total = Math.max(0, roundCurrency(rawSubtotal - discountTotal + taxTotal));
  const margin = roundCurrency(
    lines.reduce(
      (sum, line) => sum + ((line.unitPrice - line.costBasis) * line.quantity) - line.discountAmount,
      0,
    ),
  );

  return {
    itemCount,
    rawSubtotal,
    lineDiscountTotal,
    subtotal,
    billDiscount: safeBillDiscount,
    discountTotal,
    taxTotal,
    total,
    margin,
  };
}

export function createEmptyDenominationCounts(): Record<string, number> {
  return Object.fromEntries(DENOMINATIONS.map((denomination) => [String(denomination.value), 0]));
}

export function buildCashDeclaration(
  mode: CashCountMode,
  counts: Record<string, number>,
): CashDeclaration {
  const total = roundCurrency(
    DENOMINATIONS.reduce((sum, denomination) => {
      const count = Math.max(0, Number(counts[String(denomination.value)] ?? 0));
      return sum + (denomination.value * count);
    }, 0),
  );

  return {
    mode,
    total,
    denominations: counts,
  };
}

export function formatCurrency(value: number): string {
  return `Rs ${new Intl.NumberFormat('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)}`;
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-LK').format(Number.isFinite(value) ? value : 0);
}

export function formatTime(value?: string): string {
  if (!value) {
    return '--:--';
  }

  return new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateTime(value?: string): string {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function generateReceiptNumber(terminalCode: string = 'TERM-00'): string {
  const date = new Date();
  const datePart = date.toISOString().slice(2, 10).replace(/-/g, '');
  const terminalPart = terminalCode.replace(/[^A-Z0-9]/gi, '').slice(-4).toUpperCase() || 'TERM';
  const serial = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${datePart}-${terminalPart}-${serial}`;
}

export function generateHoldNumber(terminalCode: string = 'TERM-00'): string {
  const terminalPart = terminalCode.replace(/[^A-Z0-9]/gi, '').slice(-4).toUpperCase() || 'TERM';
  const serial = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `H-${terminalPart}-${serial}`;
}

export function getNameInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '--';
  }

  return parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join('');
}

export function roundCurrency(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}
