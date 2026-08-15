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
  notes?: string;
  creditLimit: number;
}

export interface CreditPayment {
  id: string;
  customerId: string;
  amount: number;
  method: string;
  note?: string;
  terminalId?: string;
  userId?: string;
  userName?: string;
  shiftId?: string;
  createdAt: string;
}

export interface CustomerAccountDetail {
  customer: Customer;
  creditBalance: number;
  availableCredit: number;
  creditPayments: CreditPayment[];
}

export interface UpdateCustomerInput {
  creditLimit?: number;
  phone?: string;
  email?: string;
  notes?: string;
  tier?: string;
}

export interface RecordCreditPaymentInput {
  amount: number;
  method?: string;
  note?: string;
  terminalId?: string;
  userId?: string;
  shiftId?: string;
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
  customers?: Customer[];
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

/**
 * Cash added to or removed from the drawer part-way through a shift.
 *
 * Recorded as a `CASH_DECLARED` event against the open shift with a `PAID_IN`
 * or `PAID_OUT` count mode, so it lands in the same audited cash-count history
 * as the opening and closing declarations and is picked up by the expected-drawer
 * calculation. Without it, reloading change or dropping takings to the safe
 * shows up at close as an unexplained discrepancy.
 */
export interface CashMovementInput {
  shiftId: string;
  terminalId: string;
  cashierId: string;
  direction: 'in' | 'out';
  /** Free-text justification, required by the workstation before submitting. */
  reason: string;
  declaration: CashDeclaration;
  /**
   * Explicit permission to take out more than the drawer holds. The service
   * refuses an overdraw without it, so this must only be sent when the terminal
   * is configured to allow one.
   */
  allowOverdraw?: boolean;
}

/**
 * What the drawer is believed to physically hold right now, piece by piece.
 *
 * Derived from the opening count, mid-shift movements, and the denominations
 * recorded against each cash payment: notes taken in, notes handed back as
 * change. It is a belief, not a fact — a cashier who types a tendered amount
 * instead of tapping the note buttons leaves no breakdown behind, so those
 * amounts land in `unaccountedIn` / `unaccountedOut` and `exact` goes false.
 * Consumers must treat an inexact drawer as a hint, never as an authority.
 */
export interface DrawerContents {
  shiftId: string;
  /** Piece count keyed by denomination value, e.g. `{ "1000": 4, "50": 12 }`. */
  counts: Record<string, number>;
  /** Value of `counts` only; it excludes the unaccounted amounts below. */
  total: number;
  /** True when every contributing cash movement carried a denomination breakdown. */
  exact: boolean;
  /** Cash known to have entered the drawer with no recorded breakdown. */
  unaccountedIn: number;
  /** Cash known to have left the drawer with no recorded breakdown. */
  unaccountedOut: number;
}

export interface CashMovementSummary {
  id: string;
  shiftId: string;
  direction: 'in' | 'out';
  amount: number;
  reason?: string;
  denominations: Record<string, number>;
  createdAt: string;
}

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
  /** Cash added to the drawer mid-shift (change reloads, float top-ups). */
  cashPaidIn: number;
  /** Cash removed from the drawer mid-shift (safe drops, payouts). */
  cashPaidOut: number;
  countedDrawer?: number;
  variance?: number;
  paymentCounts: Record<string, number>;
  discountedLineCount: number;
  productCount: number;
  /** Non-cash tender the cashier declared at close, keyed as in `CashDeclaration.tenders`. */
  declaredTenders?: Record<string, number>;
  declaredTenderMode?: POSTenderDeclarationMode;
  /** Mid-shift drawer movements, oldest first, so a close can be explained. */
  cashMovements: CashMovementSummary[];
  /** Cheque and bank-transfer audit trail, including origin details captured at checkout. */
  paymentDetails?: Array<{
    saleId: string;
    receiptNumber: string;
    customerId?: string;
    customerName?: string;
    method: string;
    amount: number;
    reference?: string;
    bankName?: string;
    origin?: string;
    reason?: string;
    createdAt: string;
  }>;
  /** CREDIT-tender sales charged to customers during this shift. */
  customerCreditSales?: Array<{
    saleId: string;
    receiptNumber: string;
    customerId?: string;
    customerName: string;
    amount: number;
    createdAt: string;
  }>;
  /** Customer bill collections recorded during this shift. */
  customerCollections?: Array<{
    paymentId: string;
    customerId: string;
    customerName: string;
    amount: number;
    method: string;
    note?: string;
    userName?: string;
    createdAt: string;
  }>;
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
  /**
   * True when the declaration cleared the reconciliation alert threshold.
   * The cashier is never shown this — it exists so the discrepancy can be
   * queued for back-office review in the inventory system instead.
   */
  flagged?: boolean;
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
  | 'cashDrawer'
  | 'cashMovement'
  | 'staff'
  | 'unit'
  | 'tier'
  | 'discountValue'
  | 'discountPercent'
  | 'closePopup';

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

/**
 * The pole display / second screen the customer reads while the cashier bills.
 *
 * The workstation is the only writer: it pushes a full snapshot of what the
 * customer should see on every change, so the display window holds no billing
 * logic of its own and can be closed and reopened at any point in a sale.
 */
export interface POSCustomerDisplaySettings {
  /** Open the display automatically when the workstation starts. */
  enabled: boolean;
  /** Headline shown between sales. */
  welcomeMessage: string;
  /** Secondary line under the headline. */
  welcomeSubtitle: string;
  /** Headline shown while the completed-sale summary is up. */
  thankYouMessage: string;
  /** Name the display heads with; blank falls back to the branch name. */
  storeName: string;
  /** Show the serving cashier in the display header. */
  showCashierName: boolean;
  /** Seconds a completed sale stays on screen before the welcome message returns. */
  completedSaleTimeoutSeconds: number;
}

/**
 * What the customer display is currently showing.
 *
 * - `idle`      welcome message, no sale in progress.
 * - `sale`      lines are being rung up.
 * - `payment`   the payment window is open; tender and balance are live.
 * - `complete`  the sale closed; totals, payments and change stay up briefly.
 */
export type POSCustomerDisplayMode = 'idle' | 'sale' | 'payment' | 'complete';

export interface POSCustomerDisplayLine {
  uid: string;
  name: string;
  /** Variant summary, e.g. `Red / XL`, when the line is for a specific variant. */
  variant?: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface POSCustomerDisplayPayment {
  method: string;
  label: string;
  amount: number;
  tenderedAmount?: number;
}

/**
 * A complete snapshot of the customer-facing screen.
 *
 * Presentation settings travel with the snapshot rather than being read
 * separately by the display window, so a freshly opened window renders the
 * configured welcome message from the first frame it receives.
 */
export interface POSCustomerDisplayState {
  mode: POSCustomerDisplayMode;
  /** When the workstation produced this snapshot, ISO-8601. */
  updatedAt: string;
  /** Sale timestamp for `complete`, otherwise the time the bill was started. */
  saleDate: string;
  storeName: string;
  branchName: string;
  terminalCode: string;
  cashierName: string;
  customerName: string;
  /** Receipt number, known only once the sale is committed. */
  receiptNumber: string;
  lines: POSCustomerDisplayLine[];
  itemCount: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  payments: POSCustomerDisplayPayment[];
  amountPaid: number;
  balanceDue: number;
  changeDue: number;
  welcomeMessage: string;
  welcomeSubtitle: string;
  thankYouMessage: string;
  showCashierName: boolean;
  themeMode: POSThemeMode;
}

export interface POSCustomerDisplayStatus {
  /** False in a browser, where the workstation opens a popup window instead. */
  supported: boolean;
  open: boolean;
  /** Attached monitors, so the settings screen can say where the display lands. */
  displayCount: number;
}

export interface POSShiftReconciliationSettings {
  /**
   * Which tender buckets the cashier declares at close, as `PaymentMethod`
   * values and/or `TENDER_TOTAL_KEY`. Any combination may be selected — a shop
   * that only reconciles its two card machines picks just those.
   *
   * Empty means cash only. `TENDER_TOTAL_KEY` cannot be combined with specific
   * methods, because declaring both would count the same money twice; the
   * normaliser drops the individual methods if both are present.
   */
  declaredTenders: string[];
  /** Absolute variance, in currency units, that counts as a large discrepancy. */
  alertThresholdAmount: number;
  /** Variance as a percentage of the expected figure that counts as a large discrepancy. */
  alertThresholdPercent: number;
  /** Require a manager-visible confirmation before a flagged shift can be closed. */
  requireConfirmationOnAlert: boolean;
  /**
   * Allow a cash-out that takes more than the drawer is believed to hold, or
   * more of a denomination than it has. Off by default: taking out money that
   * is not there means either the count is wrong or the drawer is, and both
   * need looking at rather than recording. Turning this on is an explicit
   * override and every use of it is noted against the shift.
   */
  allowDrawerOverdraw: boolean;
}

export interface POSCashSalesVisibilitySettings {
  /**
   * Whether cash sales, revealed via the triple Ctrl tap, re-hide themselves
   * automatically. Off means a reveal stays in effect until the cashier hides
   * it again by hand.
   */
  autoHideEnabled: boolean;
  /** Minutes a reveal stays visible before {@link autoHideEnabled} hides it again. */
  autoHideMinutes: number;
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
  customerDisplay: POSCustomerDisplaySettings;
  cashSalesVisibility: POSCashSalesVisibilitySettings;
}

/**
 * Defaults line up with the legacy MaxSoft till's key sheet wherever this app
 * has a matching action (F3 Search, F5 Bill Hold, F6 Hold Recall, F7 Drawer
 * Open, F9 Refund, F11 Cancel, F12 Paid In/Out), so an operator moving over
 * keeps their muscle memory. The legacy sheet's bare symbol keys (~ for
 * Customer, [ ] \ for Discount) move to Alt+letter instead of an unmodified
 * key, matching this app's own scanner-safety rule (see
 * `isValidQuickKeyBinding`): an unmodified key is indistinguishable from the
 * first character of a barcode scan. Two legacy keys have no equivalent
 * action yet and so aren't bound: F8 Select Printer (printers are configured
 * in Settings, not a runtime action) and F10 Money Declare (folded into
 * `cashDrawer`, which already opens the money-declare view before a shift is
 * open and the drawer once one is).
 */
export const DEFAULT_POS_ACTION_SHORTCUTS: POSActionShortcuts = {
  help: 'F1',
  orders: 'F2',
  search: 'F3',
  quote: 'F4',
  hold: 'F5',
  recall: 'F6',
  cashDrawer: 'F7',
  refund: 'F9',
  void: 'F11',
  cashMovement: 'F12',
  customer: 'Alt+KeyC',
  discount: 'Alt+KeyD',
  staff: 'KeyS',
  unit: 'KeyU',
  tier: 'KeyT',
  discountValue: 'BracketLeft',
  discountPercent: 'BracketRight',
  closePopup: 'Backslash',
  pay: 'NumpadAdd',
};

export const DEFAULT_POS_SHORTCUT_SETTINGS: POSShortcutSettings = {
  actions: { ...DEFAULT_POS_ACTION_SHORTCUTS },
  quickKeysEnabled: true,
  quickKeys: [],
};

export const DEFAULT_POS_SHIFT_RECONCILIATION: POSShiftReconciliationSettings = {
  declaredTenders: [],
  alertThresholdAmount: 500,
  alertThresholdPercent: 2,
  requireConfirmationOnAlert: true,
  allowDrawerOverdraw: false,
};

/**
 * Cash sales stay hidden by default (a triple Ctrl tap reveals them for the
 * cashier), and a reveal re-hides itself after five minutes unless a
 * manager turns that off in Settings.
 */
export const DEFAULT_POS_CASH_SALES_VISIBILITY: POSCashSalesVisibilitySettings = {
  autoHideEnabled: true,
  autoHideMinutes: 5,
};

/** Tender types a cashier can be asked to declare alongside the cash count. */
export const DECLARABLE_TENDER_METHODS: PaymentMethod[] = [
  PaymentMethod.VISA,
  PaymentMethod.MASTER,
  PaymentMethod.AMEX,
  PaymentMethod.CREDIT,
  PaymentMethod.GIFT,
  PaymentMethod.INSTALLMENT,
  PaymentMethod.CHEQUE,
  PaymentMethod.BANK_TRANSFER,
];

export const DEFAULT_POS_CUSTOMER_DISPLAY: POSCustomerDisplaySettings = {
  enabled: false,
  welcomeMessage: 'Welcome',
  welcomeSubtitle: 'Please wait while we serve you.',
  thankYouMessage: 'Thank you for shopping with us',
  storeName: '',
  showCashierName: true,
  completedSaleTimeoutSeconds: 20,
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

/** A backup triggered from a file-save dialog, so the user can cancel it. */
export interface POSDesktopBackupAsResult {
  canceled: boolean;
  filePath: string | null;
  createdAt: string | null;
}

/** Mirrors the desktop inventory app's replica-switch modes. */
export type POSDatabaseSwitchMode = 'new' | 'existing' | 'default';

export interface POSDatabaseInfo {
  currentPath: string;
  defaultPath: string;
  directory: string;
  exists: boolean;
  sizeBytes: number;
  lastModifiedAt: string | null;
  usesCustomPath: boolean;
}

export interface POSDatabaseSwitchResult {
  canceled: boolean;
  mode: POSDatabaseSwitchMode;
  selectedPath: string | null;
  copiedDatabase: boolean;
}

export interface SyncHandshakeRequest {
  deviceId: string;
  terminalId: string;
  vectorClock: VectorClock;
  users?: POSUser[];
  customers?: Customer[];
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
