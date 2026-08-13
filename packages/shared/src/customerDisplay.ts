import {
  DEFAULT_POS_CUSTOMER_DISPLAY,
  type POSCustomerDisplayLine,
  type POSCustomerDisplayMode,
  type POSCustomerDisplayPayment,
  type POSCustomerDisplaySettings,
  type POSCustomerDisplayState,
  type POSThemeMode,
} from './types';

/**
 * More lines than a customer screen can show at once. Snapshots arrive from a
 * hand-editable settings file, a browser storage key or an IPC message, so the
 * display never trusts the length it is handed.
 */
const MAX_DISPLAY_LINES = 200;

const DISPLAY_MODES: POSCustomerDisplayMode[] = ['idle', 'sale', 'payment', 'complete'];

function trimToLength(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function toMoney(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.round(parsed * 100) / 100;
}

function toQuantity(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.round(parsed * 1000) / 1000;
}

function toIsoDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function normalizeThemeMode(value: unknown): POSThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}

function clampSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  // Zero means "leave the completed sale up until the next one starts".
  return Math.min(600, Math.round(parsed));
}

export function normalizeCustomerDisplaySettings(value: unknown): POSCustomerDisplaySettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<POSCustomerDisplaySettings>;

  return {
    enabled: source.enabled === true,
    welcomeMessage: trimToLength(source.welcomeMessage, 120, DEFAULT_POS_CUSTOMER_DISPLAY.welcomeMessage),
    // A blank subtitle is a legitimate choice, so an empty string is kept as-is.
    welcomeSubtitle: typeof source.welcomeSubtitle === 'string'
      ? source.welcomeSubtitle.trim().slice(0, 200)
      : DEFAULT_POS_CUSTOMER_DISPLAY.welcomeSubtitle,
    thankYouMessage: trimToLength(source.thankYouMessage, 120, DEFAULT_POS_CUSTOMER_DISPLAY.thankYouMessage),
    storeName: typeof source.storeName === 'string' ? source.storeName.trim().slice(0, 80) : '',
    showCashierName: source.showCashierName !== false,
    completedSaleTimeoutSeconds: clampSeconds(
      source.completedSaleTimeoutSeconds,
      DEFAULT_POS_CUSTOMER_DISPLAY.completedSaleTimeoutSeconds,
    ),
  };
}

function normalizeLine(value: unknown, index: number): POSCustomerDisplayLine[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const source = value as Partial<POSCustomerDisplayLine>;
  const name = trimToLength(source.name, 120);
  if (!name) {
    return [];
  }

  return [{
    uid: trimToLength(source.uid, 64, `line-${index}`),
    name,
    variant: trimToLength(source.variant, 120) || undefined,
    quantity: toQuantity(source.quantity),
    unitPrice: toMoney(source.unitPrice),
    discountAmount: toMoney(source.discountAmount),
    lineTotal: toMoney(source.lineTotal),
  }];
}

function normalizePayment(value: unknown): POSCustomerDisplayPayment[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const source = value as Partial<POSCustomerDisplayPayment>;
  const method = trimToLength(source.method, 32);
  if (!method) {
    return [];
  }

  return [{
    method,
    label: trimToLength(source.label, 48, method),
    amount: toMoney(source.amount),
    tenderedAmount: source.tenderedAmount == null ? undefined : toMoney(source.tenderedAmount),
  }];
}

export function createIdleCustomerDisplayState(
  settings: POSCustomerDisplaySettings,
  overrides: Partial<POSCustomerDisplayState> = {},
): POSCustomerDisplayState {
  const now = new Date().toISOString();

  return {
    mode: 'idle',
    updatedAt: now,
    saleDate: now,
    storeName: settings.storeName,
    branchName: '',
    terminalCode: '',
    cashierName: '',
    customerName: '',
    receiptNumber: '',
    lines: [],
    itemCount: 0,
    subtotal: 0,
    discountTotal: 0,
    taxTotal: 0,
    total: 0,
    payments: [],
    amountPaid: 0,
    balanceDue: 0,
    changeDue: 0,
    welcomeMessage: settings.welcomeMessage,
    welcomeSubtitle: settings.welcomeSubtitle,
    thankYouMessage: settings.thankYouMessage,
    showCashierName: settings.showCashierName,
    themeMode: 'light',
    ...overrides,
  };
}

/**
 * Rebuilds a snapshot from whatever came off the wire, or returns null when the
 * payload is not a snapshot at all. Every field is clamped so a corrupt or
 * stale storage entry can only ever produce an empty-looking display, never a
 * broken render in front of a customer.
 */
export function parseCustomerDisplayState(value: unknown): POSCustomerDisplayState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Partial<POSCustomerDisplayState>;
  const mode = DISPLAY_MODES.includes(source.mode as POSCustomerDisplayMode)
    ? source.mode as POSCustomerDisplayMode
    : null;
  if (mode == null) {
    return null;
  }

  const now = new Date().toISOString();
  const updatedAt = toIsoDate(source.updatedAt, now);
  const lines = Array.isArray(source.lines)
    ? source.lines.slice(0, MAX_DISPLAY_LINES).flatMap(normalizeLine)
    : [];

  return {
    mode,
    updatedAt,
    saleDate: toIsoDate(source.saleDate, updatedAt),
    storeName: trimToLength(source.storeName, 80),
    branchName: trimToLength(source.branchName, 80),
    terminalCode: trimToLength(source.terminalCode, 32),
    cashierName: trimToLength(source.cashierName, 80),
    customerName: trimToLength(source.customerName, 80),
    receiptNumber: trimToLength(source.receiptNumber, 48),
    lines,
    itemCount: toQuantity(source.itemCount),
    subtotal: toMoney(source.subtotal),
    discountTotal: toMoney(source.discountTotal),
    taxTotal: toMoney(source.taxTotal),
    total: toMoney(source.total),
    payments: Array.isArray(source.payments)
      ? source.payments.slice(0, 20).flatMap(normalizePayment)
      : [],
    amountPaid: toMoney(source.amountPaid),
    balanceDue: toMoney(source.balanceDue),
    changeDue: toMoney(source.changeDue),
    welcomeMessage: trimToLength(source.welcomeMessage, 120, DEFAULT_POS_CUSTOMER_DISPLAY.welcomeMessage),
    welcomeSubtitle: typeof source.welcomeSubtitle === 'string'
      ? source.welcomeSubtitle.trim().slice(0, 200)
      : DEFAULT_POS_CUSTOMER_DISPLAY.welcomeSubtitle,
    thankYouMessage: trimToLength(source.thankYouMessage, 120, DEFAULT_POS_CUSTOMER_DISPLAY.thankYouMessage),
    showCashierName: source.showCashierName !== false,
    themeMode: normalizeThemeMode(source.themeMode),
  };
}
