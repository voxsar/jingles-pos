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
  description?: string;
  priceTiers: ProductPriceTier[];
  variants?: ProductVariant[];
}

export interface SharedCatalogSnapshot {
  generatedAt: string;
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

export interface CashDeclaration {
  mode: CashCountMode;
  total: number;
  denominations: Record<string, number>;
  variance?: number;
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
  countedDrawer?: number;
  variance?: number;
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

export interface POSDesktopSettings {
  syncUrl: string;
  databasePath: string;
  backupDirectory: string;
  themeMode: POSThemeMode;
}

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
