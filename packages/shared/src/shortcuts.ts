/**
 * Serialisation and validation for configurable key bindings.
 *
 * Lives in `shared` because the settings file is normalised twice: once in the
 * Electron main process when it is read off disk (where it may have been
 * hand-edited), and once in the renderer when the settings form is saved. Both
 * must agree on what a valid binding is, or a terminal can end up with a
 * shortcut the UI shows but the key handler never matches.
 *
 * A binding is ordered modifiers plus a `KeyboardEvent.code`, e.g. `F7`,
 * `Escape`, `Ctrl+Digit1`, `Alt+Numpad4`. `code` rather than `key` keeps
 * bindings stable across keyboard layouts and separates the numpad — the block
 * a till operator actually reaches for — from the number row.
 */
import {
  DECLARABLE_TENDER_METHODS,
  DEFAULT_POS_ACTION_SHORTCUTS,
  DEFAULT_POS_SHIFT_RECONCILIATION,
  TENDER_TOTAL_KEY,
  type POSActionShortcutId,
  type POSActionShortcuts,
  type POSKeyBinding,
  type POSQuickKey,
  type POSShiftReconciliationSettings,
  type POSShortcutSettings,
  type POSTenderDeclarationMode,
} from './types';

/**
 * The parts of a `KeyboardEvent` a binding is derived from, declared
 * structurally because this package is compiled without the DOM lib.
 */
export interface KeyBindingEventLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const;

/** Codes that are only modifiers, and so can never be a binding on their own. */
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight',
]);

export const ACTION_SHORTCUT_IDS: POSActionShortcutId[] = [
  'help',
  'orders',
  'search',
  'hold',
  'recall',
  'discount',
  'customer',
  'pay',
  'quote',
  'refund',
  'void',
  'cashDrawer',
  'cashMovement',
  'staff',
  'unit',
  'discountValue',
  'discountPercent',
  'closePopup',
];

function splitBinding(binding: POSKeyBinding): { modifiers: string[]; code: string } {
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean);
  return { modifiers: parts.slice(0, -1), code: parts[parts.length - 1] ?? '' };
}

/** Re-serialises a binding into canonical modifier order so string equality is reliable. */
export function normalizeBinding(binding: unknown): POSKeyBinding | null {
  if (typeof binding !== 'string' || !binding.trim()) {
    return null;
  }

  const { modifiers, code } = splitBinding(binding);
  if (!code || MODIFIER_CODES.has(code)) {
    return null;
  }

  const ordered = MODIFIER_ORDER.filter((modifier) => (
    modifiers.some((candidate) => candidate.toLowerCase() === modifier.toLowerCase())
  ));

  return [...ordered, code].join('+');
}

/** Builds the canonical binding for a keyboard event, or null if only modifiers are held. */
export function bindingFromEvent(
  event: KeyBindingEventLike,
): POSKeyBinding | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  return [...modifiers, event.code].join('+');
}

export function bindingMatchesEvent(
  binding: POSKeyBinding | null | undefined,
  event: KeyBindingEventLike,
): boolean {
  if (!binding) return false;
  const normalized = normalizeBinding(binding);
  return normalized != null && normalized === bindingFromEvent(event);
}

/** Turns `Ctrl+Digit1` into `Ctrl + 1` for display on a key cap. */
export function formatBinding(binding: POSKeyBinding | null | undefined): string {
  if (!binding) return 'Unassigned';

  const { modifiers, code } = splitBinding(binding);
  const readable = code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace(/^Arrow/, '')
    .replace(/^Escape$/, 'Esc');

  return [...modifiers, readable].join(' + ');
}

/**
 * Quick keys fire while the catalog has focus, so an unmodified letter or digit
 * would collide with a barcode scanner: the first character of a scan burst is
 * always delivered before the burst can be recognised as a scan, which would
 * silently ring up the wrong product. Requiring a modifier or a function key
 * removes that class of mis-sale outright, since no keyboard-wedge scanner
 * emits modifier keys.
 */
export function isValidQuickKeyBinding(binding: unknown): boolean {
  const normalized = normalizeBinding(binding);
  if (!normalized) return false;

  const { modifiers, code } = splitBinding(normalized);
  if (modifiers.includes('Ctrl') || modifiers.includes('Alt')) return true;

  return /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
}

export const QUICK_KEY_BINDING_HINT =
  'Quick keys must use Ctrl or Alt, or a function key. Unmodified keys stay reserved so a barcode scan can never ring up the wrong product.';

