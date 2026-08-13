import {
  CashCountMode,
  CartLine,
  CashDeclaration,
  Customer,
  DEFAULT_CUSTOMER_ID,
  PaymentMethod,
  POSShiftReconciliationSettings,
  POSTenderDeclarationMode,
  POSUser,
  Product,
  ProductPriceTier,
  ProductVariant,
  SaleSummary,
  ShiftSummary,
  TENDER_TOTAL_KEY,
  ZReportSummary,
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

/** Tender types a cashier can be asked to declare alongside the cash count. */
export const NON_CASH_PAYMENT_METHODS: PaymentMethod[] = [
  PaymentMethod.VISA,
  PaymentMethod.MASTER,
  PaymentMethod.AMEX,
  PaymentMethod.CREDIT,
  PaymentMethod.GIFT,
  PaymentMethod.INSTALLMENT,
];

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  VISA: 'Visa',
  MASTER: 'Master',
  AMEX: 'Amex',
  CREDIT: 'Credit',
  GIFT: 'Gift voucher',
  INSTALLMENT: 'Installment plan',
  [TENDER_TOTAL_KEY]: 'All non-cash tender',
};

export function saleIncludesCash(sale: Pick<SaleSummary, 'payments'>): boolean {
  return sale.payments.some((payment) => payment.method === PaymentMethod.CASH);
}

/**
 * Picks the customer a fresh bill starts on. Customers arrive sorted by name,
 * so falling back to the first row silently opens every sale against whichever
 * account sorts first alphabetically — a real wholesale account, with its own
 * price tier. The seeded walk-in account is the correct default; matching on
 * name covers installations whose walk-in row came from an upstream import and
 * carries a different id.
 */
export function resolveDefaultCustomerId(customers: Customer[]): string {
  const byId = customers.find((customer) => customer.id === DEFAULT_CUSTOMER_ID);
  if (byId) return byId.id;

  const byName = customers.find((customer) => /^walk[\s-]?in/i.test(customer.name.trim()));
  if (byName) return byName.id;

  return customers[0]?.id ?? '';
}

export interface TenderReconciliationRow {
  key: string;
  label: string;
  declared: number;
  expected: number;
  variance: number;
  /** True when the variance clears either configured alert threshold. */
  flagged: boolean;
}

export interface ShiftReconciliation {
  cash: TenderReconciliationRow;
  tenders: TenderReconciliationRow[];
  /** Cash plus every declared non-cash bucket. */
  overall: TenderReconciliationRow;
  flaggedRows: TenderReconciliationRow[];
  hasAlert: boolean;
}

function buildReconciliationRow(
  key: string,
  label: string,
  declared: number,
  expected: number,
  settings: POSShiftReconciliationSettings,
): TenderReconciliationRow {
  const variance = roundCurrency(declared - expected);
  const magnitude = Math.abs(variance);
  const overAmount = settings.alertThresholdAmount > 0 && magnitude >= settings.alertThresholdAmount;
  // A percentage threshold is meaningless against a zero expectation; any money
  // declared where none was expected is caught by the amount threshold instead.
  const overPercent = settings.alertThresholdPercent > 0
    && Math.abs(expected) > 0
    && (magnitude / Math.abs(expected)) * 100 >= settings.alertThresholdPercent;

  return {
    key,
    label,
    declared: roundCurrency(declared),
    expected: roundCurrency(expected),
    variance,
    flagged: overAmount || overPercent,
  };
}

/**
 * Compares what the cashier declared at close against what the transaction log
 * says should be there. `report` is the shift's own Z-report, so "expected" is
 * derived from recorded sales, refunds and the opening float rather than from
 * anything the cashier typed.
 */
/** What the transaction log says a declared tender bucket should hold. */
export function expectedForTenderKey(
  paymentBreakdown: Record<string, number>,
  key: string,
): number {
  if (key !== TENDER_TOTAL_KEY) {
    return paymentBreakdown[key] ?? 0;
  }

  return Object.entries(paymentBreakdown)
    .filter(([method]) => method !== PaymentMethod.CASH)
    .reduce((sum, [, amount]) => sum + amount, 0);
}

