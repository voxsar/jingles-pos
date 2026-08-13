import {
  CashCountMode,
  PaymentMethod,
  SaleStatus,
  ShiftStatus,
  SyncConflictPolicy,
  SyncConflictStatus,
  SyncEventState,
  SyncEventType,
  UserRole,
} from './enums';

export type VectorClock = Record<string, number>;

export interface Branch {
  id: string;
  code: string;
  name: string;
}

export interface Terminal {
  id: string;
  code: string;
  name: string;
  branchId: string;
  branchCode: string;
}

export interface POSUser {
  id: string;
  code: string;
  email?: string;
  name: string;
  initials: string;
  role: UserRole;
  pin?: string;
  hasPin?: boolean;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  tier: string;
  phone?: string;
  email?: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
}

export interface ProductPriceTier {
  id: string;
  label: string;
  price: number;
  priority: number;
  minQty?: number;
  isDefault?: boolean;
  costBasis?: number;
}

export interface POSPricingRule {
  id: string;
  name: string;
  type: 'percentage_discount' | 'fixed_discount' | 'percentage_markup' | 'fixed_markup';
  value: number;
  priority: number;
  stackable: boolean;
  skuIds?: string[];
  variantIds?: string[];
  categoryIds?: string[];
  branchIds?: string[];
  minQty?: number;
  maxQty?: number;
  validFrom?: string;
  validTo?: string;
}

export type ProductVariantAttributeType = 'dropdown' | 'text' | 'numeric' | 'boolean' | 'color';

export interface ProductVariantAttributeValue {
  attributeId: string;
  attributeName: string;
  attributeType?: ProductVariantAttributeType;
  valueId: string;
  value: string;
  representedValue?: string;
  sortOrder?: number;
}

export interface ProductVariant {
  id: string;
  productId: string;
  variantCode: string;
  name?: string;
  stockOnHand: number;
  stockByBranch?: Record<string, number>;
  priceTiers?: ProductPriceTier[];
  attributes: ProductVariantAttributeValue[];
}

export interface Product {
  id: string;
  sku: string;
  barcode?: string;
  name: string;
  categoryId: string;
  subcategory: string;
  packSize: number;
  unitLabel: string;
  stockOnHand: number;
  stockByBranch?: Record<string, number>;
  description?: string;
  priceTiers: ProductPriceTier[];
  variants?: ProductVariant[];
  pricingRules?: POSPricingRule[];
}

export interface SharedCatalogSnapshot {
  generatedAt: string;
  branches?: Branch[];
  users?: POSUser[];
  categories: Category[];
  products: Product[];
}

export interface CartLine {
  uid: string;
  productId: string;
  sku: string;
  name: string;
  barcode?: string;
  variantId?: string;
  variantCode?: string;
  variantName?: string;
  variantAttributes?: ProductVariantAttributeValue[];
  categoryId: string;
  subcategory: string;
  packSize: number;
  quantity: number;
  unitPrice: number;
  tierLabel: string;
  priceTiers: ProductPriceTier[];
  salespersonId: string;
  salespersonName: string;
  salespersonInitials: string;
  discountPercent: number;
  discountAmount: number;
  costBasis: number;
  stockOnHand: number;
  lineTotal: number;
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
  tenderedAmount?: number;
  changeDue?: number;
  reference?: string;
  metadata?: Record<string, unknown>;
}

/**
 * How much non-cash tender the cashier is asked to declare when opening or
 * closing a shift.
 *
 * - `off`       cash only, the historical behaviour.
 * - `total`     one lump figure covering every non-cash tender.
 * - `category`  a separate figure per payment method, so a card terminal
 *               settlement report can be reconciled line by line.
 */
export type POSTenderDeclarationMode = 'off' | 'total' | 'category';

export interface CashDeclaration {
  mode: CashCountMode;
  total: number;
  denominations: Record<string, number>;
  variance?: number;
  /**
   * Declared non-cash tender, keyed by `PaymentMethod` when the terminal
   * declares by category, or by the single key `TOTAL` when it declares a lump
   * sum. Absent when tender declaration is switched off.
   */
  tenders?: Record<string, number>;
  tenderMode?: POSTenderDeclarationMode;
}