/** Fills any missing or unusable action binding from the defaults. */
export function normalizeActionShortcuts(value: unknown): POSActionShortcuts {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<Record<POSActionShortcutId, unknown>>;
  const resolved = {} as POSActionShortcuts;

  for (const id of ACTION_SHORTCUT_IDS) {
    resolved[id] = normalizeBinding(source[id]) ?? DEFAULT_POS_ACTION_SHORTCUTS[id];
  }

  return resolved;
}

/** Drops quick keys that are unusable or duplicated so runtime dispatch is unambiguous. */
export function normalizeQuickKeys(value: unknown): POSQuickKey[] {
  if (!Array.isArray(value)) return [];

  const seenBindings = new Set<string>();
  const seenIds = new Set<string>();

  return value.flatMap((entry): POSQuickKey[] => {
    if (!entry || typeof entry !== 'object') return [];

    const source = entry as Partial<POSQuickKey>;
    const binding = normalizeBinding(source.binding);
    const productId = typeof source.productId === 'string' ? source.productId.trim() : '';
    if (!binding || !productId || !isValidQuickKeyBinding(binding)) return [];

    const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : `quick-${binding}`;
    if (seenBindings.has(binding) || seenIds.has(id)) return [];

    seenBindings.add(binding);
    seenIds.add(id);

    return [{
      id,
      binding,
      productId,
      sku: typeof source.sku === 'string' ? source.sku : '',
      label: typeof source.label === 'string' ? source.label : '',
      variantId: typeof source.variantId === 'string' && source.variantId.trim() ? source.variantId.trim() : undefined,
    }];
  });
}

export function normalizeShortcutSettings(value: unknown): POSShortcutSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<POSShortcutSettings>;

  return {
    actions: normalizeActionShortcuts(source.actions),
    quickKeysEnabled: source.quickKeysEnabled !== false,
    quickKeys: normalizeQuickKeys(source.quickKeys),
  };
}

/**
 * Resolves the tender buckets to collect at close.
 *
 * Accepts the current multi-select list and also the single `tenderDeclarationMode`
 * this setting used to be, so a terminal that already had 'total' or 'category'
 * saved keeps behaving the same after an upgrade instead of silently reverting
 * to cash only.
 */
function normalizeDeclaredTenders(value: unknown, legacyMode: unknown): string[] {
  const allowed = new Set<string>([TENDER_TOTAL_KEY, ...DECLARABLE_TENDER_METHODS]);

  let selected: string[];
  if (Array.isArray(value)) {
    selected = [...new Set(
      value.filter((entry): entry is string => typeof entry === 'string' && allowed.has(entry)),
    )];
  } else if (legacyMode === 'total') {
    selected = [TENDER_TOTAL_KEY];
  } else if (legacyMode === 'category') {
    selected = [...DECLARABLE_TENDER_METHODS];
  } else {
    selected = [];
  }

  // A lump total already covers every method, so keeping both would reconcile
  // the same money twice in the overall figure.
  if (selected.includes(TENDER_TOTAL_KEY)) {
    return [TENDER_TOTAL_KEY];
  }

  // Stored in a stable order so the settings form does not reshuffle on save.
  return DECLARABLE_TENDER_METHODS.filter((method) => selected.includes(method));
}

function clampThreshold(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.round(parsed * 100) / 100);
}

export function normalizeShiftReconciliation(value: unknown): POSShiftReconciliationSettings {
  const source = (value && typeof value === 'object' ? value : {}) as
    Partial<POSShiftReconciliationSettings> & { tenderDeclarationMode?: unknown };

  return {
    declaredTenders: normalizeDeclaredTenders(source.declaredTenders, source.tenderDeclarationMode),
    alertThresholdAmount: clampThreshold(
      source.alertThresholdAmount,
      DEFAULT_POS_SHIFT_RECONCILIATION.alertThresholdAmount,
      10_000_000,
    ),
    alertThresholdPercent: clampThreshold(
      source.alertThresholdPercent,
      DEFAULT_POS_SHIFT_RECONCILIATION.alertThresholdPercent,
      100,
    ),
    requireConfirmationOnAlert: source.requireConfirmationOnAlert !== false,
    allowDrawerOverdraw: source.allowDrawerOverdraw === true,
  };
}

export function createQuickKeyId(): string {
  return `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
