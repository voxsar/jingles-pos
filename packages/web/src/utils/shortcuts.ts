/**
 * Renderer-side presentation for the configurable workstation shortcuts.
 *
 * Serialisation, validation and normalisation live in `@jingles/shared` so the
 * Electron main process applies exactly the same rules when it reads the
 * settings file off disk. Only the human-facing labelling and the conflict
 * report the settings form draws belong here.
 */
import {
  ACTION_SHORTCUT_IDS,
  normalizeBinding,
  type POSActionShortcutId,
  type POSActionShortcuts,
  type POSKeyBinding,
  type POSQuickKey,
} from '@jingles/shared';

export const ACTION_SHORTCUT_LABELS: Record<POSActionShortcutId, string> = {
  help: 'Help',
  orders: 'Orders',
  search: 'Search products',
  hold: 'Hold bill',
  recall: 'Recall bill',
  discount: 'Bill discount',
  customer: 'Customer',
  pay: 'Pay',
  quote: 'Quotation',
  refund: 'Refund',
  void: 'Void',
  cashDrawer: 'Cash drawer',
  cashMovement: 'Cash in / out',
  staff: 'Change line staff',
  unit: 'Choose unit quantity',
  discountValue: 'Discount by value',
  discountPercent: 'Discount by percent',
  closePopup: 'Close quick popup',
};

export const ACTION_SHORTCUT_HINTS: Record<POSActionShortcutId, string> = {
  help: 'Opens the in-app help guide.',
  orders: 'Opens the order history window.',
  search: 'Opens the product search overlay.',
  hold: 'Parks the current bill so another customer can be served.',
  recall: 'Restores a parked bill.',
  discount: 'Focuses the bill discount field and selects its value.',
  customer: 'Opens the customer picker with the search box focused.',
  pay: 'Opens the payment window when the cart has items and a shift is open.',
  quote: 'Prints a quotation for the current cart without recording a sale.',
  refund: 'Opens the refund and return window.',
  void: 'Voids the current bill. When an overlay is open this key closes it first.',
  cashDrawer: 'Opens the shift money declare window, or the cash drawer once a shift is open.',
  cashMovement: 'Records cash added to or taken out of the drawer mid-shift, so the close still reconciles.',
  staff: 'Opens the staff picker for the most recently added cart line.',
  unit: 'Works only in the unit popup and returns to the quantity choices.',
  discountValue: 'Works only in the discount popup and selects value mode.',
  discountPercent: 'Works only in the discount popup and selects percentage mode.',
  closePopup: 'Works only in unit, staff, customer and discount quick popups.',
};

/** Numeric item keys are deliberately scoped to an open picker. */
export function popupNumberIndex(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): number | null {
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
  const match = /^(?:Numpad|Digit)([1-9])$/.exec(event.code);
  return match ? Number(match[1]) - 1 : null;
}

/**
 * Single-key cash denomination shortcuts shared by the payment window, the
 * open/close shift declaration, and cash in/out. Digit1 is the largest note in
 * use and Digit9 the smallest, so the key order reads the same as the
 * denomination list on screen (largest to smallest, left to right).
 */
export const CASH_DENOMINATION_SHORTCUTS = [
  { code: 'Digit1', value: 5000, label: '1' },
  { code: 'Digit2', value: 500, label: '2' },
  { code: 'Digit3', value: 100, label: '3' },
  { code: 'Digit4', value: 50, label: '4' },
  { code: 'Digit5', value: 20, label: '5' },
  { code: 'Digit6', value: 10, label: '6' },
  { code: 'Digit7', value: 5, label: '7' },
  { code: 'Digit8', value: 2, label: '8' },
  { code: 'Digit9', value: 1, label: '9' },
] as const;

/** Looks up the cash shortcut for a keydown event; modified key presses don't match. */
export function cashDenominationShortcut(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): (typeof CASH_DENOMINATION_SHORTCUTS)[number] | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  return CASH_DENOMINATION_SHORTCUTS.find((entry) => entry.code === event.code) ?? null;
}

/**
 * Reports every binding claimed more than once, mapped to the things claiming
 * it. A duplicate does not block saving — the operator may be mid-edit — but it
 * is surfaced in the form, and at runtime the first claimant in action order
 * wins so dispatch stays deterministic.
 */
export function findShortcutConflicts(
  actions: POSActionShortcuts,
  quickKeys: POSQuickKey[],
): Map<POSKeyBinding, string[]> {
  const owners = new Map<POSKeyBinding, string[]>();

  const claim = (binding: POSKeyBinding | null, owner: string) => {
    if (!binding) return;
    owners.set(binding, [...(owners.get(binding) ?? []), owner]);
  };

  for (const id of ACTION_SHORTCUT_IDS) {
    claim(normalizeBinding(actions[id]), ACTION_SHORTCUT_LABELS[id]);
  }
  for (const quickKey of quickKeys) {
    claim(normalizeBinding(quickKey.binding), quickKey.label || quickKey.sku || 'Quick key');
  }

  return new Map([...owners].filter(([, claimants]) => claimants.length > 1));
}