/** The single bucket key used when non-cash tender is declared as one figure. */
export const TENDER_TOTAL_KEY = 'TOTAL';

export interface ShiftSummary {
  id: string;
  terminalId: string;
  branchId: string;
  cashierId: string;
  cashierName: string;
  status: ShiftStatus;
  openingFloat: number;
  closingFloat?: number;
  openedAt: string;
  closedAt?: string;
  notes?: string;
}

export interface HeldSaleLine {
  id: string;
  heldSaleId: string;
  productId: string;
  sku: string;
  name: string;
  variantId?: string;
  variantCode?: string;
  variantName?: string;
  variantAttributes?: ProductVariantAttributeValue[];
  subcategory: string;
  quantity: number;
  unitPrice: number;
  tierLabel: string;
  discountPercent: number;
  discountAmount: number;
  salespersonId: string;
  salespersonName: string;
  salespersonInitials: string;
  costBasis: number;
  lineTotal: number;
}

export interface HeldSaleSummary {
  id: string;
  holdNumber: string;
  terminalId: string;
  branchId: string;
  cashierId: string;
  cashierName: string;
  customerId?: string;
  customerName?: string;
  status: SaleStatus;
  subtotal: number;
  discountTotal: number;
  total: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  lines: HeldSaleLine[];
}

export interface SaleLineSummary {
  id: string;
  saleId: string;
  productId: string;
  sku: string;
  name: string;
  variantId?: string;
  variantCode?: string;
  variantName?: string;
  variantAttributes?: ProductVariantAttributeValue[];
  subcategory: string;
  quantity: number;
  unitPrice: number;
  tierLabel: string;
  discountPercent: number;
  discountAmount: number;
  salespersonId: string;
  salespersonName: string;
  salespersonInitials: string;
  costBasis: number;
  marginAmount: number;
  lineTotal: number;
}

export interface SaleSummary {
  id: string;
  receiptNumber: string;
  terminalId: string;
  branchId: string;
  cashierId: string;
  cashierName: string;
  customerId?: string;
  customerName?: string;
  shiftId?: string;
  status: SaleStatus;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  marginTotal: number;
  createdAt: string;
  updatedAt: string;
  lines: SaleLineSummary[];
  payments: PaymentInput[];
}

export interface ZReportSummary {
  shiftId: string;
  grossSales: number;
  discounts: number;
  refunds: number;
  netSales: number;
  transactionCount: number;
  paymentBreakdown: Record<string, number>;
  expectedDrawer: number;
  openingFloat: number;
  countedDrawer?: number;
  variance?: number;
  paymentCounts: Record<string, number>;
  discountedLineCount: number;
  productCount: number;
  /** Non-cash tender the cashier declared at close, keyed as in `CashDeclaration.tenders`. */
  declaredTenders?: Record<string, number>;
  declaredTenderMode?: POSTenderDeclarationMode;
}

export interface ZReportSlot {
  shift: ShiftSummary;
  report: ZReportSummary;
}

export interface ShiftOpenInput {
  terminalId: string;
  branchId: string;
  cashierId: string;
  openingFloat: number;
  notes?: string;
  declaration?: CashDeclaration;
}

export interface ShiftCloseInput {
  shiftId: string;
  closingFloat: number;
  notes?: string;
  declaration?: CashDeclaration;
}

export interface HoldSaleInput {
  holdNumber: string;
  terminalId: string;
  branchId: string;
  cashierId: string;
  customerId?: string;
  lines: CartLine[];
  discountTotal: number;
  subtotal: number;
  total: number;
}

export interface CompleteSaleInput {
  receiptNumber: string;
  terminalId: string;
  branchId: string;
  cashierId: string;
  customerId?: string;
  shiftId?: string;
  heldSaleId?: string;
  lines: CartLine[];
  payments: PaymentInput[];
  discountTotal: number;
  subtotal: number;
  taxTotal: number;
  total: number;
  marginTotal: number;
}

