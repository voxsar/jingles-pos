import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POS_ACTION_SHORTCUTS,
  DECLARABLE_TENDER_METHODS,
  bindingFromEvent,
  bindingMatchesEvent,
  formatBinding,
  isValidQuickKeyBinding,
  normalizeActionShortcuts,
  normalizeBinding,
  normalizeQuickKeys,
  normalizeShiftReconciliation,
} from '@jingles/shared';
import {
  denominationShortcutValue,
  findShortcutConflicts,
  popupNumberIndex,
} from '../utils/shortcuts';

function keyEvent(
  code: string,
  modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {},
) {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe('bindingFromEvent', () => {
  it('serialises modifiers in a fixed order', () => {
    expect(bindingFromEvent(keyEvent('KeyQ', { altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+KeyQ');
    expect(bindingFromEvent(keyEvent('Digit1', { shiftKey: true, ctrlKey: true }))).toBe('Ctrl+Shift+Digit1');
  });

  it('treats Meta as Ctrl so a binding works on either keyboard', () => {
    expect(bindingFromEvent(keyEvent('KeyQ', { metaKey: true }))).toBe('Ctrl+KeyQ');
  });

  it('returns null while only modifiers are held', () => {
    expect(bindingFromEvent(keyEvent('ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(keyEvent('ShiftRight', { shiftKey: true }))).toBeNull();
  });
});

describe('normalizeBinding', () => {
  it('reorders modifiers so string equality is reliable', () => {
    expect(normalizeBinding('Alt+Ctrl+KeyQ')).toBe('Ctrl+Alt+KeyQ');
    expect(normalizeBinding('shift+ctrl+Digit1')).toBe('Ctrl+Shift+Digit1');
  });

  it('rejects empty values and modifier-only bindings', () => {
    expect(normalizeBinding('')).toBeNull();
    expect(normalizeBinding('   ')).toBeNull();
    expect(normalizeBinding(undefined)).toBeNull();
    expect(normalizeBinding('Ctrl+ControlLeft')).toBeNull();
  });
});

describe('bindingMatchesEvent', () => {
  it('matches regardless of the order the binding was written in', () => {
    expect(bindingMatchesEvent('Alt+Ctrl+KeyQ', keyEvent('KeyQ', { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it('does not match when a modifier differs', () => {
    expect(bindingMatchesEvent('Ctrl+Digit1', keyEvent('Digit1'))).toBe(false);
    expect(bindingMatchesEvent('F7', keyEvent('F7', { shiftKey: true }))).toBe(false);
  });

  it('separates the numpad from the number row', () => {
    expect(bindingMatchesEvent('Ctrl+Numpad1', keyEvent('Digit1', { ctrlKey: true }))).toBe(false);
    expect(bindingMatchesEvent('Ctrl+Numpad1', keyEvent('Numpad1', { ctrlKey: true }))).toBe(true);
  });
});

describe('isValidQuickKeyBinding', () => {
  it('accepts modified keys and function keys', () => {
    expect(isValidQuickKeyBinding('Ctrl+Digit1')).toBe(true);
    expect(isValidQuickKeyBinding('Alt+KeyQ')).toBe(true);
    expect(isValidQuickKeyBinding('F9')).toBe(true);
    expect(isValidQuickKeyBinding('F12')).toBe(true);
  });

  it('rejects unmodified keys a barcode scanner could imitate', () => {
    // A scan's first character is always delivered before the burst can be
    // recognised, so a bare digit or letter would ring up the wrong product.
    expect(isValidQuickKeyBinding('Digit1')).toBe(false);
    expect(isValidQuickKeyBinding('KeyQ')).toBe(false);
    expect(isValidQuickKeyBinding('Shift+KeyQ')).toBe(false);
    expect(isValidQuickKeyBinding('Enter')).toBe(false);
  });
});

describe('formatBinding', () => {
  it('renders a binding as a readable key cap', () => {
    expect(formatBinding('Ctrl+Digit1')).toBe('Ctrl + 1');
    expect(formatBinding('Alt+KeyQ')).toBe('Alt + Q');
    expect(formatBinding('Ctrl+Numpad4')).toBe('Ctrl + Num 4');
    expect(formatBinding('Escape')).toBe('Esc');
    expect(formatBinding('F7')).toBe('F7');
    expect(formatBinding('')).toBe('Unassigned');
  });
});

describe('normalizeActionShortcuts', () => {
  it('fills every action from the defaults when the stored value is unusable', () => {
    expect(normalizeActionShortcuts(null)).toEqual(DEFAULT_POS_ACTION_SHORTCUTS);
  });

  it('keeps a valid override and repairs the rest', () => {
    const result = normalizeActionShortcuts({ pay: 'Ctrl+Enter', customer: '' });

    expect(result.pay).toBe('Ctrl+Enter');
    expect(result.customer).toBe(DEFAULT_POS_ACTION_SHORTCUTS.customer);
    expect(result.void).toBe('F11');
  });
});

describe('normalizeQuickKeys', () => {
  it('drops entries with no key, no product, or a scanner-unsafe key', () => {
    const result = normalizeQuickKeys([
      { id: 'a', binding: 'Ctrl+Digit1', productId: 'p1', sku: 'SKU1', label: 'One' },
      { id: 'b', binding: '', productId: 'p2', sku: 'SKU2', label: 'Unbound' },
      { id: 'c', binding: 'Ctrl+Digit2', productId: '', sku: '', label: 'No product' },
      { id: 'd', binding: 'Digit3', productId: 'p4', sku: 'SKU4', label: 'Bare digit' },
    ]);

    expect(result.map((quickKey) => quickKey.id)).toEqual(['a']);
  });

  it('keeps only the first claim on a duplicated key so dispatch is unambiguous', () => {
    const result = normalizeQuickKeys([
      { id: 'a', binding: 'Ctrl+Digit1', productId: 'p1', sku: 'SKU1', label: 'One' },
      { id: 'b', binding: 'Alt+Ctrl+Digit1', productId: 'p2', sku: 'SKU2', label: 'Two' },
      { id: 'c', binding: 'Ctrl+Digit1', productId: 'p3', sku: 'SKU3', label: 'Three' },
    ]);

    expect(result.map((quickKey) => quickKey.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(normalizeQuickKeys(undefined)).toEqual([]);
    expect(normalizeQuickKeys({ binding: 'F9' })).toEqual([]);
  });
});

describe('findShortcutConflicts', () => {
  it('reports a key claimed by both an action and a quick key', () => {
    const conflicts = findShortcutConflicts(
      { ...DEFAULT_POS_ACTION_SHORTCUTS },
      [{ id: 'a', binding: 'F9', productId: 'p1', sku: 'SKU1', label: 'Gold lace' }],
    );

    expect(conflicts.get('F9')).toEqual(['Refund', 'Gold lace']);
  });

  it('reports nothing when every binding is unique', () => {
    const conflicts = findShortcutConflicts(
      { ...DEFAULT_POS_ACTION_SHORTCUTS },
      [{ id: 'a', binding: 'Ctrl+Digit1', productId: 'p1', sku: 'SKU1', label: 'Gold lace' }],
    );

    expect(conflicts.size).toBe(0);
  });
});

describe('popupNumberIndex', () => {
  it('maps visible picker numbers to zero-based items', () => {
    expect(popupNumberIndex(keyEvent('Numpad1'))).toBe(0);
    expect(popupNumberIndex(keyEvent('Numpad9'))).toBe(8);
    expect(popupNumberIndex(keyEvent('Digit4'))).toBe(3);
  });

  it('does not steal modified numbers', () => {
    expect(popupNumberIndex(keyEvent('Numpad1', { altKey: true }))).toBeNull();
    expect(popupNumberIndex(keyEvent('Digit5', { ctrlKey: true }))).toBeNull();
  });
});

describe('denominationShortcutValue', () => {
  it('maps plain 5, 2 and 1 to the requested common notes', () => {
    expect(denominationShortcutValue(keyEvent('Numpad5'))).toBe(500);
    expect(denominationShortcutValue(keyEvent('Digit2'))).toBe(100);
    expect(denominationShortcutValue(keyEvent('Numpad1'))).toBe(50);
  });

  it('maps Alt to large notes and Ctrl to small denominations', () => {
    expect(denominationShortcutValue(keyEvent('Digit5', { altKey: true }))).toBe(5000);
    expect(denominationShortcutValue(keyEvent('Numpad2', { altKey: true }))).toBe(2000);
    expect(denominationShortcutValue(keyEvent('Digit1', { altKey: true }))).toBe(1000);
    expect(denominationShortcutValue(keyEvent('Numpad5', { ctrlKey: true }))).toBe(5);
    expect(denominationShortcutValue(keyEvent('Digit2', { ctrlKey: true }))).toBe(2);
    expect(denominationShortcutValue(keyEvent('Numpad1', { ctrlKey: true }))).toBe(1);
  });

  it('ignores unrelated and ambiguous modifier combinations', () => {
    expect(denominationShortcutValue(keyEvent('Digit9'))).toBeNull();
    expect(denominationShortcutValue(keyEvent('Digit5', { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe('normalizeShiftReconciliation', () => {
  it('keeps any combination of tenders the operator selected', () => {
    expect(normalizeShiftReconciliation({ declaredTenders: ['VISA', 'MASTER'] }).declaredTenders)
      .toEqual(['VISA', 'MASTER']);
    expect(normalizeShiftReconciliation({ declaredTenders: [] }).declaredTenders).toEqual([]);
  });

  it('stores the selection in a stable order regardless of how it was picked', () => {
    expect(normalizeShiftReconciliation({ declaredTenders: ['GIFT', 'VISA', 'AMEX'] }).declaredTenders)
      .toEqual(['VISA', 'AMEX', 'GIFT']);
  });

  it('drops unknown tender keys and duplicates', () => {
    expect(normalizeShiftReconciliation({ declaredTenders: ['VISA', 'VISA', 'BITCOIN'] }).declaredTenders)
      .toEqual(['VISA']);
  });

  it('collapses to the lump total when it is combined with individual methods', () => {
    // Declaring both would reconcile the same money twice in the overall figure.
    expect(normalizeShiftReconciliation({ declaredTenders: ['TOTAL', 'VISA'] }).declaredTenders)
      .toEqual(['TOTAL']);
  });

  it('migrates the older single-mode setting so an upgrade keeps behaving the same', () => {
    expect(normalizeShiftReconciliation({ tenderDeclarationMode: 'total' }).declaredTenders).toEqual(['TOTAL']);
    expect(normalizeShiftReconciliation({ tenderDeclarationMode: 'category' }).declaredTenders)
      .toEqual([...DECLARABLE_TENDER_METHODS]);
    expect(normalizeShiftReconciliation({ tenderDeclarationMode: 'off' }).declaredTenders).toEqual([]);
    expect(normalizeShiftReconciliation({ tenderDeclarationMode: 'nonsense' }).declaredTenders).toEqual([]);
  });

  it('prefers an explicit selection over the legacy mode', () => {
    expect(normalizeShiftReconciliation({
      declaredTenders: ['VISA'],
      tenderDeclarationMode: 'category',
    }).declaredTenders).toEqual(['VISA']);
  });

  it('rejects negative thresholds and keeps zero as an explicit off switch', () => {
    expect(normalizeShiftReconciliation({ alertThresholdAmount: -50 }).alertThresholdAmount).toBe(500);
    expect(normalizeShiftReconciliation({ alertThresholdAmount: 0 }).alertThresholdAmount).toBe(0);
    expect(normalizeShiftReconciliation({ alertThresholdPercent: 400 }).alertThresholdPercent).toBe(100);
  });
});