export function summarizeShiftReconciliation(
  report: Pick<ZReportSummary, 'expectedDrawer' | 'paymentBreakdown'>,
  declaration: Pick<CashDeclaration, 'total' | 'tenders' | 'tenderMode'>,
  settings: POSShiftReconciliationSettings,
): ShiftReconciliation {
  const declaredTenders = declaration.tenders ?? {};
  // The declaration's own keys win when it carries them, so reopening a closed
  // shift reconciles against what was actually collected rather than whatever
  // the terminal is configured to collect today.
  const selectedKeys = Object.keys(declaredTenders).length > 0
    ? Object.keys(declaredTenders)
    : settings.declaredTenders;

  const cash = buildReconciliationRow(
    PaymentMethod.CASH,
    PAYMENT_METHOD_LABELS.CASH,
    declaration.total,
    report.expectedDrawer,
    settings,
  );

  const tenders: TenderReconciliationRow[] = selectedKeys
    .map((key) => buildReconciliationRow(
      key,
      PAYMENT_METHOD_LABELS[key] ?? key,
      declaredTenders[key] ?? 0,
      expectedForTenderKey(report.paymentBreakdown, key),
      settings,
    ))
    // A tender with nothing expected and nothing declared is noise on a close screen.
    .filter((row) => row.declared !== 0 || row.expected !== 0);

  const declaredTotal = cash.declared + tenders.reduce((sum, row) => sum + row.declared, 0);
  const expectedTotal = cash.expected + tenders.reduce((sum, row) => sum + row.expected, 0);
  const overall = buildReconciliationRow('OVERALL', 'All declared tender', declaredTotal, expectedTotal, settings);
  const flaggedRows = [cash, ...tenders].filter((row) => row.flagged);

  return {
    cash,
    tenders,
    overall,
    flaggedRows,
    hasAlert: flaggedRows.length > 0,
  };
}

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
  const resolvedTier = line.priceTiers.length ? pickPriceTier(line.priceTiers, [line.tierLabel], safeQuantity) : undefined;
  const safeUnitPrice = Number.isFinite(resolvedTier?.price) ? resolvedTier!.price : (Number.isFinite(line.unitPrice) ? line.unitPrice : 0);
  const gross = safeQuantity * safeUnitPrice;
  const discountPercent = clampPercent(line.discountPercent);
  const discountAmount = roundCurrency(gross * (discountPercent / 100));
  const lineTotal = Math.max(0, roundCurrency(gross - discountAmount));

  return {
    ...line,
    quantity: safeQuantity,
    unitPrice: safeUnitPrice,
    tierLabel: resolvedTier?.label ?? line.tierLabel,
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
  const effectivePriceTiers = variant?.priceTiers?.length ? variant.priceTiers : product.priceTiers;
  const tier = pickPriceTier(effectivePriceTiers, preferredTierLabels, 1);
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
    priceTiers: sortPriceTiers(effectivePriceTiers),
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

export interface DenominationBreakdown {
  /** Denomination value to piece count, e.g. `{ 100: 4, 50: 1 }`. */
  counts: Record<number, number>;
  /** Total pieces handed over; the tie-break a cashier actually cares about. */
  pieceCount: number;
}

export interface ChangeSuggestion extends DenominationBreakdown {
  amount: number;
  /**
   * True when this breakdown fits inside the drawer's known contents. False
   * means either the drawer cannot cover it, or the drawer is unknown — the
   * caller should only surface a warning when it actually passed a supply.
   */
  payableFromDrawer: boolean;
}

export interface TopUpSuggestion {
  /** Extra the customer is asked for on top of what they already handed over. */
  askFor: number;
  /** Denominations that make up the extra ask. */
  askBreakdown: DenominationBreakdown;
  /** Change once the extra is included — the point of asking. */
  changeAmount: number;
  changeBreakdown: DenominationBreakdown;
  /** Pieces saved versus giving change for the original tender. */
  piecesSaved: number;
  /** The drawer, plus what the customer hands over, can pay this change out. */
  payableFromDrawer: boolean;
  /** The drawer could not make the original change, but can make this one. */
  unblocksDrawer: boolean;
}

/** Merges two denomination maps, for asking what the drawer holds after a tender. */
export function addCounts(
  base: Record<string | number, number>,
  extra: Record<string | number, number>,
): Record<string, number> {
  const merged: Record<string, number> = {};

  for (const [value, count] of Object.entries(base)) {
    const parsed = Number(count);
    if (Number.isFinite(parsed) && parsed > 0) merged[value] = parsed;
  }
  for (const [value, count] of Object.entries(extra)) {
    const parsed = Number(count);
    if (Number.isFinite(parsed) && parsed > 0) merged[value] = (merged[value] ?? 0) + parsed;
  }

  return merged;
}

/** Subtracts denominations from a map, never going below zero on any value. */
export function subtractCounts(
  base: Record<string | number, number>,
  taken: Record<string | number, number>,
): Record<string, number> {
  const merged = addCounts(base, {});

  for (const [value, count] of Object.entries(taken)) {
    const parsed = Number(count);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const next = (merged[value] ?? 0) - parsed;
    if (next > 0) {
      merged[value] = next;
    } else {
      delete merged[value];
    }
  }

  return merged;
}

/** Face value of a denomination map. */
export function countsTotal(counts: Record<string | number, number>): number {
  return roundCurrency(
    Object.entries(counts).reduce((sum, [value, count]) => {
      const pieces = Number(count);
      const face = Number(value);
      return Number.isFinite(pieces) && Number.isFinite(face) ? sum + (face * pieces) : sum;
    }, 0),
  );
}

function formatBreakdownCounts(counts: Record<number, number>): string {
  return Object.entries(counts)
    .map(([value, count]) => [Number(value), count] as const)
    .sort((left, right) => right[0] - left[0])
    .map(([value, count]) => `${count}x${value}`)
    .join(' + ');
}

/** Renders `{ 100: 4, 50: 1 }` as `4x100 + 1x50`, the way a cashier reads a till slip. */
export function formatDenominationBreakdown(breakdown: DenominationBreakdown): string {
  return formatBreakdownCounts(breakdown.counts);
}

/** Denomination values, largest first, as whole rupees. */
const DENOMINATION_VALUES = DENOMINATIONS.map((entry) => entry.value).sort((left, right) => right - left);

export interface ChangeOptions {
  /** Denominations allowed at all; defaults to every denomination in use. */
  values?: number[];
  /**
   * Pieces actually available per denomination. When given, no breakdown may
   * use more of a denomination than the drawer holds. Omit for the theoretical
   * answer that ignores what is in the till.
   */
  supply?: Record<string | number, number>;
}

/** Guard against a pathological target locking the till up in a DP loop. */
const MAX_CHANGE_TARGET = 100_000;

function readSupply(supply: ChangeOptions['supply'], value: number): number {
  if (!supply) return Number.POSITIVE_INFINITY;
  const count = Number(supply[value] ?? supply[String(value)] ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** Unbounded minimum-pieces change, used when the drawer contents are unknown. */
function makeUnboundedBreakdown(target: number, values: number[]): DenominationBreakdown | null {
  const best = new Array<number>(target + 1).fill(Number.POSITIVE_INFINITY);
  const pick = new Array<number>(target + 1).fill(0);
  best[0] = 0;

  for (let amountSoFar = 1; amountSoFar <= target; amountSoFar += 1) {
    for (const value of values) {
      if (value > amountSoFar) continue;
      const candidate = best[amountSoFar - value] + 1;
      if (candidate < best[amountSoFar]) {
        best[amountSoFar] = candidate;
        pick[amountSoFar] = value;
      }
    }
  }

  if (!Number.isFinite(best[target])) return null;

  const counts: Record<number, number> = {};
  let remaining = target;
  while (remaining > 0) {
    const value = pick[remaining];
    counts[value] = (counts[value] ?? 0) + 1;
    remaining -= value;
  }

  return { counts, pieceCount: best[target] };
}

/**
 * Minimum-pieces change that never spends more of a denomination than the
 * drawer holds. A bounded problem, so the greedy answer can be wrong — 450 from
 * a drawer with one 100 and plenty of 50s is 1x100 + 7x50, which greedy would
 * never reach after taking the 100.
 */
function makeBoundedBreakdown(
  target: number,
  values: number[],
  supply: NonNullable<ChangeOptions['supply']>,
): DenominationBreakdown | null {
  const size = target + 1;
  const count = values.length;
  const INFEASIBLE = 0x3fffffff;
  // best[i][r]: fewest pieces making r using only values from index i onward.
  const best = new Int32Array((count + 1) * size).fill(INFEASIBLE);
  const chosen = new Int32Array((count + 1) * size);
  best[count * size] = 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const value = values[index];
    const stock = readSupply(supply, value);
    const row = index * size;
    const nextRow = (index + 1) * size;

    for (let remaining = 0; remaining < size; remaining += 1) {
      let bestPieces = INFEASIBLE;
      let bestUsed = 0;
      const limit = Math.min(stock, Math.floor(remaining / value));

      for (let used = 0; used <= limit; used += 1) {
        const sub = best[nextRow + (remaining - (used * value))];
        if (sub >= INFEASIBLE) continue;
        const pieces = sub + used;
        if (pieces < bestPieces) {
          bestPieces = pieces;
          bestUsed = used;
        }
      }

      best[row + remaining] = bestPieces;
      chosen[row + remaining] = bestUsed;
    }
  }

  if (best[target] >= INFEASIBLE) return null;

  const counts: Record<number, number> = {};
  let remaining = target;
  for (let index = 0; index < count && remaining > 0; index += 1) {
    const used = chosen[(index * size) + remaining];
    if (used > 0) {
      counts[values[index]] = used;
      remaining -= used * values[index];
    }
  }

  return { counts, pieceCount: best[target] };
}

/**
 * The fewest-pieces way to make an amount, or null if it cannot be made exactly
 * from the denominations — and, when a `supply` is given, from the pieces the
 * drawer actually holds.
 *
 * The search is exhaustive rather than greedy so a future denomination change,
 * or a drawer that has run out of something, cannot produce a
 * wrong-but-plausible answer. Anything unmakeable comes back as null.
 */
export function makeChangeBreakdown(
  amount: number,
  options: ChangeOptions = {},
): DenominationBreakdown | null {
  const target = Math.round(amount);
  if (!Number.isFinite(target) || target < 0 || Math.abs(amount - target) > 0.005) {
    return null;
  }
  if (target === 0) {
    return { counts: {}, pieceCount: 0 };
  }
  if (target > MAX_CHANGE_TARGET) {
    return null;
  }

  const values = [...new Set(options.values ?? DENOMINATION_VALUES)]
    .filter((value) => value > 0)
    .sort((left, right) => right - left);
  if (values.length === 0) return null;

  return options.supply
    ? makeBoundedBreakdown(target, values, options.supply)
    : makeUnboundedBreakdown(target, values);
}

/**
 * More pieces than a cashier would ever count out by hand. A breakdown above
 * this is arithmetically valid but useless at a till — 45 ten-rupee coins for a
 * 450 change is not a suggestion, it is noise.
 */
const MAX_SUGGESTED_PIECES = 12;

/**
 * Alternative ways to hand back the same change.
 *
 * The first result is the fewest-pieces breakdown. Each further suggestion
 * forbids the *smallest* denomination the previous one used, which is what
 * actually happens at a till: the big notes stay, and the small remainder gets
 * made up differently because the drawer ran out of fifties. Forbidding the
 * largest instead would answer "450" with "9x50", which no one hands over.
 */
export function suggestChangeBreakdowns(
  amount: number,
  limit = 3,
  supply?: ChangeOptions['supply'],
): ChangeSuggestion[] {
  // No change owed is not a suggestion of "hand over nothing".
  if (!Number.isFinite(amount) || amount <= 0) {
    return [];
  }

  const collect = (constrainToSupply: boolean): ChangeSuggestion[] => {
    const found: ChangeSuggestion[] = [];
    const seen = new Set<string>();
    let values = [...DENOMINATION_VALUES];

    while (found.length < limit && values.length > 0) {
      const breakdown = makeChangeBreakdown(amount, {
        values,
        supply: constrainToSupply ? supply : undefined,
      });
      if (breakdown == null) break;

      const signature = formatBreakdownCounts(breakdown.counts);
      if (!seen.has(signature) && breakdown.pieceCount <= MAX_SUGGESTED_PIECES) {
        seen.add(signature);
        found.push({
          ...breakdown,
          amount: roundCurrency(amount),
          payableFromDrawer: constrainToSupply,
        });
      }

      const smallestUsed = Math.min(...Object.keys(breakdown.counts).map(Number));
      if (!Number.isFinite(smallestUsed)) break;
      values = values.filter((value) => value !== smallestUsed);
    }

    return found;
  };

  if (supply != null) {
    const payable = collect(true);
    if (payable.length > 0) {
      return payable;
    }
    // The drawer cannot make this amount. Still show how it breaks down, but
    // marked, so the cashier is told to break a note rather than left guessing.
  }

  return collect(false);
}

/**
 * Small extra amounts worth asking the customer for, because they make the
 * change rounder and use fewer pieces.
 *
 * The classic case: a 4,550 bill paid with 5,000 needs 450 back as four notes
 * and a coin, but asking for another 50 turns it into a single 500 note.
 */
export function suggestTenderTopUps(
  total: number,
  tendered: number,
  limit = 3,
  supply?: ChangeOptions['supply'],
): TopUpSuggestion[] {
  const baseChange = Math.round(tendered - total);
  if (baseChange <= 0) {
    return [];
  }

  const baseBreakdown = makeChangeBreakdown(baseChange);
  if (baseBreakdown == null) {
    return [];
  }

  // What the drawer can actually do for the current tender. If it cannot cover
  // the change at all, any ask that *can* be covered is worth surfacing even
  // when it saves no pieces — that is the whole reason to ask.
  const basePayable = supply == null
    ? null
    : makeChangeBreakdown(baseChange, { supply });

  const suggestions: TopUpSuggestion[] = [];
  // Asking for more than the change being handed back is not a simplification,
  // it is a re-tender; the 100 floor keeps small bills from having no options.
  const maxAsk = Math.min(1_000, Math.max(baseChange, 100));

  // Round asks only. "Do you have another 50?" is a question a cashier asks;
  // "do you have another 51?" is not, however good the resulting change looks.
  for (let askFor = 5; askFor <= maxAsk; askFor += 5) {
    const askBreakdown = makeChangeBreakdown(askFor);
    // The customer has to be able to hand this over without counting out a
    // handful, or the suggestion is slower than just giving the change.
    if (askBreakdown == null || askBreakdown.pieceCount > 2) continue;

    const changeAmount = baseChange + askFor;
    // The notes the customer hands over land in the drawer before the change
    // comes out, so they are available to make that change.
    const supplyAfterAsk = supply == null
      ? undefined
      : addCounts(supply, askBreakdown.counts);
    const payableBreakdown = supplyAfterAsk == null
      ? null
      : makeChangeBreakdown(changeAmount, { supply: supplyAfterAsk });
    const changeBreakdown = payableBreakdown ?? makeChangeBreakdown(changeAmount);
    if (changeBreakdown == null) continue;

    const piecesSaved = baseBreakdown.pieceCount - changeBreakdown.pieceCount;
    const unblocksDrawer = basePayable == null && supply != null && payableBreakdown != null;

    // Worth mentioning if the change gets simpler, or if it is the difference
    // between being able to give change at all and not.
    if (piecesSaved <= 0 && !unblocksDrawer) continue;

    suggestions.push({
      askFor,
      askBreakdown,
      changeAmount,
      changeBreakdown,
      piecesSaved,
      payableFromDrawer: payableBreakdown != null,
      unblocksDrawer,
    });
  }

  return suggestions
    .sort((left, right) => (
      // An ask that makes the change payable at all beats one that merely tidies it.
      Number(right.unblocksDrawer) - Number(left.unblocksDrawer)
      || Number(right.payableFromDrawer) - Number(left.payableFromDrawer)
      || right.piecesSaved - left.piecesSaved
      || left.askBreakdown.pieceCount - right.askBreakdown.pieceCount
      || left.askFor - right.askFor
    ))
    .slice(0, limit);
}

export function createEmptyDenominationCounts(): Record<string, number> {
  return Object.fromEntries(DENOMINATIONS.map((denomination) => [String(denomination.value), 0]));
}

export function buildCashDeclaration(
  mode: CashCountMode,
  counts: Record<string, number>,
  options: {
    /** Declared non-cash tender, keyed by payment method or `TENDER_TOTAL_KEY`. */
    tenders?: Record<string, number>;
    /** Which buckets were asked for; an empty list records no tender at all. */
    declaredTenders?: string[];
    variance?: number;
  } = {},
): CashDeclaration {
  const total = roundCurrency(
    DENOMINATIONS.reduce((sum, denomination) => {
      const count = Math.max(0, Number(counts[String(denomination.value)] ?? 0));
      return sum + (denomination.value * count);
    }, 0),
  );

  const selectedKeys = options.declaredTenders ?? [];
  // Only the buckets actually asked for are recorded, so a later reconciliation
  // reads back exactly what this cashier was asked to count.
  const tenders = selectedKeys.length === 0
    ? undefined
    : Object.fromEntries(selectedKeys.map((key) => [
      key,
      roundCurrency(Number(options.tenders?.[key]) || 0),
    ]));

  const tenderMode: POSTenderDeclarationMode | undefined = tenders == null
    ? undefined
    : selectedKeys.includes(TENDER_TOTAL_KEY) ? 'total' : 'category';

  return {
    mode,
    total,
    denominations: counts,
    variance: options.variance,
    tenders,
    tenderMode,
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

export function formatShiftReference(
  shift: Pick<ShiftSummary, 'openedAt' | 'terminalId'>,
  terminalCode?: string,
): string {
  const openedAt = new Date(shift.openedAt);
  const terminal = terminalCode?.trim() || 'POS';

  if (Number.isNaN(openedAt.getTime())) {
    return terminal;
  }

  const date = openedAt.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const time = openedAt.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${terminal} · ${date}, ${time}`;
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