export interface ReturnInput {
  saleId: string;
  terminalId: string;
  cashierId: string;
  reason?: string;
  lines: Array<{
    saleLineId: string;
    productId: string;
    variantId?: string;
    quantity: number;
    refundAmount: number;
  }>;
}

export interface SyncEvent<TPayload = unknown> {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: SyncEventType;
  payload: TPayload;
  deviceId: string;
  sequenceNum: number;
  lamport: number;
  vectorClock: VectorClock;
  conflictPolicy: SyncConflictPolicy;
  state: SyncEventState;
  createdAt: string;
  appliedAt?: string;
}

export interface SyncConflict {
  id: string;
  aggregateType: string;
  aggregateId: string;
  localEventId?: string;
  remoteEventId?: string;
  policy: SyncConflictPolicy;
  status: SyncConflictStatus;
  detail?: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
}

export interface SyncStatusSummary {
  online: boolean;
  connectionMode?: 'lan' | 'cloud' | 'offline';
  connectionName?: string;
  activeEndpoint?: string;
  pendingEvents: number;
  conflictCount: number;
  deviceId: string;
  localVectorClock: VectorClock;
  remoteVectorClock: VectorClock;
  lastSyncAt?: string;
  lastError?: string;
  syncAuthConfigured?: boolean;
  syncAuthIdentity?: string;
  syncAuthMode?: 'app_token' | 'user_token';
  needsSyncAuth?: boolean;
  lastAttemptAt?: string;
  progress?: POSSyncProgress;
}

export interface POSSyncProgress {
  running: boolean;
  phase: 'idle' | 'connecting' | 'pushing' | 'pulling' | 'confirming' | 'catalog' | 'history' | 'complete' | 'failed';
  label: string;
  detail?: string;
  percent: number;
  startedAt?: string;
  updatedAt: string;
  accepted?: number;
  remoteApplied?: number;
  historyImported?: number;
  historyTotal?: number;
}

export interface POSAuthLoginInput {
  identifier: string;
  password: string;
}

export interface POSAuthResult {
  token: string;
  user: POSUser;
}

export interface POSSyncTokenResult {
  syncAuthConfigured: boolean;
  syncAuthIdentity?: string;
  userId?: string;
}

export type POSThemeMode = 'light' | 'dark';

/**
 * How the desktop app reaches a printer.
 *
 * - `network`  raw TCP socket, almost always port 9100 (Epson TM-i, Zebra ZT/ZD).
 * - `system`   a printer installed in the OS spooler, driven with a RAW datatype
 *              job so the vendor driver never rasterizes our ESC/POS or ZPL bytes.
 * - `device`   a character device or port written to directly, e.g. `/dev/usb/lp0`
 *              on Linux or `COM3` for serial-attached printers.
 */
export type POSPrinterTransport = 'network' | 'system' | 'device';

/** Command language spoken on the wire. */
export type POSPrinterLanguage = 'escpos' | 'zpl';

/** What the printer is used for. A terminal may have one of each. */
export type POSPrinterRole = 'receipt' | 'label';

export type POSBarcodeSymbology = 'CODE128' | 'CODE39' | 'EAN13';

export interface POSPrinterConfig {
  id: string;
  name: string;
  role: POSPrinterRole;
  language: POSPrinterLanguage;
  transport: POSPrinterTransport;
  /** Host or IP for `network`, spooler printer name for `system`, path for `device`. */
  address: string;
  port: number;
  enabled: boolean;
  isDefault: boolean;
  copies: number;
  /** Receipt printers: printable columns at font A. 42 at 80mm, 32 at 58mm. */
  columns: number;
  /** Receipt printers: send the partial-cut command after each job. */
  cutPaper: boolean;
  /** Receipt printers: pulse the cash drawer on pin 2 before cutting. */
  openDrawer: boolean;
  /** Label printers: media size and head resolution used to compute ZPL dots. */
  labelWidthMm: number;
  labelHeightMm: number;
  dpi: number;
  /** Label printers: darkness (^MD), -30..30. */
  darkness: number;
}

export interface POSScannerSettings {
  /** Capture scans globally, regardless of which element has focus. */
  enabled: boolean;
  /** Shortest run of characters that may be treated as a scan. */
  minLength: number;
  /** Longest gap between characters still considered part of one scan, in ms. */
  maxInterKeyMs: number;
  /** Only accept a buffer that ended with Enter or Tab. Rejects fast typists. */
  requireTerminator: boolean;
  /** Optional fixed prefix the scanner is programmed to emit; stripped on match. */
  prefix: string;
  /** Play a short tone when a scan resolves to a product. */
  beepOnScan: boolean;
}

/** A printer offered to the user by discovery, not yet configured. */
export interface POSDiscoveredPrinter {
  name: string;
  transport: POSPrinterTransport;
  address: string;
  port: number;
  description?: string;
  /** Best guess from the spooler name or reverse DNS. Users can override. */
  suggestedLanguage: POSPrinterLanguage;
  suggestedRole: POSPrinterRole;
  isSystemDefault: boolean;
  source: 'system' | 'network';
}

export interface POSPrinterDiscoveryResult {
  printers: POSDiscoveredPrinter[];
  scannedSubnets: string[];
  warnings: string[];
}

export type POSPrintBlock =
  | { type: 'text'; value: string; align?: 'left' | 'center' | 'right'; bold?: boolean; wide?: boolean }
  | { type: 'columns'; left: string; right: string; bold?: boolean; indent?: number }
  | { type: 'divider'; char?: string }
  | { type: 'feed'; lines?: number }
  | { type: 'barcode'; value: string; symbology?: POSBarcodeSymbology; height?: number; showText?: boolean }
  | { type: 'qr'; value: string; size?: number };

/** A device-independent receipt built by the renderer and encoded in the main process. */
export interface POSPrintDocument {
  title: string;
  blocks: POSPrintBlock[];
  openDrawer?: boolean;
  cut?: boolean;
  copies?: number;
}

export interface POSLabelDocument {
  title: string;
  sku: string;
  name: string;
  price?: string;
  barcode: string;
  symbology?: POSBarcodeSymbology;
  secondaryText?: string;
  copies?: number;
}

export interface POSPrintResult {
  ok: boolean;
  printerId?: string;
  printerName?: string;
  bytesSent?: number;
  message?: string;
}

/** Every workstation action a terminal may bind to a key. */
export type POSActionShortcutId =
  | 'help'
  | 'orders'
  | 'search'
  | 'hold'
  | 'recall'
  | 'discount'
  | 'customer'
  | 'pay'
  | 'quote'
  | 'refund'
  | 'void'
  | 'cashDrawer';

/**
 * A key binding, serialised as ordered modifiers followed by a `KeyboardEvent.code`,
 * e.g. `F7`, `Escape`, `Ctrl+Digit1`, `Alt+Numpad4`. `code` rather than `key` keeps
 * bindings stable across keyboard layouts and distinguishes the numpad, which is
 * the row a till operator actually reaches for.
 */
export type POSKeyBinding = string;

export type POSActionShortcuts = Record<POSActionShortcutId, POSKeyBinding>;

/** A product bound to a key so it can be rung up without searching for it. */
export interface POSQuickKey {
  id: string;
  binding: POSKeyBinding;
  productId: string;
  /** Denormalised so the settings list stays readable when the catalog is offline. */
  sku: string;
  label: string;
  variantId?: string;
}

export interface POSShortcutSettings {
  actions: POSActionShortcuts;
  quickKeysEnabled: boolean;
  quickKeys: POSQuickKey[];
}

export interface POSShiftReconciliationSettings {
  tenderDeclarationMode: POSTenderDeclarationMode;
  /** Absolute variance, in currency units, that counts as a large discrepancy. */
  alertThresholdAmount: number;
  /** Variance as a percentage of the expected figure that counts as a large discrepancy. */
  alertThresholdPercent: number;
  /** Require a manager-visible confirmation before a flagged shift can be closed. */
  requireConfirmationOnAlert: boolean;
}

export interface POSDesktopSettings {
  syncUrl: string;
  databasePath: string;
  backupDirectory: string;
  themeMode: POSThemeMode;
  addDenominationsToPaymentList: boolean;
  showDenominationCombinations: boolean;
  allowShortPayments: boolean;
  printers: POSPrinterConfig[];
  scanner: POSScannerSettings;
  shortcuts: POSShortcutSettings;
  shiftReconciliation: POSShiftReconciliationSettings;
}

export const DEFAULT_POS_ACTION_SHORTCUTS: POSActionShortcuts = {
  help: 'F1',
  orders: 'F2',
  search: 'F3',
  hold: 'F4',
  recall: 'F5',
  discount: 'F6',
  customer: 'F7',
  pay: 'F8',
  quote: 'F9',
  refund: 'F10',
  void: 'Escape',
  cashDrawer: 'F11',
};

export const DEFAULT_POS_SHORTCUT_SETTINGS: POSShortcutSettings = {
  actions: { ...DEFAULT_POS_ACTION_SHORTCUTS },
  quickKeysEnabled: true,
  quickKeys: [],
};

export const DEFAULT_POS_SHIFT_RECONCILIATION: POSShiftReconciliationSettings = {
  tenderDeclarationMode: 'off',
  alertThresholdAmount: 500,
  alertThresholdPercent: 2,
  requireConfirmationOnAlert: true,
};

export const DEFAULT_POS_SCANNER_SETTINGS: POSScannerSettings = {
  enabled: true,
  minLength: 4,
  maxInterKeyMs: 35,
  requireTerminator: true,
  prefix: '',
  beepOnScan: true,
};

export const DEFAULT_POS_PRINTER_CONFIG: Omit<POSPrinterConfig, 'id' | 'name'> = {
  role: 'receipt',
  language: 'escpos',
  transport: 'network',
  address: '',
  port: 9100,
  enabled: true,
  isDefault: false,
  copies: 1,
  columns: 42,
  cutPaper: true,
  openDrawer: false,
  labelWidthMm: 50,
  labelHeightMm: 25,
  dpi: 203,
  darkness: 0,
};

export interface POSDesktopSettingsSaveResult {
  settings: POSDesktopSettings;
  restartedBackend: boolean;
  copiedDatabase: boolean;
}

export interface POSDesktopBackupResult {
  filePath: string;
  createdAt: string;
}

export interface SyncHandshakeRequest {
  deviceId: string;
  terminalId: string;
  vectorClock: VectorClock;
}

export interface SyncPlaybackRequest {
  deviceId: string;
  terminalId: string;
  vectorClock: VectorClock;
  events: SyncEvent[];
}

export interface SyncPlaybackResponse {
  acceptedEventIds: string[];
  remoteEvents: SyncEvent[];
  serverVectorClock: VectorClock;
  conflicts: SyncConflict[];
}

export interface SyncConfirmRequest {
  deviceId: string;
  terminalId: string;
  vectorClock: VectorClock;
}

export interface POSBootstrap {
  branches: Branch[];
  terminals: Terminal[];
  users: POSUser[];
  customers: Customer[];
  categories: Category[];
  products: Product[];
  activeShift?: ShiftSummary | null;
  heldSales: HeldSaleSummary[];
  syncStatus: SyncStatusSummary;
}

export interface POSSyncDashboard {
  status: SyncStatusSummary;
  pendingEvents: SyncEvent[];
  recentEvents: SyncEvent[];
  conflicts: SyncConflict[];
}

export interface POSSyncRunResult {
  accepted: number;
  remoteApplied: number;
  conflicts: number;
  status: SyncStatusSummary;
}
