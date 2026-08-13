import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CashCountMode,
  CartLine,
  CompleteSaleInput,
  Customer,
  HeldSaleSummary,
  POSCustomerDisplaySettings,
  POSCustomerDisplayStatus,
  POSDesktopSettings,
  POSDiscoveredPrinter,
  POSPrintResult,
  POSPrinterConfig,
  POSPrinterRole,
  POSPrinterTransport,
  POSScannerSettings,
  POSThemeMode,
  POSSyncRunResult,
  PaymentInput,
  PaymentMethod,
  POSBootstrap,
  POSUser,
  Product,
  ProductPriceTier,
  ProductVariant,
  ReturnInput,
  SaleSummary,
  ShiftSummary,
  SyncStatusSummary,
  UserRole,
  ZReportSummary,
  ZReportSlot,
  POSActionShortcutId,
  POSActionShortcuts,
  POSQuickKey,
  POSShiftReconciliationSettings,
  POSShortcutSettings,
  POSTenderDeclarationMode,
  ACTION_SHORTCUT_IDS,
  bindingFromEvent,
  bindingMatchesEvent,
  createQuickKeyId,
  formatBinding,
  isValidQuickKeyBinding,
  normalizeBinding,
  normalizeCustomerDisplaySettings,
  normalizeShiftReconciliation,
  normalizeShortcutSettings,
  QUICK_KEY_BINDING_HINT,
  TENDER_TOTAL_KEY,
  DECLARABLE_TENDER_METHODS,
  DEFAULT_POS_ACTION_SHORTCUTS,
  DEFAULT_POS_CUSTOMER_DISPLAY,
  DEFAULT_POS_SCANNER_SETTINGS,
  DEFAULT_POS_SHIFT_RECONCILIATION,
  DEFAULT_POS_SHORTCUT_SETTINGS,
  DEFAULT_TERMINAL_ID,
} from '@jingles/shared';
import {
  bootstrapPOS,
  closeShift,
  createReturn,
  createSale,
  endActiveShift,
  getZReport,
  listZReportSlots,
  listHeldSales,
  listSales,
  openShift,
  recallHeldSale,
  recordCashMovement,
  saveHeldSale,
  searchProducts,
  subscribeSyncStatus,
  syncNow,
} from './api';
import { useAuth } from './auth/AuthContext';
import HelpGuide from './help/HelpGuide';
import SearchableSelect, { type SearchableSelectHandle } from './components/SearchableSelect';
import {
  closeCustomerDisplay,
  hasCustomerDisplayBridge,
  openCustomerDisplay,
  persistCustomerDisplaySettings,
  publishCustomerDisplayState,
  subscribeCustomerDisplayStatus,
} from './customerDisplay';
import {
  buildCartDisplayState,
  buildCompletedSaleDisplayState,
  type CustomerDisplayContext,
  type CustomerDisplayPaymentProgress,
} from './utils/customerDisplay';
import {
  buildFallbackDesktopSettings,
  createDesktopBackup,
  createPrinterDraft,
  hasDesktopSettingsBridge,
  loadDesktopSettings,
  persistThemeMode,
  pickDesktopBackupDirectory,
  pickDesktopDatabasePath,
  readStoredThemeMode,
  saveDesktopSettings as saveDesktopSettingsToBridge,
  withPrinterUpdate,
} from './desktopSettings';
import {
  buildProductLabelDocument,
  buildQuotationDocument,
  buildReceiptDocument,
  buildZReportDocument,
  discoverPrinters,
  hasPrintingBridge,
  printLabelDocument,
  printReceiptDocument,
  testPrinter,
} from './printing';
import { useBarcodeScanner } from './useBarcodeScanner';
import {
  buildCashDeclaration,
  calcCartTotals,
  createCartLine,
  createEmptyDenominationCounts,
  DENOMINATIONS,
  formatCurrency,
  formatDateTime,
  formatDenominationBreakdown,
  formatInteger,
  formatShiftReference,
  formatTime,
  generateHoldNumber,
  generateReceiptNumber,
  getLineVariantSummary,
  getProductVariantLabel,
  getNameInitials,
  NON_CASH_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  pickPriceTier,
  recalculateCartLine,
  resolveDefaultCustomerId,
  saleIncludesCash,
  suggestChangeBreakdowns,
  suggestTenderTopUps,
  summarizeShiftReconciliation,
  type ShiftReconciliation,
} from './utils/pos';
import { ACTION_SHORTCUT_HINTS, ACTION_SHORTCUT_LABELS, findShortcutConflicts } from './utils/shortcuts';
import { useNavigate } from 'react-router-dom';

type Notice = {
  type: 'success' | 'error';
  text: string;
} | null;

type SessionState = {
  user: POSUser;
  branchId: string;
  terminalId: string;
};

type CatalogCategoryTile = {
  id: string;
  name: string;
  icon: string;
  chip: string;
  count: number;
  subcategoryCount: number;
};

type CatalogSubcategoryTile = {
  name: string;
  chip: string;
  count: number;
};

type HoldMode = 'hold' | 'recall';
type MoneyModalMode = 'open' | 'close';

type VariantSelectionRequest = {
  initialVariantId?: string | null;
  lineId?: string | null;
  product: Product;
};

const DEFAULT_CATALOG_PANE_WIDTH = 62;
const MIN_CATALOG_PANE_WIDTH = 38;
const MAX_CATALOG_PANE_WIDTH = 72;
const MIN_CATALOG_PANEL_PX = 420;
const MIN_CART_PANEL_PX = 380;
const PANEL_RESIZER_WIDTH = 16;

const PAYMENT_OPTIONS: Array<{ method: PaymentMethod; label: string; short: string }> = [
  { method: PaymentMethod.CASH, label: 'Cash', short: 'CA' },
  { method: PaymentMethod.VISA, label: 'Visa', short: 'VI' },
  { method: PaymentMethod.MASTER, label: 'Master', short: 'MC' },
  { method: PaymentMethod.AMEX, label: 'Amex', short: 'AX' },
  { method: PaymentMethod.CREDIT, label: 'Credit', short: 'CR' },
  { method: PaymentMethod.GIFT, label: 'Gift voucher', short: 'GV' },
  { method: PaymentMethod.INSTALLMENT, label: 'Installment plan', short: 'IN' },
];

function clampCatalogPaneWidth(nextWidth: number, containerWidth: number | undefined): number {
  if (containerWidth == null || containerWidth <= 0) {
    return Math.min(MAX_CATALOG_PANE_WIDTH, Math.max(MIN_CATALOG_PANE_WIDTH, nextWidth));
  }

  const minWidth = Math.max(MIN_CATALOG_PANE_WIDTH, (MIN_CATALOG_PANEL_PX / containerWidth) * 100);
  const maxWidth = Math.min(
    MAX_CATALOG_PANE_WIDTH,
    ((containerWidth - MIN_CART_PANEL_PX - PANEL_RESIZER_WIDTH) / containerWidth) * 100,
  );

  if (!Number.isFinite(minWidth) || !Number.isFinite(maxWidth) || minWidth >= maxWidth) {
    return Math.min(MAX_CATALOG_PANE_WIDTH, Math.max(MIN_CATALOG_PANE_WIDTH, nextWidth));
  }

  return Math.min(maxWidth, Math.max(minWidth, nextWidth));
}

export default function PosWorkstation() {
  const navigate = useNavigate();
  const { logout, user: authUser } = useAuth();
  const [bootstrapData, setBootstrapData] = useState<POSBootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [loadedTerminalId, setLoadedTerminalId] = useState(DEFAULT_TERMINAL_ID);
  const [isLoading, setIsLoading] = useState(true);

  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [selectedTerminalId, setSelectedTerminalId] = useState(DEFAULT_TERMINAL_ID);
  const [session, setSession] = useState<SessionState | null>(null);

  const [activeShift, setActiveShift] = useState<ShiftSummary | null>(null);
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [hideCashSales, setHideCashSales] = useState(
    () => window.sessionStorage.getItem('jingles-pos-hide-cash-sales') === 'true',
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatusSummary | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [defaultTierLabel, setDefaultTierLabel] = useState('');
  const [billDiscount, setBillDiscount] = useState(0);
  const [activeCategoryId, setActiveCategoryId] = useState('all');
  const [activeSubcategory, setActiveSubcategory] = useState<string | null>(null);
  const [hideOutOfStock, setHideOutOfStock] = useState(false);
  const [catalogPaneWidth, setCatalogPaneWidth] = useState(DEFAULT_CATALOG_PANE_WIDTH);
  const [isResizingCatalogPane, setIsResizingCatalogPane] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [variantSelection, setVariantSelection] = useState<VariantSelectionRequest | null>(null);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isHoldOpen, setIsHoldOpen] = useState(false);
  const [holdMode, setHoldMode] = useState<HoldMode>('hold');
  const [moneyMode, setMoneyMode] = useState<MoneyModalMode | null>(null);
  const [isZOpen, setIsZOpen] = useState(false);
  const [zReport, setZReport] = useState<ZReportSummary | null>(null);
  const [isZReportLoading, setIsZReportLoading] = useState(false);
  const [zReportError, setZReportError] = useState('');
  const [isCashMovementOpen, setIsCashMovementOpen] = useState(false);
  const [isSavingCashMovement, setIsSavingCashMovement] = useState(false);
  const [isReturnOpen, setIsReturnOpen] = useState(false);
  const [isOrdersOpen, setIsOrdersOpen] = useState(false);
  const [isVoidOpen, setIsVoidOpen] = useState(false);
  const [voidLineId, setVoidLineId] = useState<string | null>(null);
  const [activeHeldSaleId, setActiveHeldSaleId] = useState<string | null>(null);
  const [receiptSale, setReceiptSale] = useState<SaleSummary | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [appliedThemeMode, setAppliedThemeMode] = useState<POSThemeMode>(() => readStoredThemeMode());
  const [desktopSettings, setDesktopSettings] = useState<POSDesktopSettings | null>(() => (
    buildFallbackDesktopSettings(readStoredThemeMode())
  ));
  const [settingsDraft, setSettingsDraft] = useState<POSDesktopSettings | null>(() => (
    buildFallbackDesktopSettings(readStoredThemeMode())
  ));
  const [chromeOffsets, setChromeOffsets] = useState({ top: 136, bottom: 140 });
  const [customerDisplayStatus, setCustomerDisplayStatus] = useState<POSCustomerDisplayStatus>(
    () => ({ supported: hasCustomerDisplayBridge(), open: false, displayCount: 0 }),
  );
  // Live tender while the payment window is open, mirrored to the customer.
  const [paymentProgress, setPaymentProgress] = useState<CustomerDisplayPaymentProgress | null>(null);
  // The sale the customer display is showing after a bill closes. Kept separate
  // from `receiptSale`, which also holds reprints pulled from order history.
  const [completedDisplaySale, setCompletedDisplaySale] = useState<SaleSummary | null>(null);
  const [billStartedAt, setBillStartedAt] = useState<string | null>(null);

  const discountInputRef = useRef<HTMLInputElement>(null);
  const customerSelectRef = useRef<SearchableSelectHandle>(null);
  const headerBarRef = useRef<HTMLElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const workstationGridRef = useRef<HTMLDivElement>(null);
  const controlPressCountRef = useRef(0);
  // Signature of the last snapshot sent to the customer display, so identical
  // redraws are not republished.
  const lastPublishedDisplayRef = useRef<string | null>(null);
  const controlPressTimerRef = useRef<number | null>(null);
  // The window listener is installed once; shortcut dispatch is read through a
  // ref so every keystroke sees the current cart, shift and settings without
  // tearing down and re-adding the listener on each render.
  const dispatchShortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});

  const showNotice = useCallback((type: 'success' | 'error', text: string) => {
    setNotice({ type, text });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = appliedThemeMode;
    persistThemeMode(appliedThemeMode);
  }, [appliedThemeMode]);

  const loadDesktopSettingsIntoState = useCallback(async () => {
    const fallback = buildFallbackDesktopSettings(readStoredThemeMode());
    if (!hasDesktopSettingsBridge()) {
      setDesktopSettings(fallback);
      setSettingsDraft(fallback);
      return fallback;
    }

    const loaded = await loadDesktopSettings();
    setDesktopSettings(loaded);
    setSettingsDraft(loaded);
    setAppliedThemeMode(loaded.themeMode);
    return loaded;
  }, []);

  const clampPaneWidth = useCallback((nextWidth: number) => {
    const containerWidth = workstationGridRef.current?.getBoundingClientRect().width;
    return clampCatalogPaneWidth(nextWidth, containerWidth);
  }, []);

  const updateCatalogPaneWidthFromClientX = useCallback((clientX: number) => {
    const rect = workstationGridRef.current?.getBoundingClientRect();
    if (rect == null || rect.width <= PANEL_RESIZER_WIDTH) {
      return;
    }

    const nextWidth = ((clientX - rect.left) / rect.width) * 100;
    setCatalogPaneWidth(clampCatalogPaneWidth(nextWidth, rect.width));
  }, []);

  const handleCatalogPaneResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 1380px)').matches) {
      return;
    }

    event.preventDefault();
    setIsResizingCatalogPane(true);
    updateCatalogPaneWidthFromClientX(event.clientX);
  }, [updateCatalogPaneWidthFromClientX]);

  const handleCatalogPaneResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setCatalogPaneWidth((previous) => clampPaneWidth(previous - 3));
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setCatalogPaneWidth((previous) => clampPaneWidth(previous + 3));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setCatalogPaneWidth(clampPaneWidth(MIN_CATALOG_PANE_WIDTH));
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setCatalogPaneWidth(clampPaneWidth(MAX_CATALOG_PANE_WIDTH));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      setCatalogPaneWidth(clampPaneWidth(DEFAULT_CATALOG_PANE_WIDTH));
    }
  }, [clampPaneWidth]);

  useEffect(() => {
    if (authUser == null) {
      setSession(null);
    }
  }, [authUser]);

  useEffect(() => {
    void loadDesktopSettingsIntoState().catch(() => {
      setDesktopSettings(buildFallbackDesktopSettings(readStoredThemeMode()));
      setSettingsDraft(buildFallbackDesktopSettings(readStoredThemeMode()));
    });
  }, [loadDesktopSettingsIntoState]);

  useEffect(() => {
    if (!isResizingCatalogPane) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      updateCatalogPaneWidthFromClientX(event.clientX);
    };
    const stopResizing = () => {
      setIsResizingCatalogPane(false);
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    window.addEventListener('pointercancel', stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
    };
  }, [isResizingCatalogPane, updateCatalogPaneWidthFromClientX]);

  useEffect(() => {
    const updateChromeOffsets = () => {
      setChromeOffsets({
        top: (headerBarRef.current?.offsetHeight ?? 112) + 8,
        bottom: (actionBarRef.current?.offsetHeight ?? 108) + 8,
      });
    };

    updateChromeOffsets();
    window.addEventListener('resize', updateChromeOffsets);

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        window.removeEventListener('resize', updateChromeOffsets);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateChromeOffsets();
    });

    if (headerBarRef.current != null) {
      resizeObserver.observe(headerBarRef.current);
    }

    if (actionBarRef.current != null) {
      resizeObserver.observe(actionBarRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateChromeOffsets);
    };
  }, []);

  const currentTerminalId = session?.terminalId ?? selectedTerminalId ?? loadedTerminalId ?? DEFAULT_TERMINAL_ID;

  const branches = bootstrapData?.branches ?? [];
  const terminals = bootstrapData?.terminals ?? [];
  const users = bootstrapData?.users ?? [];
  const customers = bootstrapData?.customers ?? [];
  const products = bootstrapData?.products ?? [];
  const heldSales = bootstrapData?.heldSales ?? [];

  const branchTerminals = useMemo(
    () => terminals.filter((terminal) => terminal.branchId === selectedBranchId),
    [selectedBranchId, terminals],
  );

  const salespeople = useMemo(() => {
    const rows = users.filter((user) => user.role === UserRole.SALESPERSON);
    if (rows.length > 0) {
      return rows;
    }
    return users.filter((user) => user.role === UserRole.CASHIER);
  }, [users]);

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const catalogProducts = useMemo(
    () => hideOutOfStock ? products.filter((product) => product.stockOnHand > 0) : products,
    [hideOutOfStock, products],
  );
  const productsWithVariants = useMemo(
    () => new Set(products.filter((product) => (product.variants?.length ?? 0) > 0).map((product) => product.id)),
    [products],
  );
  const customerMap = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const categoryTiles = useMemo<CatalogCategoryTile[]>(() => {
    const counts = new Map<string, number>();
    const subcategoriesByCategory = new Map<string, Set<string>>();

    for (const product of catalogProducts) {
      counts.set(product.categoryId, (counts.get(product.categoryId) ?? 0) + 1);
      if (product.subcategory) {
        const bucket = subcategoriesByCategory.get(product.categoryId) ?? new Set<string>();
        bucket.add(product.subcategory);
        subcategoriesByCategory.set(product.categoryId, bucket);
      }
    }

    const sorted = [...(bootstrapData?.categories ?? [])]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((category) => ({
        ...category,
        chip: category.icon || getCategoryToken(category.name),
        count: counts.get(category.id) ?? 0,
        subcategoryCount: subcategoriesByCategory.get(category.id)?.size ?? 0,
      }));

    return [
      {
        id: 'all',
        name: 'All Items',
        icon: 'AL',
        sortOrder: 0,
        chip: 'AL',
        count: catalogProducts.length,
        subcategoryCount: sorted.length,
      },
      ...sorted,
    ];
  }, [bootstrapData?.categories, catalogProducts]);

  const subcategoryTiles = useMemo<CatalogSubcategoryTile[]>(() => {
    if (activeCategoryId === 'all') {
      return [];
    }

    const counts = new Map<string, number>();
    for (const product of catalogProducts) {
      if (product.categoryId !== activeCategoryId || !product.subcategory) {
        continue;
      }
      counts.set(product.subcategory, (counts.get(product.subcategory) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({
        name,
        chip: getCategoryToken(name),
        count,
      }));
  }, [activeCategoryId, catalogProducts]);

  const visibleProducts = useMemo(() => {
    let rows = [...catalogProducts];
    if (activeCategoryId !== 'all') {
      rows = rows.filter((product) => product.categoryId === activeCategoryId);
    }
    if (activeSubcategory) {
      rows = rows.filter((product) => product.subcategory === activeSubcategory);
    }

    return rows.sort((left, right) => left.sku.localeCompare(right.sku));
  }, [activeCategoryId, activeSubcategory, catalogProducts]);

  const activeCategory = useMemo(
    () => categoryTiles.find((category) => category.id === activeCategoryId) ?? categoryTiles[0] ?? null,
    [activeCategoryId, categoryTiles],
  );

  const defaultCustomerId = useMemo(() => resolveDefaultCustomerId(customers), [customers]);
  const selectedCustomer = customers.find((customer) => customer.id === customerId)
    ?? customers.find((customer) => customer.id === defaultCustomerId)
    ?? null;

  const defaultTierOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const product of products) {
      for (const tier of product.priceTiers) {
        labels.add(tier.label);
      }
    }
    return [...labels].sort((left, right) => left.localeCompare(right));
  }, [products]);

  const totals = useMemo(() => calcCartTotals(cart, billDiscount), [billDiscount, cart]);

  const customerDisplaySettings = desktopSettings?.customerDisplay ?? DEFAULT_POS_CUSTOMER_DISPLAY;

  const customerDisplayContext = useMemo<CustomerDisplayContext>(() => ({
    settings: customerDisplaySettings,
    themeMode: appliedThemeMode,
    branchName: branches.find((branch) => branch.id === (session?.branchId ?? selectedBranchId))?.name ?? '',
    terminalCode: resolveTerminalCode(terminals, currentTerminalId),
    cashierName: session?.user.name ?? authUser?.name ?? '',
    customerName: selectedCustomer?.name ?? '',
    saleStartedAt: billStartedAt ?? undefined,
  }), [
    appliedThemeMode,
    authUser?.name,
    billStartedAt,
    branches,
    currentTerminalId,
    customerDisplaySettings,
    selectedBranchId,
    selectedCustomer?.name,
    session,
    terminals,
  ]);

  useEffect(() => subscribeCustomerDisplayStatus(setCustomerDisplayStatus), []);

  // Tender only exists while the payment window is open; every route out of it
  // — cancel, sign-out, a closed shift — takes the display back to the bill.
  useEffect(() => {
    if (!isPaymentOpen) {
      setPaymentProgress(null);
    }
  }, [isPaymentOpen]);

  // A bill's date is the moment the first line was rung up, not the moment the
  // display last redrew.
  useEffect(() => {
    setBillStartedAt((previous) => {
      if (cart.length === 0) {
        return null;
      }

      return previous ?? new Date().toISOString();
    });
  }, [cart.length]);

  /**
   * Mirrors the bill onto the customer display. The workstation is the only
   * writer: every change to the cart, the tender or the display settings
   * republishes a whole snapshot, so a display opened part-way through a sale
   * is never left showing a stale bill.
   */
  useEffect(() => {
    if (!customerDisplaySettings.enabled && !customerDisplayStatus.open) {
      return;
    }

    const state = completedDisplaySale
      ? buildCompletedSaleDisplayState(customerDisplayContext, completedDisplaySale)
      : buildCartDisplayState(customerDisplayContext, cart, totals, paymentProgress);

    // Renders that change nothing the customer can see — a resize, a catalog
    // filter — must not put the display through another storage write.
    const signature = JSON.stringify({ ...state, updatedAt: '' });
    if (signature === lastPublishedDisplayRef.current) {
      return;
    }

    lastPublishedDisplayRef.current = signature;
    publishCustomerDisplayState(state);
  }, [
    cart,
    completedDisplaySale,
    customerDisplayContext,
    customerDisplaySettings.enabled,
    customerDisplayStatus.open,
    paymentProgress,
    totals,
  ]);

  // The completed sale stays up for its dwell time, or until the cashier starts
  // the next bill. A dwell of zero means "leave it until the next sale".
  useEffect(() => {
    if (completedDisplaySale == null) {
      return undefined;
    }

    if (cart.length > 0) {
      setCompletedDisplaySale(null);
      return undefined;
    }

    const dwellSeconds = customerDisplaySettings.completedSaleTimeoutSeconds;
    if (dwellSeconds <= 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => setCompletedDisplaySale(null), dwellSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [cart.length, completedDisplaySale, customerDisplaySettings.completedSaleTimeoutSeconds]);

  const handleToggleCustomerDisplay = useCallback(async () => {
    try {
      const status = customerDisplayStatus.open
        ? await closeCustomerDisplay()
        : await openCustomerDisplay();
      setCustomerDisplayStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open the customer display';
      showNotice('error', message);
    }
  }, [customerDisplayStatus.open, showNotice]);

  const visibleSales = useMemo(
    () => hideCashSales ? sales.filter((sale) => !saleIncludesCash(sale)) : sales,
    [hideCashSales, sales],
  );
  const todaySales = useMemo(
    () => visibleSales.filter((sale) => sale.terminalId === currentTerminalId && isToday(sale.createdAt)),
    [currentTerminalId, visibleSales],
  );
  const todayRevenue = useMemo(
    () => todaySales.reduce((sum, sale) => sum + sale.total, 0),
    [todaySales],
  );

  const syncBadge = useMemo(() => formatSyncBadge(syncStatus), [syncStatus]);

  const reloadBootstrap = useCallback(
    async (terminalId: string, options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setIsLoading(true);
      }
      setBootError('');

      try {
        const data = await bootstrapPOS({ terminalId });
        const resolvedTerminal = data.terminals.find((item) => item.id === terminalId) ?? data.terminals[0] ?? null;
        const resolvedBranchId = resolvedTerminal?.branchId ?? data.branches[0]?.id ?? '';

        setBootstrapData(data);
        setLoadedTerminalId(resolvedTerminal?.id ?? terminalId);
        setSelectedTerminalId((previous) => previous || resolvedTerminal?.id || terminalId);
        setSelectedBranchId((previous) => previous || resolvedBranchId);
        const walkInId = resolveDefaultCustomerId(data.customers);
        const walkIn = data.customers.find((customer) => customer.id === walkInId);
        setCustomerId((previous) => previous || walkInId);
        setDefaultTierLabel((previous) => previous || walkIn?.tier || 'Retail');
        setActiveShift(data.activeShift ?? null);
        setSyncStatus(data.syncStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load POS workstation';
        setBootError(message);
      } finally {
        if (!options.silent) {
          setIsLoading(false);
        }
      }
    },
    [],
  );

  const reloadSales = useCallback(async () => {
    setSalesLoading(true);
    try {
      const rows = await listSales({
        terminalId: authUser?.role === UserRole.MANAGER ? undefined : currentTerminalId,
        limit: 1000,
      });
      setSales(rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load sales history';
      showNotice('error', message);
    } finally {
      setSalesLoading(false);
    }
  }, [authUser?.role, currentTerminalId, showNotice]);

  const refreshWorkspace = useCallback(
    async (options: { includeSales?: boolean } = {}) => {
      await reloadBootstrap(currentTerminalId, { silent: true });
      if (options.includeSales) {
        await reloadSales();
      }
      try {
        const refreshedHeldSales = await listHeldSales();
        setBootstrapData((previous) => previous ? { ...previous, heldSales: refreshedHeldSales } : previous);
      } catch {
        // Silent refresh path; bootstrap already carries held sales in normal cases.
      }
    },
    [currentTerminalId, reloadBootstrap, reloadSales],
  );

  const handleOpenSettings = useCallback(async () => {
    setIsSettingsOpen(true);
    setIsSettingsLoading(true);

    try {
      const loaded = await loadDesktopSettingsIntoState();
      setSettingsDraft(loaded);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load workstation settings';
      showNotice('error', message);
    } finally {
      setIsSettingsLoading(false);
    }
  }, [loadDesktopSettingsIntoState, showNotice]);

  const handleSaveSettings = useCallback(async () => {
    if (settingsDraft == null) {
      return;
    }

    setIsSettingsSaving(true);

    // Half-finished quick keys — a product picked but no key recorded yet — and
    // any binding the recorder could not validate are dropped here rather than
    // written out, so what is stored is always what the key handler can dispatch.
    const normalizedDraft: POSDesktopSettings = {
      ...settingsDraft,
      shortcuts: normalizeShortcutSettings(settingsDraft.shortcuts),
      shiftReconciliation: normalizeShiftReconciliation(settingsDraft.shiftReconciliation),
      customerDisplay: normalizeCustomerDisplaySettings(settingsDraft.customerDisplay),
    };

    try {
      if (hasDesktopSettingsBridge()) {
        const result = await saveDesktopSettingsToBridge(normalizedDraft);
        setDesktopSettings(result.settings);
        setSettingsDraft(result.settings);
        setAppliedThemeMode(result.settings.themeMode);
        await refreshWorkspace({ includeSales: true });
        showNotice(
          'success',
          result.restartedBackend
            ? `Settings saved. The local backend restarted${result.copiedDatabase ? ' and copied the current database to the new path' : ''}.`
            : 'Settings saved.',
        );
      } else {
        setDesktopSettings(normalizedDraft);
        setSettingsDraft(normalizedDraft);
        setAppliedThemeMode(normalizedDraft.themeMode);
        // Most desktop settings have nowhere to persist to in a browser, but the
        // customer display is driven entirely from this window, so its wording
        // and behaviour are kept in local storage the way the theme is.
        persistCustomerDisplaySettings(normalizedDraft.customerDisplay);
        showNotice(
          'success',
          'Settings applied for this browser session. Customer display settings were saved for this browser.',
        );
      }

      setIsSettingsOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save workstation settings';
      showNotice('error', message);
    } finally {
      setIsSettingsSaving(false);
    }
  }, [refreshWorkspace, settingsDraft, showNotice]);

  const handlePickDatabaseLocation = useCallback(async () => {
    if (settingsDraft == null) {
      return;
    }

    try {
      const filePath = await pickDesktopDatabasePath(settingsDraft.databasePath);
      if (filePath) {
        setSettingsDraft((previous: POSDesktopSettings | null) => (
          previous ? { ...previous, databasePath: filePath } : previous
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pick a database file';
      showNotice('error', message);
    }
  }, [settingsDraft, showNotice]);

  const handlePickBackupDirectory = useCallback(async () => {
    if (settingsDraft == null) {
      return;
    }

    try {
      const directoryPath = await pickDesktopBackupDirectory(settingsDraft.backupDirectory);
      if (directoryPath) {
        setSettingsDraft((previous: POSDesktopSettings | null) => (
          previous ? { ...previous, backupDirectory: directoryPath } : previous
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pick a backup directory';
      showNotice('error', message);
    }
  }, [settingsDraft, showNotice]);

  const handleCreateBackup = useCallback(async () => {
    setIsCreatingBackup(true);

    try {
      const result = await createDesktopBackup();
      showNotice('success', `Backup created at ${result.filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create a database backup';
      showNotice('error', message);
    } finally {
      setIsCreatingBackup(false);
    }
  }, [showNotice]);

  useEffect(() => {
    void reloadBootstrap(DEFAULT_TERMINAL_ID);
  }, [reloadBootstrap]);

  useEffect(() => {
    if (notice == null) {
      return undefined;
    }

    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (bootstrapData == null || session != null) {
      return;
    }

    if (selectedBranchId && selectedTerminalId && loadedTerminalId === selectedTerminalId) {
      return;
    }

    if (selectedTerminalId && selectedTerminalId !== loadedTerminalId) {
      void reloadBootstrap(selectedTerminalId, { silent: true });
    }
  }, [bootstrapData, loadedTerminalId, reloadBootstrap, selectedBranchId, selectedTerminalId, session]);

  useEffect(() => {
    if (bootstrapData == null || session != null) {
      return;
    }

    if (selectedBranchId && branchTerminals.some((terminal) => terminal.id === selectedTerminalId)) {
      return;
    }

    const fallbackTerminal = branchTerminals[0];
    if (fallbackTerminal) {
      setSelectedTerminalId(fallbackTerminal.id);
    }
  }, [bootstrapData, branchTerminals, selectedBranchId, selectedTerminalId, session]);

  useEffect(() => {
    const unsubscribe = subscribeSyncStatus((status) => setSyncStatus(status));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (session == null) {
      return;
    }

    void reloadSales();
  }, [reloadSales, session]);

  useEffect(() => {
    const handleCashVisibility = (event: Event) => {
      const hidden = Boolean((event as CustomEvent<{ hidden?: boolean }>).detail?.hidden);
      setHideCashSales(hidden);
    };
    window.addEventListener('jingles:cash-visibility', handleCashVisibility);
    return () => window.removeEventListener('jingles:cash-visibility', handleCashVisibility);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (session != null && event.key === 'Control' && !event.repeat) {
        controlPressCountRef.current += 1;
        if (controlPressTimerRef.current != null) {
          window.clearTimeout(controlPressTimerRef.current);
        }

        if (controlPressCountRef.current >= 3) {
          controlPressCountRef.current = 0;
          setHideCashSales((previous) => {
            const next = !previous;
            window.sessionStorage.setItem('jingles-pos-hide-cash-sales', String(next));
            showNotice('success', next ? 'Cash sales are hidden.' : 'Cash sales are visible.');
            return next;
          });
        } else {
          controlPressTimerRef.current = window.setTimeout(() => {
            controlPressCountRef.current = 0;
            controlPressTimerRef.current = null;
          }, 1000);
        }
        return;
      }

      if (event.key !== 'Control') {
        controlPressCountRef.current = 0;
        if (controlPressTimerRef.current != null) {
          window.clearTimeout(controlPressTimerRef.current);
          controlPressTimerRef.current = null;
        }
      }

      dispatchShortcutRef.current(event);
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      if (controlPressTimerRef.current != null) {
        window.clearTimeout(controlPressTimerRef.current);
        controlPressTimerRef.current = null;
      }
    };
  }, [session, showNotice]);

  const closeOverlayStack = useCallback(() => {
    setIsSearchOpen(false);
    setVariantSelection(null);
    setIsPaymentOpen(false);
    setIsHoldOpen(false);
    setMoneyMode(null);
    setIsZOpen(false);
    setIsReturnOpen(false);
    setIsOrdersOpen(false);
    setIsVoidOpen(false);
    setIsCashMovementOpen(false);
    setReceiptSale(null);
    setIsSettingsOpen(false);
    setSettingsDraft(desktopSettings);
  }, [desktopSettings]);

  const handleStartSession = useCallback(() => {
    if (bootstrapData == null || authUser == null) {
      return;
    }

    const terminal = terminals.find((candidate) => candidate.id === selectedTerminalId);
    if (terminal == null) {
      showNotice('error', 'Select a terminal before entering the workstation.');
      return;
    }

    if (activeShift != null && activeShift.cashierId !== authUser.id) {
      showNotice('error', `Terminal ${terminal.code} already has an active shift.`);
      return;
    }

    setSession({
      user: authUser,
      branchId: terminal.branchId,
      terminalId: terminal.id,
    });

    if (activeShift == null) {
      setMoneyMode('open');
      showNotice('success', `Ready on ${terminal.code}. Open the shift to begin billing.`);
    } else {
      showNotice('success', `Entered ${terminal.code} as ${authUser.name}.`);
    }
  }, [
    activeShift,
    authUser,
    bootstrapData,
    selectedTerminalId,
    showNotice,
    terminals,
  ]);

  const handleSignOut = useCallback(async () => {
    if (session != null && activeShift != null) {
      showNotice('error', 'Close the active shift before signing out.');
      return;
    }

    setSession(null);
    setCart([]);
    setBillDiscount(0);
    setActiveHeldSaleId(null);
    setReceiptSale(null);
    setIsSearchOpen(false);
    setIsPaymentOpen(false);
    setIsHoldOpen(false);
    await logout();
    navigate('/login', { replace: true });
  }, [activeShift, logout, navigate, session, showNotice]);

  const handleEndActiveSession = useCallback(async () => {
    if (activeShift == null || authUser?.role !== UserRole.MANAGER) {
      return;
    }

    const terminal = terminals.find((candidate) => candidate.id === selectedTerminalId);
    const confirmed = window.confirm(
      `End ${activeShift.cashierName}'s active session on ${terminal?.code ?? 'this terminal'}? `
      + 'Completed sales will be kept and the action will be recorded.',
    );
    if (!confirmed) {
      return;
    }

    try {
      await endActiveShift(activeShift.id, selectedTerminalId);
      setActiveShift(null);
      showNotice('success', 'The abandoned shift was ended. This terminal is available again.');
      await reloadBootstrap(selectedTerminalId, { silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to end the active session';
      showNotice('error', message);
    }
  }, [activeShift, authUser?.role, reloadBootstrap, selectedTerminalId, showNotice, terminals]);

  const handleCustomerChange = useCallback((nextCustomerId: string) => {
    const nextCustomer = customerMap.get(nextCustomerId);
    setCustomerId(nextCustomerId);
    if (nextCustomer != null) {
      setDefaultTierLabel(nextCustomer.tier);
    }
  }, [customerMap]);

  /** Returns a finished or abandoned bill to the walk-in account and its tier. */
  const resetCustomerToDefault = useCallback(() => {
    setCustomerId(defaultCustomerId);
    setDefaultTierLabel(customerMap.get(defaultCustomerId)?.tier ?? 'Retail');
  }, [customerMap, defaultCustomerId]);

  const preferredTierLabels = useMemo(() => ([
    defaultTierLabel,
    selectedCustomer?.tier ?? '',
    'Retail',
  ].filter(Boolean)), [defaultTierLabel, selectedCustomer?.tier]);

  const addProductToCart = useCallback((product: Product, variant?: ProductVariant) => {
    const salesperson = salespeople[0] ?? users[0];
    if (salesperson == null) {
      showNotice('error', 'No cashier or salesperson is configured for the workstation.');
      return;
    }

    setCart((previous) => {
      const availableStock = variant?.stockOnHand ?? product.stockOnHand;
      if (availableStock <= 0) {
        showNotice('error', `${variant?.variantCode ?? product.sku} is out of stock.`);
        return previous;
      }
      const effectivePriceTiers = variant?.priceTiers?.length ? variant.priceTiers : product.priceTiers;
      const tier = pickPriceTier(effectivePriceTiers, preferredTierLabels);
      const existing = previous.find((line) => (
        line.productId === product.id
        && (line.variantId ?? null) === (variant?.id ?? null)
        && line.tierLabel === tier.label
      ));
      if (existing) {
        if (existing.quantity >= availableStock) {
          showNotice('error', `Only ${formatInteger(availableStock)} unit(s) are available.`);
          return previous;
        }
        return previous.map((line) => (
          line.uid === existing.uid
            ? recalculateCartLine({
              ...line,
              quantity: line.quantity + 1,
              stockOnHand: variant?.stockOnHand ?? product.stockOnHand,
            })
            : line
        ));
      }

      return [...previous, createCartLine(product, salesperson, preferredTierLabels, variant)];
    });
  }, [preferredTierLabels, salespeople, showNotice, users]);

  const updateCartLineById = useCallback((lineId: string, updater: (line: CartLine) => CartLine | null) => {
    setCart((previous) => previous.flatMap((line) => {
      if (line.uid !== lineId) {
        return [line];
      }

      const updated = updater(line);
      return updated == null ? [] : [updated];
    }));
  }, []);

  const applyVariantToCartLine = useCallback((
    lineId: string,
    product: Product,
    variant: ProductVariant,
  ) => {
    updateCartLineById(lineId, (line) => {
      const effectivePriceTiers = variant.priceTiers?.length ? variant.priceTiers : product.priceTiers;
      const tier = pickPriceTier(effectivePriceTiers, [line.tierLabel, ...preferredTierLabels]);
      return recalculateCartLine({
        ...line,
        sku: variant.variantCode,
        name: product.name,
        barcode: product.barcode,
        variantId: variant.id,
        variantCode: variant.variantCode,
        variantName: variant.name ?? undefined,
        variantAttributes: variant.attributes,
        categoryId: product.categoryId,
        subcategory: product.subcategory,
        packSize: product.packSize,
        unitPrice: tier.price,
        tierLabel: tier.label,
        priceTiers: effectivePriceTiers,
        stockOnHand: variant.stockOnHand,
      });
    });
  }, [preferredTierLabels, updateCartLineById]);

  const handleProductPick = useCallback((product: Product) => {
    if ((product.variants?.length ?? 0) > 0) {
      setVariantSelection({
        product,
        initialVariantId: product.variants?.[0]?.id ?? null,
      });
      return;
    }

    addProductToCart(product);
  }, [addProductToCart]);

  /**
   * Lookup table for scanned codes. Variant codes are registered too, so a
   * scanner pointed at a variant label drops that exact variant into the cart
   * without opening the variant picker.
   */
  const productsByScanCode = useMemo(() => {
    const index = new Map<string, { product: Product; variant?: ProductVariant }>();

    const register = (code: string | undefined | null, entry: { product: Product; variant?: ProductVariant }) => {
      const key = code?.trim().toLowerCase();
      if (key && !index.has(key)) {
        index.set(key, entry);
      }
    };

    for (const product of products) {
      register(product.barcode, { product });
      register(product.sku, { product });

      for (const variant of product.variants ?? []) {
        register(variant.variantCode, { product, variant });
      }
    }

    return index;
  }, [products]);

  const handleBarcodeScan = useCallback((code: string) => {
    const match = productsByScanCode.get(code.trim().toLowerCase());

    if (!match) {
      showNotice('error', `No product matches scanned code ${code}.`);
      return;
    }

    if (match.variant) {
      addProductToCart(match.product, match.variant);
      return;
    }

    handleProductPick(match.product);
  }, [addProductToCart, handleProductPick, productsByScanCode, showNotice]);

  const scannerSettings = desktopSettings?.scanner ?? DEFAULT_POS_SCANNER_SETTINGS;
  const shortcutSettings: POSShortcutSettings = desktopSettings?.shortcuts ?? DEFAULT_POS_SHORTCUT_SETTINGS;
  const actionShortcuts = shortcutSettings.actions;
  const shiftReconciliationSettings: POSShiftReconciliationSettings =
    desktopSettings?.shiftReconciliation ?? DEFAULT_POS_SHIFT_RECONCILIATION;

  const hasLabelPrinter = useMemo(() => (
    (desktopSettings?.printers ?? []).some((printer) => printer.enabled && printer.role === 'label')
  ), [desktopSettings]);

  const hasReceiptPrinter = useMemo(() => (
    (desktopSettings?.printers ?? []).some((printer) => printer.enabled && printer.role === 'receipt')
  ), [desktopSettings]);

  // Read inside the sale callback, so adding a printer takes effect on the next
  // sale without rebuilding the checkout handler.
  const hasReceiptPrinterRef = useRef(false);
  hasReceiptPrinterRef.current = hasReceiptPrinter;

  useBarcodeScanner({
    // Modals with their own text entry keep the scanner out of the way; the
    // search overlay opts in separately through data-scanner-passthrough.
    enabled: session != null && !isSettingsOpen && !isHelpOpen,
    settings: scannerSettings,
    onScan: handleBarcodeScan,
  });

  /** Surfaces the outcome of a print job, including the browser-dialog fallback. */
  const reportPrintResult = useCallback((result: POSPrintResult) => {
    if (result.ok) {
      showNotice('success', result.message ?? `Sent to ${result.printerName ?? 'the printer'}.`);
      return;
    }

    showNotice('error', result.message ?? 'Printing failed.');
  }, [showNotice]);

  const handlePrintProductLabel = useCallback(async (product: Product, variant?: ProductVariant) => {
    const result = await printLabelDocument(buildProductLabelDocument(product, {
      variantCode: variant?.variantCode,
      price: (variant?.priceTiers?.length ? variant.priceTiers : product.priceTiers)[0]?.price,
    }));

    showNotice(
      result.ok ? 'success' : 'error',
      result.ok
        ? `Label sent to ${result.printerName ?? 'the label printer'}.`
        : result.message ?? 'Label printing failed.',
    );
  }, [showNotice]);

  const handleLineVariantChange = useCallback((lineId: string) => {
    const line = cart.find((entry) => entry.uid === lineId);
    if (!line) {
      return;
    }

    const product = productMap.get(line.productId);
    if (!product || (product.variants?.length ?? 0) === 0) {
      showNotice('error', 'No variants are available for this product.');
      return;
    }

    setVariantSelection({
      product,
      lineId,
      initialVariantId: line.variantId ?? product.variants?.[0]?.id ?? null,
    });
  }, [cart, productMap, showNotice]);

  const handleVariantSelectionComplete = useCallback((variant: ProductVariant) => {
    if (variantSelection == null) {
      return;
    }

    if (variantSelection.lineId) {
      applyVariantToCartLine(variantSelection.lineId, variantSelection.product, variant);
    } else {
      addProductToCart(variantSelection.product, variant);
    }

    setVariantSelection(null);
  }, [addProductToCart, applyVariantToCartLine, variantSelection]);

  const handleOpenShift = useCallback(async (submission: MoneyDeclareSubmission) => {
    if (session == null) {
      return;
    }

    try {
      const declaration = buildCashDeclaration(CashCountMode.OPENING, submission.counts);
      const shift = await openShift({
        terminalId: session.terminalId,
        branchId: session.branchId,
        cashierId: session.user.id,
        openingFloat: declaration.total,
        declaration,
      });

      setActiveShift(shift);
      setMoneyMode(null);
      showNotice('success', 'Shift opened.');
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open shift';
      showNotice('error', message);
    }
  }, [refreshWorkspace, session, showNotice]);

  const handleCloseShift = useCallback(async (submission: MoneyDeclareSubmission) => {
    if (session == null || activeShift == null) {
      return;
    }

    const declaration = buildCashDeclaration(CashCountMode.CLOSING, submission.counts, {
      tenders: submission.tenders,
      declaredTenders: submission.declaredTenders,
      variance: submission.variance,
    });

    // A flagged shift is still allowed to close — the cashier may genuinely be
    // short — but the discrepancy has to be acknowledged rather than clicked past,
    // and it is written into the shift notes so the close is auditable.
    const reconciliation = zReport == null
      ? null
      : summarizeShiftReconciliation(zReport, declaration, shiftReconciliationSettings);
    let notes: string | undefined;

    if (reconciliation?.hasAlert) {
      const detail = reconciliation.flaggedRows
        .map((row) => `${row.label}: declared ${formatCurrency(row.declared)} vs ${formatCurrency(row.expected)} expected (${formatCurrency(row.variance)})`)
        .join('\n');
      notes = `Closed with a flagged discrepancy:\n${detail}`;

      if (shiftReconciliationSettings.requireConfirmationOnAlert) {
        const confirmed = window.confirm(
          `This declaration does not match the transaction log:\n\n${detail}\n\nClose the shift anyway? The discrepancy will be recorded against it.`,
        );
        if (!confirmed) {
          return;
        }
      }
    }

    try {
      await closeShift({
        shiftId: activeShift.id,
        terminalId: session.terminalId,
        closingFloat: declaration.total,
        notes,
        declaration,
      });

      setMoneyMode(null);
      setActiveShift(null);
      setCart([]);
      setBillDiscount(0);
      setActiveHeldSaleId(null);
      setSession(null);
      showNotice('success', 'Shift closed. Session ended.');
      await refreshWorkspace({ includeSales: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close shift';
      showNotice('error', message);
    }
  }, [activeShift, refreshWorkspace, session, shiftReconciliationSettings, showNotice, zReport]);

  const handleOpenHoldModal = useCallback((mode: HoldMode) => {
    setHoldMode(mode);
    setIsHoldOpen(true);
  }, []);

  const handleSaveHeldSale = useCallback(async () => {
    if (session == null) {
      return;
    }
    if (cart.length === 0) {
      showNotice('error', 'Add items to the cart before holding the bill.');
      return;
    }

    try {
      const heldSale = await saveHeldSale({
        holdNumber: generateHoldNumber(resolveTerminalCode(terminals, session.terminalId)),
        terminalId: session.terminalId,
        branchId: session.branchId,
        cashierId: session.user.id,
        customerId: selectedCustomer?.id,
        lines: cart,
        discountTotal: billDiscount,
        subtotal: totals.rawSubtotal,
        total: totals.total,
      });

      setCart([]);
      setBillDiscount(0);
      setActiveHeldSaleId(null);
      resetCustomerToDefault();
      setBootstrapData((previous) => previous
        ? { ...previous, heldSales: [heldSale, ...previous.heldSales.filter((sale) => sale.id !== heldSale.id)] }
        : previous);
      showNotice('success', `Held bill ${heldSale.holdNumber}.`);
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to hold bill';
      showNotice('error', message);
    }
  }, [billDiscount, cart, refreshWorkspace, resetCustomerToDefault, selectedCustomer?.id, session, showNotice, terminals, totals.rawSubtotal, totals.total]);

  const handleRecallHeldSale = useCallback(async (heldSale: HeldSaleSummary) => {
    const fallbackSalesperson = salespeople[0] ?? users[0];
    if (fallbackSalesperson == null) {
      showNotice('error', 'No user is available to restore the held bill.');
      return;
    }

    try {
      const recalled = await recallHeldSale(heldSale.id);
      const restoredCart = recalled.lines.map((line) => {
        const product = productMap.get(line.productId);
        const variant = product?.variants?.find((entry) => entry.id === line.variantId);
        const tier = product != null
          ? pickPriceTier(product.priceTiers, [line.tierLabel])
          : { id: `${line.id}-tier`, label: line.tierLabel, price: line.unitPrice, priority: 0 };

        const salesperson = userMap.get(line.salespersonId) ?? fallbackSalesperson;

        return recalculateCartLine({
          uid: line.id,
          productId: line.productId,
          sku: line.sku,
          name: line.name,
          barcode: product?.barcode,
          variantId: line.variantId,
          variantCode: line.variantCode,
          variantName: line.variantName,
          variantAttributes: line.variantAttributes,
          categoryId: product?.categoryId ?? 'uncategorized',
          subcategory: line.subcategory,
          packSize: product?.packSize ?? 1,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          tierLabel: tier.label,
          priceTiers: product?.priceTiers ?? [tier],
          salespersonId: salesperson.id,
          salespersonName: salesperson.name,
          salespersonInitials: salesperson.initials,
          discountPercent: line.discountPercent,
          discountAmount: line.discountAmount,
          costBasis: line.costBasis,
          stockOnHand: variant?.stockOnHand ?? product?.stockOnHand ?? line.quantity,
          lineTotal: line.lineTotal,
        });
      });

      setCart(restoredCart);
      setCustomerId(recalled.customerId ?? defaultCustomerId);
      setBillDiscount(recalled.discountTotal);
      setActiveHeldSaleId(recalled.id);
      setIsHoldOpen(false);
      showNotice('success', `Recalled ${recalled.holdNumber}.`);
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to recall held bill';
      showNotice('error', message);
    }
  }, [customers, productMap, refreshWorkspace, salespeople, showNotice, userMap, users]);

  const handleCompleteSale = useCallback(async (payments: PaymentInput[]) => {
    if (session == null) {
      return;
    }

    if (activeShift == null) {
      showNotice('error', 'Open a shift before taking payment.');
      return;
    }

    if (cart.length === 0) {
      showNotice('error', 'Cart is empty.');
      return;
    }

    const payload: CompleteSaleInput = {
      receiptNumber: generateReceiptNumber(resolveTerminalCode(terminals, session.terminalId)),
      terminalId: session.terminalId,
      branchId: session.branchId,
      cashierId: session.user.id,
      customerId: selectedCustomer?.id,
      shiftId: activeShift.id,
      heldSaleId: activeHeldSaleId ?? undefined,
      lines: cart,
      payments,
      discountTotal: totals.discountTotal,
      subtotal: totals.rawSubtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      marginTotal: totals.margin,
    };

    try {
      const sale = await createSale(payload);
      setReceiptSale(sale);
      // What the customer reads back: their items, what they paid and the
      // change owed. Replaces the live bill on the display until it times out.
      setCompletedDisplaySale(sale);
      setPaymentProgress(null);
      setIsPaymentOpen(false);
      setCart([]);
      setBillDiscount(0);
      setActiveHeldSaleId(null);
      // Leaving the last customer selected would quietly bill the next walk-in
      // against their account, and price the next bill at their tier.
      resetCustomerToDefault();
      showNotice('success', `Sale ${sale.receiptNumber} completed.`);

      // Push the receipt at a configured printer without stealing the screen
      // with a print dialog. The modal's Print button covers reprints.
      if (hasReceiptPrinterRef.current) {
        const printResult = await printReceiptDocument(
          buildReceiptDocument(sale, resolveTerminalCode(terminals, session.terminalId)),
          { allowBrowserFallback: false },
        );

        if (!printResult.ok) {
          showNotice('error', `Sale saved, but the receipt did not print: ${printResult.message ?? 'unknown error'}`);
        }
      }

      await refreshWorkspace({ includeSales: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete sale';
      showNotice('error', message);
    }
  }, [
    activeHeldSaleId,
    activeShift,
    cart,
    refreshWorkspace,
    resetCustomerToDefault,
    selectedCustomer?.id,
    session,
    showNotice,
    terminals,
    totals.discountTotal,
    totals.margin,
    totals.rawSubtotal,
    totals.taxTotal,
    totals.total,
  ]);

  const handleSubmitReturn = useCallback(async (draft: ReturnDraft) => {
    if (session == null) {
      return;
    }

    const lines = draft.sale.lines
      .map((line) => ({
        saleLineId: line.id,
        productId: line.productId,
        variantId: line.variantId,
        quantity: draft.quantities[line.id] ?? 0,
        refundAmount: roundToMoney(line.unitPrice * (draft.quantities[line.id] ?? 0)),
      }))
      .filter((line) => line.quantity > 0);

    if (lines.length === 0) {
      showNotice('error', 'Select at least one quantity to refund.');
      return;
    }

    const payload: ReturnInput = {
      saleId: draft.sale.id,
      terminalId: session.terminalId,
      cashierId: session.user.id,
      reason: draft.reason,
      lines,
    };

    try {
      await createReturn(payload);
      setIsReturnOpen(false);
      showNotice('success', `Refund created for ${draft.sale.receiptNumber}.`);
      await refreshWorkspace({ includeSales: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create return';
      showNotice('error', message);
    }
  }, [refreshWorkspace, session, showNotice]);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    try {
      const result = await syncNow();
      await refreshWorkspace();
      const failureMessage = getSyncRunError(result);
      if (failureMessage) {
        showNotice('error', failureMessage);
        return;
      }

      showNotice('success', formatSyncRunSuccess(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      showNotice('error', message);
    } finally {
      setIsSyncing(false);
    }
  }, [refreshWorkspace, showNotice]);

  /**
   * Rebuilds the active shift's Z-report, which is the authority on what the
   * drawer and each tender should hold. Both the Z-report window and the close
   * declaration need it: without it the close screen has nothing to reconcile a
   * cash count against, which is how a short drawer used to close unnoticed.
   */
  const refreshZReport = useCallback(async () => {
    if (activeShift == null) {
      setZReport(null);
      setZReportError('');
      return null;
    }

    setIsZReportLoading(true);
    setZReportError('');
    try {
      const report = await getZReport(activeShift.id);
      setZReport(report);
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build the current Z-report';
      setZReport(null);
      setZReportError(message);
      return null;
    } finally {
      setIsZReportLoading(false);
    }
  }, [activeShift]);

  const handleOpenZReport = useCallback(async () => {
    setIsZOpen(true);
    const report = await refreshZReport();
    if (report == null && activeShift != null) {
      showNotice('error', 'Failed to build the current Z-report.');
    }
  }, [activeShift, refreshZReport, showNotice]);

  const handleOpenCashMovement = useCallback(() => {
    if (activeShift == null) {
      showNotice('error', 'Open a shift before moving cash in or out of the drawer.');
      return;
    }
    setIsCashMovementOpen(true);
    void refreshZReport();
  }, [activeShift, refreshZReport, showNotice]);

  const handleCashMovement = useCallback(async (
    input: { direction: 'in' | 'out'; counts: Record<string, number>; reason: string },
  ) => {
    if (session == null || activeShift == null) {
      return;
    }

    setIsSavingCashMovement(true);
    try {
      const declaration = buildCashDeclaration(
        input.direction === 'in' ? CashCountMode.PAID_IN : CashCountMode.PAID_OUT,
        input.counts,
      );
      const report = await recordCashMovement({
        shiftId: activeShift.id,
        terminalId: session.terminalId,
        cashierId: session.user.id,
        direction: input.direction,
        reason: input.reason,
        declaration,
      });

      setZReport(report);
      setZReportError('');
      setIsCashMovementOpen(false);
      showNotice(
        'success',
        `${input.direction === 'in' ? 'Cash in' : 'Cash out'} of ${formatCurrency(declaration.total)} recorded. Expected drawer is now ${formatCurrency(report.expectedDrawer)}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record the cash movement';
      showNotice('error', message);
    } finally {
      setIsSavingCashMovement(false);
    }
  }, [activeShift, session, showNotice]);

  const handleOpenMoneyModal = useCallback(() => {
    const nextMode: MoneyModalMode = activeShift == null ? 'open' : 'close';
    setMoneyMode(nextMode);
    if (nextMode === 'close') {
      void refreshZReport();
    }
  }, [activeShift, refreshZReport]);

  const terminalCode = resolveTerminalCode(terminals, currentTerminalId);
  const terminalName = terminals.find((terminal) => terminal.id === currentTerminalId)?.name ?? 'POS Terminal';
  const sessionUser = session ? userMap.get(session.user.id) ?? session.user : null;
  const canTakePayment = cart.length > 0 && activeShift != null;

  const handlePrintQuotation = useCallback(async () => {
    if (cart.length === 0) {
      showNotice('error', 'Add items to the cart before printing a quotation.');
      return;
    }

    const reference = `Q-${generateHoldNumber(terminalCode).replace(/^H-/, '')}`;
    const result = await printReceiptDocument(
      buildQuotationDocument(
        {
          lines: cart,
          totals,
          reference,
          cashierName: sessionUser?.name ?? session?.user.name ?? 'Cashier',
          customerName: selectedCustomer?.name,
        },
        terminalCode,
      ),
    );

    if (result.ok) {
      showNotice('success', `Quotation ${reference} printed.`);
    } else {
      showNotice('error', result.message ?? 'Failed to print the quotation.');
    }
  }, [cart, selectedCustomer?.name, session?.user.name, sessionUser?.name, showNotice, terminalCode, totals]);

  /**
   * True when anything is layered over the workstation. Escape must dismiss the
   * overlay stack before it is allowed to reach the action bound to it, so the
   * default Escape/Void binding cannot void a bill from behind a payment window.
   */
  const isOverlayOpen = isSearchOpen
    || isHelpOpen
    || isPaymentOpen
    || isHoldOpen
    || isZOpen
    || isReturnOpen
    || isOrdersOpen
    || isVoidOpen
    || isSettingsOpen
    || isCashMovementOpen
    || moneyMode != null
    || variantSelection != null
    || receiptSale != null;

  /** Single entry point for every action bar button and its key binding. */
  const runAction = useCallback((action: POSActionShortcutId) => {
    switch (action) {
      case 'help':
        setIsHelpOpen(true);
        return;
      case 'orders':
        setIsOrdersOpen(true);
        return;
      case 'search':
        setIsSearchOpen(true);
        return;
      case 'hold':
        if (cart.length === 0) {
          showNotice('error', 'Add items to the cart before holding the bill.');
          return;
        }
        handleOpenHoldModal('hold');
        return;
      case 'recall':
        handleOpenHoldModal('recall');
        return;
      case 'discount':
        discountInputRef.current?.focus();
        discountInputRef.current?.select();
        return;
      case 'customer':
        // Focusing the trigger alone reads as a dead button; the operator
        // pressed this to pick a customer, so open the list on the search box.
        customerSelectRef.current?.open();
        return;
      case 'pay':
        if (cart.length === 0) {
          showNotice('error', 'Cart is empty.');
          return;
        }
        if (activeShift == null) {
          showNotice('error', 'Open a shift before taking payment.');
          return;
        }
        setIsPaymentOpen(true);
        return;
      case 'quote':
        void handlePrintQuotation();
        return;
      case 'refund':
        setIsReturnOpen(true);
        return;
      case 'void':
        if (cart.length === 0) {
          showNotice('error', 'There is nothing to void.');
          return;
        }
        setVoidLineId(null);
        setIsVoidOpen(true);
        return;
      case 'cashDrawer':
        handleOpenMoneyModal();
        return;
      case 'cashMovement':
        handleOpenCashMovement();
        return;
      default:
        return;
    }
  }, [
    activeShift,
    cart.length,
    handleOpenCashMovement,
    handleOpenHoldModal,
    handleOpenMoneyModal,
    handlePrintQuotation,
    showNotice,
  ]);

  const quickKeyProducts = useMemo(() => {
    const byId = new Map(products.map((product) => [product.id, product]));
    return shortcutSettings.quickKeys.map((quickKey) => ({
      quickKey,
      product: byId.get(quickKey.productId) ?? null,
    }));
  }, [products, shortcutSettings.quickKeys]);

  const dispatchShortcut = useCallback((event: KeyboardEvent) => {
    const binding = bindingFromEvent(event);
    if (binding == null) return;

    const isPlainKey = !event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d{1,2}$/.test(event.code);
    const target = event.target as HTMLElement | null;
    const isTyping = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target?.isContentEditable === true;

    if (event.key === 'Escape') {
      // Let a picker or modal close itself first; only a bare workstation
      // Escape falls through to whatever action is bound to the key.
      if (isOverlayOpen) {
        event.preventDefault();
        closeOverlayStack();
        return;
      }
    } else if (isPlainKey && isTyping) {
      // An unmodified key rebound onto an action must not hijack typing.
      return;
    }

    if (bindingMatchesEvent(actionShortcuts.help, event)) {
      event.preventDefault();
      runAction('help');
      return;
    }

    if (session == null) return;

    for (const action of ACTION_SHORTCUT_IDS) {
      if (action === 'help') continue;
      if (!bindingMatchesEvent(actionShortcuts[action], event)) continue;
      event.preventDefault();
      runAction(action);
      return;
    }

    if (!shortcutSettings.quickKeysEnabled || isOverlayOpen) return;

    const match = quickKeyProducts.find(({ quickKey }) => bindingMatchesEvent(quickKey.binding, event));
    if (match == null) return;

    event.preventDefault();
    if (match.product == null) {
      showNotice('error', `Quick key ${formatBinding(match.quickKey.binding)} points at a product that is no longer in the catalog.`);
      return;
    }

    handleProductPick(match.product);
  }, [
    actionShortcuts,
    closeOverlayStack,
    handleProductPick,
    isOverlayOpen,
    quickKeyProducts,
    runAction,
    session,
    shortcutSettings.quickKeysEnabled,
    showNotice,
  ]);

  dispatchShortcutRef.current = dispatchShortcut;

  const workstationLayoutStyle = useMemo(
    () => ({
      '--catalog-pane-width': String(catalogPaneWidth),
      '--workstation-top-space': `${chromeOffsets.top}px`,
      '--workstation-bottom-space': `${chromeOffsets.bottom}px`,
    } as React.CSSProperties),
    [catalogPaneWidth, chromeOffsets.bottom, chromeOffsets.top],
  );

  if (isLoading) {
    return <LoadingScreen message="Loading POS workstation..." />;
  }

  if (bootError) {
    return (
      <div className="screen-fill workstation-app">
        <div className="bg-layer bg-layer-grid" />
        <div className="state-card glass-panel">
          <div className="state-title">POS workstation unavailable</div>
          <p className="state-copy">{bootError}</p>
          <button className="btn-primary" onClick={() => void reloadBootstrap(currentTerminalId)}>
            Retry bootstrap
          </button>
        </div>
      </div>
    );
  }

  if (bootstrapData == null || session == null) {
    return (
      <>
        <WorkstationAccessScreen
          activeShift={activeShift}
          authenticatedUser={authUser}
          branches={branches}
          notice={notice}
          onBranchChange={(branchId) => {
            setSelectedBranchId(branchId);
            const terminal = terminals.find((candidate) => candidate.branchId === branchId);
            if (terminal != null) {
              setSelectedTerminalId(terminal.id);
              void reloadBootstrap(terminal.id, { silent: true });
            }
          }}
          onEndActiveSession={() => void handleEndActiveSession()}
          onEnterWorkstation={handleStartSession}
          onOpenHelp={() => setIsHelpOpen(true)}
          onSignOut={() => void handleSignOut()}
          selectedBranchId={selectedBranchId}
          selectedTerminalId={selectedTerminalId}
          terminals={branchTerminals.length > 0 ? branchTerminals : terminals}
          onTerminalChange={(terminalId) => {
            setSelectedTerminalId(terminalId);
            const terminal = terminals.find((candidate) => candidate.id === terminalId);
            if (terminal != null) {
              setSelectedBranchId(terminal.branchId);
            }
            void reloadBootstrap(terminalId, { silent: true });
          }}
        />
        {isHelpOpen && <HelpGuide onClose={() => setIsHelpOpen(false)} />}
      </>
    );
  }

  return (
    <div className="screen-fill workstation-app" style={workstationLayoutStyle}>
      <div className="bg-layer bg-layer-gradient" />
      <div className="bg-layer bg-layer-grid" />

      <HeaderBar
        activeShift={activeShift}
        cashierName={sessionUser?.name ?? session.user.name}
        conflictCount={syncStatus?.conflictCount ?? 0}
        elementRef={headerBarRef}
        isSyncing={isSyncing}
        onCashAction={handleOpenMoneyModal}
        onOpenHelp={() => setIsHelpOpen(true)}
        onOpenOrders={() => setIsOrdersOpen(true)}
        onCashMovement={handleOpenCashMovement}
        shortcuts={actionShortcuts}
        onOpenSettings={() => void handleOpenSettings()}
        onSignOut={handleSignOut}
        onOpenSync={() => navigate('/sync')}
        onSync={handleSyncNow}
        needsSyncAuth={Boolean(syncStatus?.needsSyncAuth)}
        onZReport={() => void handleOpenZReport()}
        pendingEvents={syncStatus?.pendingEvents ?? 0}
        syncBadge={syncBadge}
        syncOnline={Boolean(syncStatus?.online && !syncStatus?.needsSyncAuth)}
        terminalCode={terminalCode}
        terminalName={terminalName}
        todayBills={todaySales.length}
        todayRevenue={todayRevenue}
      />

      {notice != null && (
        <div className={`toast-banner ${notice.type === 'error' ? 'error' : 'success'}`}>
          {notice.text}
        </div>
      )}

      <div
        className={`workstation-grid ${isResizingCatalogPane ? 'resizing' : ''}`}
        ref={workstationGridRef}
      >
        <ProductPanel
          activeCategory={activeCategory}
          activeCategoryId={activeCategoryId}
          activeSubcategory={activeSubcategory}
          categories={categoryTiles}
          hideOutOfStock={hideOutOfStock}
          onAddProduct={handleProductPick}
          onCategoryChange={(nextCategory) => {
            setActiveCategoryId(nextCategory);
            setActiveSubcategory(null);
          }}
          onOpenSearch={() => setIsSearchOpen(true)}
          onHideOutOfStockChange={setHideOutOfStock}
          onSubcategoryChange={setActiveSubcategory}
          products={visibleProducts}
          subcategories={subcategoryTiles}
        />

        <div
          className={`panel-resizer ${isResizingCatalogPane ? 'active' : ''}`}
          onDoubleClick={() => setCatalogPaneWidth(DEFAULT_CATALOG_PANE_WIDTH)}
          onKeyDown={handleCatalogPaneResizeKeyDown}
          onPointerDown={handleCatalogPaneResizeStart}
          role="separator"
          tabIndex={0}
          aria-label="Resize catalog and cart panels"
          aria-orientation="vertical"
          aria-valuemin={MIN_CATALOG_PANE_WIDTH}
          aria-valuemax={MAX_CATALOG_PANE_WIDTH}
          aria-valuenow={Math.round(catalogPaneWidth)}
        >
          <span className="panel-resizer-handle" />
        </div>

        <CartPanel
          activeHeldSaleId={activeHeldSaleId}
          activeShift={activeShift}
          billDiscount={billDiscount}
          cart={cart}
          customerId={selectedCustomer?.id ?? ''}
          customerSelectRef={customerSelectRef}
          customers={customers}
          defaultTierLabel={defaultTierLabel}
          defaultTierOptions={defaultTierOptions}
          discountInputRef={discountInputRef}
          onBillDiscountChange={(value) => setBillDiscount(Math.max(0, value))}
          onClearCart={() => {
            setVoidLineId(null);
            setIsVoidOpen(true);
          }}
          onCustomerChange={handleCustomerChange}
          onDefaultTierChange={setDefaultTierLabel}
          onHold={() => handleOpenHoldModal('hold')}
          onLineDiscountChange={(lineId, discountPercent) => {
            updateCartLineById(lineId, (line) => recalculateCartLine({ ...line, discountPercent }));
          }}
          onLineQtyChange={(lineId, quantity) => {
            updateCartLineById(lineId, (line) => {
              if (quantity <= 0) return null;
              if (quantity > line.stockOnHand) {
                showNotice('error', `Only ${formatInteger(line.stockOnHand)} unit(s) are available.`);
              }
              return recalculateCartLine({ ...line, quantity: Math.min(quantity, line.stockOnHand) });
            });
          }}
          onLineRemove={(lineId) => {
            setVoidLineId(lineId);
            setIsVoidOpen(true);
          }}
          onLineVariantChange={handleLineVariantChange}
          onLineSalespersonChange={(lineId, salespersonId) => {
            const salesperson = userMap.get(salespersonId);
            if (salesperson == null) {
              return;
            }
            updateCartLineById(lineId, (line) => ({
              ...line,
              salespersonId: salesperson.id,
              salespersonName: salesperson.name,
              salespersonInitials: salesperson.initials,
            }));
          }}
          onLineTierChange={(lineId, tierLabel) => {
            updateCartLineById(lineId, (line) => {
              const tier = pickPriceTier(line.priceTiers, [tierLabel]);
              return recalculateCartLine({
                ...line,
                tierLabel: tier.label,
                unitPrice: tier.price,
              });
            });
          }}
          onPay={() => setIsPaymentOpen(true)}
          salespeople={salespeople}
          totals={totals}
          variantProductIds={productsWithVariants}
        />
      </div>

      <ActionBar
        canTakePayment={canTakePayment}
        cartItemCount={cart.length}
        elementRef={actionBarRef}
        hasReceiptPrinter={hasReceiptPrinter}
        onAction={runAction}
        shortcuts={actionShortcuts}
        total={totals.total}
      />

      {isSearchOpen && (
        <SearchOverlay
          canPrintLabels={hasLabelPrinter}
          hideOutOfStock={hideOutOfStock}
          products={products}
          onClose={() => setIsSearchOpen(false)}
          onPick={(product) => {
            setIsSearchOpen(false);
            handleProductPick(product);
          }}
          onPrintLabel={(product) => {
            void handlePrintProductLabel(product);
          }}
        />
      )}

      {variantSelection != null && (
        <VariantSelectionModal
          initialVariantId={variantSelection.initialVariantId ?? null}
          onClose={() => setVariantSelection(null)}
          onConfirm={handleVariantSelectionComplete}
          product={variantSelection.product}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          draft={settingsDraft}
          hasDesktopBridge={hasDesktopSettingsBridge()}
          hasPrintingBridge={hasPrintingBridge()}
          isBackingUp={isCreatingBackup}
          isLoading={isSettingsLoading}
          isSaving={isSettingsSaving}
          onBackupNow={() => void handleCreateBackup()}
          onBrowseBackupDirectory={() => void handlePickBackupDirectory()}
          onBrowseDatabasePath={() => void handlePickDatabaseLocation()}
          onClose={() => {
            setIsSettingsOpen(false);
            setSettingsDraft(desktopSettings);
          }}
          onDraftChange={setSettingsDraft}
          onSave={() => void handleSaveSettings()}
          onToggleCustomerDisplay={() => void handleToggleCustomerDisplay()}
          customerDisplayStatus={customerDisplayStatus}
          products={products}
        />
      )}

      {isPaymentOpen && (
        <PaymentModal
          total={totals.total}
          onClose={() => setIsPaymentOpen(false)}
          onComplete={(payments) => void handleCompleteSale(payments)}
          onProgressChange={setPaymentProgress}
          addDenominationsToPaymentList={desktopSettings?.addDenominationsToPaymentList ?? true}
          showDenominationCombinations={desktopSettings?.showDenominationCombinations ?? true}
          allowShortPayments={desktopSettings?.allowShortPayments ?? false}
        />
      )}

      {isHoldOpen && (
        <HoldRecallModal
          cartItemCount={cart.length}
          heldSales={heldSales}
          mode={holdMode}
          onClose={() => setIsHoldOpen(false)}
          onHold={() => void handleSaveHeldSale()}
          onRecall={(heldSale) => void handleRecallHeldSale(heldSale)}
        />
      )}

      {isCashMovementOpen && (
        <CashMovementModal
          expectedDrawer={hideCashSales ? undefined : zReport?.expectedDrawer}
          isSaving={isSavingCashMovement}
          onClose={() => setIsCashMovementOpen(false)}
          onSubmit={(input) => void handleCashMovement(input)}
        />
      )}

      {moneyMode != null && (
        <MoneyDeclareModal
          cashSalesHidden={hideCashSales}
          isReportLoading={isZReportLoading}
          mode={moneyMode}
          report={moneyMode === 'close' ? zReport : null}
          reportError={moneyMode === 'close' ? zReportError : ''}
          settings={shiftReconciliationSettings}
          onClose={() => setMoneyMode(null)}
          onSubmit={(submission) => {
            if (moneyMode === 'open') {
              void handleOpenShift(submission);
            } else {
              void handleCloseShift(submission);
            }
          }}
        />
      )}

      {isZOpen && (
        <ZReportModal
          cashSalesHidden={hideCashSales}
          onClose={() => setIsZOpen(false)}
          onPrinted={reportPrintResult}
          terminalId={currentTerminalId}
          terminalCode={terminalCode}
        />
      )}

      {receiptSale != null && (
        <ReceiptModal
          onClose={() => setReceiptSale(null)}
          onPrinted={reportPrintResult}
          sale={receiptSale}
          terminalCode={terminalCode}
        />
      )}

      {isOrdersOpen && (
        <OrderHistoryModal
          cashSalesHidden={hideCashSales}
          currentTerminalId={currentTerminalId}
          isLoading={salesLoading}
          isManager={session.user.role === UserRole.MANAGER}
          onClose={() => setIsOrdersOpen(false)}
          onOpenReceipt={(sale) => {
            setIsOrdersOpen(false);
            setReceiptSale(sale);
          }}
          sales={visibleSales}
          terminals={terminals}
          users={users}
        />
      )}

      {isReturnOpen && (
        <ReturnModal
          isLoading={salesLoading}
          onClose={() => setIsReturnOpen(false)}
          onSubmit={(draft) => void handleSubmitReturn(draft)}
          sales={visibleSales}
        />
      )}

      {isVoidOpen && (
        <VoidModal
          line={voidLineId == null ? null : cart.find((line) => line.uid === voidLineId) ?? null}
          onClose={() => setIsVoidOpen(false)}
          onConfirm={() => {
            if (voidLineId == null) {
              setCart([]);
              setBillDiscount(0);
              setActiveHeldSaleId(null);
              resetCustomerToDefault();
              showNotice('success', 'Current sale cleared.');
            } else {
              setCart((previous) => previous.filter((line) => line.uid !== voidLineId));
              showNotice('success', 'Line removed from the cart.');
            }
            setIsVoidOpen(false);
          }}
        />
      )}

      {isHelpOpen && <HelpGuide onClose={() => setIsHelpOpen(false)} />}
    </div>
  );
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="screen-fill workstation-app">
      <div className="bg-layer bg-layer-grid" />
      <div className="state-card glass-panel">
        <div className="state-title">{message}</div>
      </div>
    </div>
  );
}

type WorkstationAccessScreenProps = {
  activeShift: ShiftSummary | null;
  authenticatedUser: POSUser | null;
  branches: POSBootstrap['branches'];
  notice: Notice;
  onBranchChange: (value: string) => void;
  onEndActiveSession: () => void;
  onEnterWorkstation: () => void;
  onOpenHelp: () => void;
  onSignOut: () => void;
  onTerminalChange: (value: string) => void;
  selectedBranchId: string;
  selectedTerminalId: string;
  terminals: POSBootstrap['terminals'];
};

function WorkstationAccessScreen(props: WorkstationAccessScreenProps) {
  const now = new Date();

  return (
    <div className="screen-fill workstation-app login-screen">
      <div className="bg-layer bg-layer-gradient" />
      <div className="bg-layer bg-layer-aurora" />
      <div className="login-card glass-panel">
        <div className="brand-row">
          <div className="brand-mark">JP</div>
          <div>
            <div className="brand-title">Jingles POS</div>
            <div className="brand-subtitle">Standalone workstation with playback-log sync</div>
          </div>
          <div className="brand-clock">
            <div>{now.toLocaleDateString('en-GB')}</div>
            <div>{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>

        <div className="login-heading">Workstation ready.</div>
        <div className="login-copy">Choose the terminal for this local session, then continue into billing.</div>

        {props.notice != null && (
          <div className={`inline-alert ${props.notice.type === 'error' ? 'error' : 'success'}`}>
            {props.notice.text}
          </div>
        )}

        {props.activeShift != null && (
          <div className="inline-alert info">
            <div>
              Active shift on this terminal: {props.activeShift.cashierName} since {formatTime(props.activeShift.openedAt)}
            </div>
            {props.authenticatedUser?.role === UserRole.MANAGER && (
              <button className="ghost-button" onClick={props.onEndActiveSession}>
                End active session
              </button>
            )}
          </div>
        )}

        <div className="session-user-card">
          <div className="meta-label">Authenticated user</div>
          <div className="session-user-name">{props.authenticatedUser?.name ?? 'Unknown user'}</div>
          <div className="session-user-meta">
            {props.authenticatedUser?.email ?? props.authenticatedUser?.code ?? 'No identifier'}
          </div>
        </div>

        <div className="login-grid">
          <LabelBlock label="Branch">
            <SearchableSelect
              className="glass-input"
              value={props.selectedBranchId}
              onChange={props.onBranchChange}
              options={props.branches.map((branch) => ({ value: branch.id, label: `${branch.code} - ${branch.name}` }))}
              ariaLabel="Branch"
            />
          </LabelBlock>

          <LabelBlock label="Terminal">
            <SearchableSelect
              className="glass-input"
              value={props.selectedTerminalId}
              onChange={props.onTerminalChange}
              options={props.terminals.map((terminal) => ({ value: terminal.id, label: `${terminal.code} - ${terminal.name}` }))}
              ariaLabel="Terminal"
            />
          </LabelBlock>
        </div>

        <div className="auth-actions-row">
          <button className="ghost-button" onClick={props.onSignOut}>
            Sign out
          </button>
          <button className="ghost-button" onClick={props.onOpenHelp} title="Help & user guide (F1)">
            Help
          </button>
          <button className="btn-primary login-submit" onClick={props.onEnterWorkstation}>
            Enter workstation
          </button>
        </div>

        <div className="login-footer">
          <span>Authenticated once, workstation stays local.</span>
          <span>Playback log sync enabled</span>
        </div>
      </div>
    </div>
  );
}

type HeaderBarProps = {
  activeShift: ShiftSummary | null;
  cashierName: string;
  conflictCount: number;
  elementRef?: React.Ref<HTMLElement>;
  isSyncing: boolean;
  onCashAction: () => void;
  onOpenHelp: () => void;
  onOpenOrders: () => void;
  onCashMovement: () => void;
  shortcuts: POSActionShortcuts;
  onOpenSettings: () => void;
  needsSyncAuth: boolean;
  onOpenSync: () => void;
  onSignOut: () => void;
  onSync: () => void;
  onZReport: () => void;
  pendingEvents: number;
  syncBadge: string;
  syncOnline: boolean;
  terminalCode: string;
  terminalName: string;
  todayBills: number;
  todayRevenue: number;
};

function HeaderBar(props: HeaderBarProps) {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (accountMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsAccountMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAccountMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAccountMenuOpen]);

  const handleAccountAction = (action: () => void) => {
    setIsAccountMenuOpen(false);
    action();
  };

  return (
    <header ref={props.elementRef} className="glass-bar workstation-header">
      <div className="header-left">
        <div className="brand-mark small">JP</div>
        <div>
          <div className="header-title">Jingles POS</div>
          <div className="header-subtitle">{props.terminalCode} - {props.terminalName}</div>
        </div>
        <div className="status-pill">
          <span className={`status-dot ${props.syncOnline ? 'online' : 'offline'}`} />
          {props.syncBadge}
        </div>
        {props.activeShift != null ? (
          <div className="status-pill">
            Shift {formatShiftReference(props.activeShift, props.terminalCode)}
          </div>
        ) : (
          <div className="status-pill warning">No active shift</div>
        )}
        {props.needsSyncAuth && <div className="status-pill danger">Reconnect host sync</div>}
        {props.pendingEvents > 0 && <div className="status-pill warning">{props.pendingEvents} pending</div>}
        {props.conflictCount > 0 && <div className="status-pill danger">{props.conflictCount} conflicts</div>}
      </div>

      <div className="header-right">
        <MetricCard label="Today" value={formatCurrency(props.todayRevenue)} />
        <MetricCard label="Bills" value={String(props.todayBills)} />
        <button className="ghost-button" onClick={props.onOpenOrders} title={`Order history (${formatBinding(props.shortcuts.orders)})`}>
          Orders
        </button>
        <button className="ghost-button" onClick={props.onOpenHelp} title={`Help & user guide (${formatBinding(props.shortcuts.help)})`}>
          Help
        </button>
        <button className="ghost-button" onClick={props.onCashAction} title={`${ACTION_SHORTCUT_HINTS.cashDrawer} (${formatBinding(props.shortcuts.cashDrawer)})`}>
          Cash
        </button>
        <button
          className="ghost-button"
          disabled={props.activeShift == null}
          onClick={props.onCashMovement}
          title={props.activeShift == null
            ? 'Open a shift before moving cash in or out of the drawer.'
            : `${ACTION_SHORTCUT_HINTS.cashMovement} (${formatBinding(props.shortcuts.cashMovement)})`}
        >
          In / Out
        </button>
        <div className="account-menu" ref={accountMenuRef}>
          <button
            aria-expanded={isAccountMenuOpen}
            aria-haspopup="menu"
            className={`ghost-button account-menu-trigger ${isAccountMenuOpen ? 'open' : ''}`}
            onClick={() => setIsAccountMenuOpen((previous) => !previous)}
          >
            <span className="account-menu-trigger-copy">
              <span className="account-menu-trigger-label">Account</span>
              <span className="account-menu-trigger-name">{props.cashierName}</span>
            </span>
            <span className="account-menu-caret" aria-hidden="true">{isAccountMenuOpen ? '▲' : '▼'}</span>
          </button>

          {isAccountMenuOpen && (
            <div className="glass-panel account-menu-popover" role="menu">
              <div className="account-menu-section-label">Cashier</div>
              <div className="account-menu-user">{props.cashierName}</div>
              {props.needsSyncAuth && (
                <div className="account-menu-warning">Host sync needs attention before the next push.</div>
              )}
              <button
                className="account-menu-item"
                onClick={() => handleAccountAction(props.onOpenSettings)}
                role="menuitem"
              >
                Settings
              </button>
              <button
                className="account-menu-item"
                onClick={() => handleAccountAction(props.onSync)}
                disabled={props.isSyncing}
                role="menuitem"
              >
                {props.isSyncing ? 'Syncing...' : 'Sync now'}
              </button>
              <button
                className="account-menu-item"
                onClick={() => handleAccountAction(props.onOpenSync)}
                role="menuitem"
              >
                Sync center
              </button>
              <button
                className="account-menu-item"
                onClick={() => handleAccountAction(props.onZReport)}
                role="menuitem"
              >
                Reports
              </button>
              <button
                className="account-menu-item danger"
                onClick={() => handleAccountAction(props.onSignOut)}
                role="menuitem"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

type ProductPanelProps = {
  activeCategory: CatalogCategoryTile | null;
  activeCategoryId: string;
  activeSubcategory: string | null;
  categories: CatalogCategoryTile[];
  hideOutOfStock: boolean;
  onAddProduct: (product: Product) => void;
  onCategoryChange: (nextCategory: string) => void;
  onHideOutOfStockChange: (hideOutOfStock: boolean) => void;
  onOpenSearch: () => void;
  onSubcategoryChange: (nextSubcategory: string | null) => void;
  products: Product[];
  subcategories: CatalogSubcategoryTile[];
};

function ProductPanel(props: ProductPanelProps) {
  const isRootView = props.activeCategoryId === 'all';
  const isSubcategoryView = props.activeSubcategory != null;
  const selectedCategory = isRootView ? null : props.activeCategory;
  const rootCategories = props.categories.filter((category) => category.id !== 'all');
  const scopeLabel = props.activeSubcategory ?? selectedCategory?.name ?? 'Catalog';

  const handleNavigateRoot = () => {
    props.onCategoryChange('all');
    props.onSubcategoryChange(null);
  };

  const handleNavigateUp = () => {
    if (isSubcategoryView) {
      props.onSubcategoryChange(null);
      return;
    }
    handleNavigateRoot();
  };

  return (
    <section className="glass-panel product-panel">
      <div className="panel-head">
        <button className="search-trigger" onClick={props.onOpenSearch}>
          <span className="search-copy">Search products, SKU, or barcode</span>
          <kbd className="kbd">F3</kbd>
        </button>
        <label className="stock-filter-toggle">
          <input
            checked={props.hideOutOfStock}
            onChange={(event) => props.onHideOutOfStockChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
          <span className="stock-filter-switch" aria-hidden="true"><span /></span>
          <span>Hide out of stock</span>
        </label>
      </div>

      <div className="catalog-browser">
        <div className="catalog-toolbar">
          <div className="catalog-toolbar-main">
            <div className="catalog-breadcrumbs" aria-label="Catalog path">
              <button
                className={`catalog-crumb ${isRootView ? 'current' : ''}`}
                onClick={handleNavigateRoot}
              >
                Catalog
              </button>
              {selectedCategory != null && (
                <>
                  <span className="catalog-crumb-separator">/</span>
                  <button
                    className={`catalog-crumb ${!isSubcategoryView ? 'current' : ''}`}
                    onClick={() => props.onSubcategoryChange(null)}
                  >
                    {selectedCategory.name}
                  </button>
                </>
              )}
              {props.activeSubcategory != null && (
                <>
                  <span className="catalog-crumb-separator">/</span>
                  <span className="catalog-crumb current">{props.activeSubcategory}</span>
                </>
              )}
            </div>

            <div className="section-title">
              {isRootView
                ? 'Catalog Root'
                : props.activeSubcategory ?? selectedCategory?.name ?? 'Catalog'}
            </div>
            <div className="section-copy">
              {isRootView
                ? 'Open a category folder to browse its subcategories and products.'
                : isSubcategoryView
                  ? `Viewing the products inside ${props.activeSubcategory}.`
                  : `Open a subcategory folder or add products directly from ${selectedCategory?.name ?? 'this category'}.`}
            </div>
          </div>
          {!isRootView && (
            <button className="ghost-button small" onClick={handleNavigateUp}>
              Up one level
            </button>
          )}
        </div>

        {isRootView ? (
          rootCategories.length === 0 ? (
            <div className="empty-state product-empty">
              <div className="empty-token">CAT</div>
              <div className="empty-title">No categories available</div>
              <div className="empty-copy">Load the catalog before browsing products.</div>
            </div>
          ) : (
            <div className="catalog-section">
              <div className="product-meta">
                <span>{formatInteger(rootCategories.length)} categories</span>
                <span>Root folders</span>
              </div>
              <div className="catalog-tile-grid category-tile-grid">
                {rootCategories.map((category) => (
                  <button
                    key={category.id}
                    className="catalog-tile category-tile"
                    onClick={() => props.onCategoryChange(category.id)}
                  >
                    <div className="catalog-tile-main">
                      <div className="catalog-copy">
                        <div className="catalog-name">{category.name}</div>
                        <div className="catalog-caption">Open folder</div>
                      </div>
                    </div>
                    <div className="catalog-metrics">
                      <span>{formatInteger(category.count)} items</span>
                      <span>{formatInteger(category.subcategoryCount)} subcategories</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <>
            {!isSubcategoryView && props.subcategories.length > 0 && (
              <div className="catalog-section">
                <div className="product-meta">
                  <span>{formatInteger(props.subcategories.length)} subcategories</span>
                  <span>{selectedCategory?.name ?? 'Category'} folders</span>
                </div>

                <div className="catalog-tile-grid subcategory-tile-grid">
                  {props.subcategories.map((subcategory) => (
                    <button
                      key={subcategory.name}
                      className="subcategory-tile"
                      onClick={() => props.onSubcategoryChange(subcategory.name)}
                    >
                      <div className="subcategory-main">
                        <div className="catalog-copy">
                          <div className="catalog-name">{subcategory.name}</div>
                          <div className="catalog-caption">Open folder</div>
                        </div>
                      </div>
                      <div className="catalog-metrics single">
                        <span>{formatInteger(subcategory.count)} items</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="product-results">
              <div className="product-meta">
                <span>{formatInteger(props.products.length)} products</span>
                <span>{scopeLabel} | Sorted by SKU</span>
              </div>

              {props.products.length === 0 ? (
                <div className="empty-state product-empty">
                  <div className="empty-token">{selectedCategory?.chip ?? 'AL'}</div>
                  <div className="empty-title">No products in this view</div>
                  <div className="empty-copy">Pick another folder or use search to continue.</div>
                </div>
              ) : (
                <div className="product-tile-grid">
                  {props.products.map((product) => (
                    <button key={product.id} className="product-tile" onClick={() => props.onAddProduct(product)}>
                      <div className="product-name">{product.name}</div>
                      <div className="product-meta-line">
                        {product.sku} - {product.subcategory}
                        {(product.variants?.length ?? 0) > 0 ? ` - ${formatInteger(product.variants?.length ?? 0)} variants` : ''}
                      </div>
                      <div className="product-tile-footer">
                        <div className="product-stock">Stock {formatInteger(product.stockOnHand)}</div>
                        <div className="product-price">{formatCurrency(product.priceTiers[0]?.price ?? 0)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

type CartPanelProps = {
  activeHeldSaleId: string | null;
  activeShift: ShiftSummary | null;
  billDiscount: number;
  cart: CartLine[];
  customerId: string;
  customerSelectRef: React.RefObject<SearchableSelectHandle>;
  customers: Customer[];
  defaultTierLabel: string;
  defaultTierOptions: string[];
  discountInputRef: React.RefObject<HTMLInputElement>;
  onBillDiscountChange: (value: number) => void;
  onClearCart: () => void;
  onCustomerChange: (value: string) => void;
  onDefaultTierChange: (value: string) => void;
  onHold: () => void;
  onLineDiscountChange: (lineId: string, discountPercent: number) => void;
  onLineQtyChange: (lineId: string, quantity: number) => void;
  onLineRemove: (lineId: string) => void;
  onLineVariantChange: (lineId: string) => void;
  onLineSalespersonChange: (lineId: string, salespersonId: string) => void;
  onLineTierChange: (lineId: string, tierLabel: string) => void;
  onPay: () => void;
  salespeople: POSUser[];
  totals: ReturnType<typeof calcCartTotals>;
  variantProductIds: Set<string>;
};

function CartPanel(props: CartPanelProps) {
  return (
    <section className="glass-panel cart-panel">
      <div className="cart-head">
        <div>
          <div className="meta-label">Active sale</div>
          <div className="cart-sale-id">{props.activeHeldSaleId != null ? `Recalled ${props.activeHeldSaleId}` : 'New walk-in sale'}</div>
        </div>
        <button className="ghost-button small" onClick={props.onClearCart} disabled={props.cart.length === 0}>
          Void
        </button>
      </div>

      <div className="cart-select-grid">
        <LabelBlock label="Customer">
          <SearchableSelect
            ref={props.customerSelectRef}
            className="glass-input compact"
            value={props.customerId}
            onChange={props.onCustomerChange}
            options={props.customers.map((customer) => ({ value: customer.id, label: `${customer.name} - ${customer.tier}` }))}
            ariaLabel="Customer"
          />
        </LabelBlock>

        <LabelBlock label="Default tier">
          <SearchableSelect
            className="glass-input compact"
            value={props.defaultTierLabel}
            onChange={props.onDefaultTierChange}
            options={props.defaultTierOptions.map((label) => ({ value: label, label }))}
            ariaLabel="Default tier"
          />
        </LabelBlock>
      </div>

      <div className="cart-list">
        {props.cart.length === 0 ? (
          <div className="empty-state">
            <div className="empty-token">POS</div>
            <div className="empty-title">Cart is empty</div>
            <div className="empty-copy">Scan, search, or tap a product tile to begin.</div>
          </div>
        ) : (
          props.cart.map((line) => (
            <div key={line.uid} className="cart-line">
              <div className="cart-line-body">
                <div className="cart-line-top">
                  <div>
                    <div className="cart-line-name">{line.name}</div>
                    {getLineVariantSummary(line) != null && (
                      <div className="cart-line-variant">{getLineVariantSummary(line)}</div>
                    )}
                    <div className="cart-line-meta">{line.sku} - stock {formatInteger(line.stockOnHand)}</div>
                  </div>
                  <button className="line-remove" onClick={() => props.onLineRemove(line.uid)}>
                    x
                  </button>
                </div>

                {props.variantProductIds.has(line.productId) && (
                  <button className="line-variant-button" onClick={() => props.onLineVariantChange(line.uid)}>
                    {getLineVariantSummary(line) != null ? 'Change variant' : 'Choose variant'}
                  </button>
                )}

                <div className="cart-line-controls">
                  <div className="mini-field">
                    <span>Qty</span>
                    <div className="qty-stepper">
                      <button onClick={() => props.onLineQtyChange(line.uid, line.quantity - 1)}>-</button>
                      <input
                        value={line.quantity}
                        onChange={(event) => props.onLineQtyChange(line.uid, Number(event.target.value) || 1)}
                      />
                      <button onClick={() => props.onLineQtyChange(line.uid, line.quantity + 1)}>+</button>
                    </div>
                  </div>

                  <label className="mini-field">
                    <span>Tier</span>
                    <SearchableSelect
                      className="line-select"
                      value={line.tierLabel}
                      onChange={(value) => props.onLineTierChange(line.uid, value)}
                      options={line.priceTiers.map((tier) => ({ value: tier.label, label: `${tier.label} - ${formatCurrency(tier.price)}` }))}
                      ariaLabel="Line price tier"
                    />
                  </label>

                  <label className="mini-field">
                    <span>Staff</span>
                    <SearchableSelect
                      className="line-select"
                      value={line.salespersonId}
                      onChange={(value) => props.onLineSalespersonChange(line.uid, value)}
                      options={props.salespeople.map((salesperson) => ({ value: salesperson.id, label: `${salesperson.initials} - ${salesperson.name}` }))}
                      ariaLabel="Line salesperson"
                    />
                  </label>

                  <label className="mini-field">
                    <span>Disc %</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={line.discountPercent}
                      onChange={(event) => props.onLineDiscountChange(line.uid, Number(event.target.value) || 0)}
                    />
                  </label>

                  <div className="mini-field line-total-field">
                    <span>Total</span>
                    <div className="line-total">{formatCurrency(line.lineTotal)}</div>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="cart-foot">
        <div className="totals-grid">
          <span>Items</span>
          <span>{formatInteger(props.totals.itemCount)}</span>
          <span>Subtotal</span>
          <span>{formatCurrency(props.totals.rawSubtotal)}</span>
          {props.totals.lineDiscountTotal > 0 && (
            <>
              <span>Line discounts</span>
              <span>- {formatCurrency(props.totals.lineDiscountTotal)}</span>
            </>
          )}
          <span>Bill discount</span>
          <span>
            <input
              ref={props.discountInputRef}
              className="inline-number"
              type="number"
              min={0}
              value={props.billDiscount}
              onChange={(event) => props.onBillDiscountChange(Number(event.target.value) || 0)}
            />
          </span>
          <span>Shift</span>
          <span>{props.activeShift != null ? 'Open' : 'Closed'}</span>
        </div>

        <div className="grand-total-row">
          <div>
            <div className="meta-label">Total</div>
            <div className="grand-total">{formatCurrency(props.totals.total)}</div>
          </div>
          <div className="grand-total-meta">
            Margin {formatCurrency(props.totals.margin)}
          </div>
        </div>

        <div className="cart-actions">
          <button className="ghost-button" onClick={props.onHold} disabled={props.cart.length === 0}>
            Hold
            <kbd className="kbd inline">F4</kbd>
          </button>
          <button className="btn-primary flex" onClick={props.onPay} disabled={props.cart.length === 0}>
            Pay - {formatCurrency(props.totals.total)}
            <kbd className="kbd inline light">F8</kbd>
          </button>
        </div>
      </div>
    </section>
  );
}

type ActionBarProps = {
  canTakePayment: boolean;
  cartItemCount: number;
  elementRef?: React.Ref<HTMLDivElement>;
  hasReceiptPrinter: boolean;
  shortcuts: POSActionShortcuts;
  onAction: (action: POSActionShortcutId) => void;
  total: number;
};

/**
 * Every button here dispatches through the same `onAction` the key bindings use,
 * so a button and its shortcut can never drift apart, and the key cap always
 * shows the binding actually in force rather than a hard-coded default.
 */
function ActionBar(props: ActionBarProps) {
  const button = (
    action: POSActionShortcutId,
    label: string,
    options: { primary?: boolean; danger?: boolean; disabled?: boolean; title?: string } = {},
  ) => (
    <ActionButton
      shortcut={formatBinding(props.shortcuts[action])}
      label={label}
      onClick={() => props.onAction(action)}
      title={options.title ?? ACTION_SHORTCUT_HINTS[action]}
      primary={options.primary}
      danger={options.danger}
      disabled={options.disabled}
    />
  );

  return (
    <div ref={props.elementRef} className="glass-bar action-bar">
      {button('search', 'Search')}
      {button('hold', 'Hold', { disabled: props.cartItemCount === 0 })}
      {button('recall', 'Recall')}
      {button('discount', 'Discount')}
      {button('customer', 'Customer')}
      {button('pay', `Pay - ${formatCurrency(props.total)}`, { primary: true, disabled: !props.canTakePayment })}
      {button('quote', 'Quote', {
        disabled: props.cartItemCount === 0,
        title: props.hasReceiptPrinter
          ? ACTION_SHORTCUT_HINTS.quote
          : `${ACTION_SHORTCUT_HINTS.quote} No receipt printer is configured, so this opens the system print dialog.`,
      })}
      {button('refund', 'Refund')}
      {button('void', 'Void', { danger: true, disabled: props.cartItemCount === 0 })}
      {button('cashDrawer', 'Cash drawer')}
    </div>
  );
}

function ActionButton(
  props: {
    shortcut: string;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    primary?: boolean;
    danger?: boolean;
    title?: string;
  },
) {
  return (
    <button
      className={`action-button ${props.primary ? 'primary' : ''} ${props.danger ? 'danger' : ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title}
    >
      <span className="action-button-line">
        <b>{props.shortcut}</b>
        <span className="action-button-separator">-</span>
        <span className="action-button-label">{props.label}</span>
      </span>
    </button>
  );
}

function LabelBlock(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="label-block">
      <span className="label-copy">{props.label}</span>
      {props.children}
    </label>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{props.label}</span>
      <b>{props.value}</b>
    </div>
  );
}

function ModalShell(
  props: {
    children: React.ReactNode;
    onClose: () => void;
    title: string;
    width?: 'narrow' | 'medium' | 'wide' | 'payment';
  },
) {
  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className={`glass-panel modal-shell ${props.width ?? 'medium'}`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="modal-close" onClick={props.onClose}>
            x
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

function SettingsModal(
  props: {
    draft: POSDesktopSettings | null;
    hasDesktopBridge: boolean;
    isBackingUp: boolean;
    isLoading: boolean;
    isSaving: boolean;
    onBackupNow: () => void;
    onBrowseBackupDirectory: () => void;
    onBrowseDatabasePath: () => void;
    onClose: () => void;
    onDraftChange: React.Dispatch<React.SetStateAction<POSDesktopSettings | null>>;
    onSave: () => void;
    onToggleCustomerDisplay: () => void;
    customerDisplayStatus: POSCustomerDisplayStatus;
    hasPrintingBridge: boolean;
    products: Product[];
  },
) {
  const settings = props.draft;

  const updateDraft = <K extends keyof POSDesktopSettings>(key: K, value: POSDesktopSettings[K]) => {
    props.onDraftChange((previous: POSDesktopSettings | null) => (
      previous ? { ...previous, [key]: value } : previous
    ));
  };

  return (
    <ModalShell onClose={props.onClose} title="Workstation settings" width="wide">
      <div className="settings-layout">
        {!props.hasDesktopBridge && (
          <div className="inline-alert info">
            Desktop storage settings are only available inside the Electron app. Theme changes can still be saved for this browser.
          </div>
        )}

        {props.isLoading || settings == null ? (
          <div className="empty-state compact">
            <div className="empty-title">Loading workstation settings...</div>
          </div>
        ) : (
          <>
            <div className="settings-grid">
              <section className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <div className="section-kicker">Sync</div>
                    <div className="section-title">Host connection</div>
                  </div>
                  <div className="report-chip mono">Applies immediately after save</div>
                </div>

                <LabelBlock label="Sync URL">
                  <input
                    className="glass-input"
                    disabled={props.isSaving || !props.hasDesktopBridge}
                    value={settings.syncUrl}
                    onChange={(event) => updateDraft('syncUrl', event.target.value)}
                  />
                </LabelBlock>

                <div className="field-hint">
                  Used by login refresh and playback-log sync against the hosted inventory backend.
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <div className="section-kicker">Storage</div>
                    <div className="section-title">SQLite database</div>
                  </div>
                  <div className="report-chip mono">Backend restart on save</div>
                </div>

                <LabelBlock label="Database location">
                  <input
                    className="glass-input"
                    disabled={props.isSaving || !props.hasDesktopBridge}
                    value={settings.databasePath}
                    onChange={(event) => updateDraft('databasePath', event.target.value)}
                  />
                </LabelBlock>

                <div className="settings-inline-actions">
                  <button
                    className="ghost-button"
                    disabled={props.isSaving || !props.hasDesktopBridge}
                    onClick={props.onBrowseDatabasePath}
                  >
                    Browse database
                  </button>
                </div>

                <div className="field-hint">
                  When you choose a new empty file path, the current database is copied there before the backend switches over.
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <div className="section-kicker">Backup</div>
                    <div className="section-title">Backup location</div>
                  </div>
                  <div className="report-chip mono">SQLite snapshot backup</div>
                </div>

                <LabelBlock label="Backup directory">
                  <input
                    className="glass-input"
                    disabled={props.isSaving || !props.hasDesktopBridge}
                    value={settings.backupDirectory}
                    onChange={(event) => updateDraft('backupDirectory', event.target.value)}
                  />
                </LabelBlock>

                <div className="settings-inline-actions">
                  <button
                    className="ghost-button"
                    disabled={props.isSaving || !props.hasDesktopBridge}
                    onClick={props.onBrowseBackupDirectory}
                  >
                    Choose folder
                  </button>
                  <button
                    className="ghost-button"
                    disabled={props.isBackingUp || !props.hasDesktopBridge}
                    onClick={props.onBackupNow}
                  >
                    {props.isBackingUp ? 'Backing up...' : 'Back up now'}
                  </button>
                </div>

                <div className="field-hint">
                  Backups are written as timestamped SQLite files so you can archive or restore them separately.
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <div className="section-kicker">Appearance</div>
                    <div className="section-title">Theme</div>
                  </div>
                  <div className="report-chip mono">Renderer only</div>
                </div>

                <div className="theme-option-row">
                  <button
                    className={`theme-option ${settings.themeMode === 'light' ? 'active' : ''}`}
                    onClick={() => updateDraft('themeMode', 'light')}
                  >
                    <span className="theme-option-title">Light</span>
                    <span className="theme-option-copy">Warm glass panels and bright catalog surfaces.</span>
                  </button>
                  <button
                    className={`theme-option ${settings.themeMode === 'dark' ? 'active' : ''}`}
                    onClick={() => updateDraft('themeMode', 'dark')}
                  >
                    <span className="theme-option-title">Dark</span>
                    <span className="theme-option-copy">Low-glare workstation view for long billing sessions.</span>
                  </button>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-head">
                  <div>
                    <div className="section-kicker">Payments</div>
                    <div className="section-title">Cash denomination behavior</div>
                  </div>
                  <div className="report-chip mono">Payment window</div>
                </div>

                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.addDenominationsToPaymentList}
                    onChange={(event) => updateDraft('addDenominationsToPaymentList', event.target.checked)}
                  />
                  <span>
                    <b>Add denomination clicks to the payment list</b>
                    <small>Keep each cash note or coin selection visible as a pending cash entry.</small>
                  </span>
                </label>

                <label className="settings-checkbox-row admin-setting-row">
                  <input
                    type="checkbox"
                    checked={settings.allowShortPayments}
                    onChange={(event) => updateDraft('allowShortPayments', event.target.checked)}
                  />
                  <span>
                    <b>Allow short payments</b>
                    <small>Allow a bill to close with a remaining balance due. Disabled by default.</small>
                  </span>
                </label>

                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.showDenominationCombinations}
                    onChange={(event) => updateDraft('showDenominationCombinations', event.target.checked)}
                  />
                  <span>
                    <b>Suggest denominations for manually typed amounts</b>
                    <small>Show exact note and coin combinations when the typed amount can be represented.</small>
                  </span>
                </label>
              </section>

              <ShiftReconciliationCard
                disabled={props.isSaving}
                settings={settings.shiftReconciliation}
                onChange={(shiftReconciliation) => updateDraft('shiftReconciliation', shiftReconciliation)}
              />

              <ScannerSettingsCard
                disabled={props.isSaving}
                scanner={settings.scanner}
                onChange={(scanner) => updateDraft('scanner', scanner)}
              />

              <CustomerDisplayCard
                disabled={props.isSaving}
                hasDesktopBridge={props.hasDesktopBridge}
                settings={settings.customerDisplay}
                status={props.customerDisplayStatus}
                onChange={(customerDisplay) => updateDraft('customerDisplay', customerDisplay)}
                onToggleDisplay={props.onToggleCustomerDisplay}
              />
            </div>

            <ShortcutSettingsCard
              disabled={props.isSaving}
              products={props.products}
              shortcuts={settings.shortcuts}
              onChange={(shortcuts) => updateDraft('shortcuts', shortcuts)}
            />

            <PrinterSettingsCard
              disabled={props.isSaving}
              hasPrintingBridge={props.hasPrintingBridge}
              printers={settings.printers}
              onChange={(printers) => updateDraft('printers', printers)}
            />

            <div className="modal-actions">
              <button className="ghost-button" onClick={props.onClose}>
                Cancel
              </button>
              <button className="btn-primary" disabled={props.isSaving || settings == null} onClick={props.onSave}>
                {props.isSaving ? 'Saving settings...' : 'Save settings'}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}

/**
 * Records the next keystroke as a binding.
 *
 * Capture is done on the window during the capture phase so the recorder sees
 * keys the workstation would otherwise swallow — F-keys, Escape, and the
 * browser's own Ctrl combinations — and so a shortcut being rebound cannot fire
 * its action while it is being recorded.
 */
function KeyBindingInput(
  props: {
    value: string;
    onChange: (binding: string) => void;
    disabled?: boolean;
    ariaLabel: string;
    /** Rejects bindings a barcode scanner could imitate. */
    requireModifier?: boolean;
    onReset?: () => void;
  },
) {
  const [isRecording, setIsRecording] = useState(false);
  const [rejected, setRejected] = useState('');
  // Held in a ref so the capture listener is installed once per recording
  // session rather than being torn down on every parent re-render.
  const handlersRef = useRef(props);
  handlersRef.current = props;

  useEffect(() => {
    if (!isRecording) return undefined;

    const capture = (event: KeyboardEvent) => {
      const binding = bindingFromEvent(event);
      if (binding == null) {
        // Only modifiers held so far; keep waiting for the real key.
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const handlers = handlersRef.current;
      if (event.code === 'Backspace' || event.code === 'Delete') {
        setIsRecording(false);
        setRejected('');
        handlers.onReset?.();
        return;
      }

      if (handlers.requireModifier && !isValidQuickKeyBinding(binding)) {
        setRejected(QUICK_KEY_BINDING_HINT);
        return;
      }

      setIsRecording(false);
      setRejected('');
      handlers.onChange(binding);
    };

    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [isRecording]);

  return (
    <span className="key-binding-input">
      <button
        type="button"
        className={`key-binding-button ${isRecording ? 'recording' : ''}`}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onClick={() => {
          setRejected('');
          setIsRecording((current) => !current);
        }}
        onBlur={() => setIsRecording(false)}
      >
        {isRecording ? 'Press a key...' : formatBinding(props.value)}
      </button>
      {rejected !== '' && <small className="key-binding-error">{rejected}</small>}
    </span>
  );
}

function ShiftReconciliationCard(
  props: {
    disabled: boolean;
    settings: POSShiftReconciliationSettings;
    onChange: (settings: POSShiftReconciliationSettings) => void;
  },
) {
  const update = <K extends keyof POSShiftReconciliationSettings>(
    key: K,
    value: POSShiftReconciliationSettings[K],
  ) => {
    props.onChange({ ...props.settings, [key]: value });
  };

  const selected = props.settings.declaredTenders;
  const usesLumpTotal = selected.includes(TENDER_TOTAL_KEY);

  /**
   * A lump total already covers every method, so the two cannot be mixed
   * without reconciling the same money twice. Picking one clears the other
   * rather than silently producing a double-counted overall figure.
   */
  const toggleTender = (key: string) => {
    if (key === TENDER_TOTAL_KEY) {
      update('declaredTenders', usesLumpTotal ? [] : [TENDER_TOTAL_KEY]);
      return;
    }

    const withoutTotal = selected.filter((entry) => entry !== TENDER_TOTAL_KEY);
    update(
      'declaredTenders',
      withoutTotal.includes(key)
        ? withoutTotal.filter((entry) => entry !== key)
        : DECLARABLE_TENDER_METHODS.filter((method) => method === key || withoutTotal.includes(method)),
    );
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <div className="section-kicker">Shift</div>
          <div className="section-title">Close-out reconciliation</div>
        </div>
        <div className="report-chip mono">Checked against the transaction log</div>
      </div>

      <div className="meta-label">Tender declared at close</div>
      <div className="field-hint">
        Cash is always counted by denomination. Tick any non-cash tender you also want reconciled —
        pick as many as you like, or none for a cash-only close.
      </div>

      <div className="tender-select-grid">
        <label className={`tender-select ${usesLumpTotal ? 'active' : ''}`}>
          <input
            type="checkbox"
            disabled={props.disabled}
            checked={usesLumpTotal}
            onChange={() => toggleTender(TENDER_TOTAL_KEY)}
          />
          <span>
            <b>All non-cash as one total</b>
            <small>A single figure covering every card, voucher and credit payment.</small>
          </span>
        </label>

        {DECLARABLE_TENDER_METHODS.map((method) => (
          <label
            key={method}
            className={`tender-select ${selected.includes(method) ? 'active' : ''} ${usesLumpTotal ? 'muted' : ''}`}
          >
            <input
              type="checkbox"
              disabled={props.disabled}
              checked={selected.includes(method)}
              onChange={() => toggleTender(method)}
            />
            <span>
              <b>{PAYMENT_METHOD_LABELS[method] ?? method}</b>
              <small>Declared and checked on its own line.</small>
            </span>
          </label>
        ))}
      </div>

      <div className="settings-inline-actions">
        <button
          className="ghost-button"
          disabled={props.disabled}
          onClick={() => update('declaredTenders', [...DECLARABLE_TENDER_METHODS])}
        >
          Select every payment type
        </button>
        <button
          className="ghost-button"
          disabled={props.disabled || selected.length === 0}
          onClick={() => update('declaredTenders', [])}
        >
          Cash only
        </button>
      </div>

      {usesLumpTotal && (
        <div className="field-hint">
          Individual payment types are switched off while the lump total is selected, so the same
          money is never counted twice.
        </div>
      )}

      <div className="settings-field-row">
        <LabelBlock label="Alert above variance of">
          <input
            className="glass-input compact"
            type="number"
            min={0}
            step={1}
            disabled={props.disabled}
            value={props.settings.alertThresholdAmount}
            onChange={(event) => update('alertThresholdAmount', Math.max(0, Number(event.target.value) || 0))}
          />
        </LabelBlock>
        <LabelBlock label="Or above percentage of">
          <input
            className="glass-input compact"
            type="number"
            min={0}
            max={100}
            step={0.5}
            disabled={props.disabled}
            value={props.settings.alertThresholdPercent}
            onChange={(event) => update('alertThresholdPercent', Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
          />
        </LabelBlock>
      </div>

      <div className="field-hint">
        A declaration is flagged when it differs from the expected figure by either threshold. Set a
        threshold to 0 to switch that check off.
      </div>

      <label className="settings-checkbox-row admin-setting-row">
        <input
          type="checkbox"
          disabled={props.disabled}
          checked={props.settings.requireConfirmationOnAlert}
          onChange={(event) => update('requireConfirmationOnAlert', event.target.checked)}
        />
        <span>
          <b>Confirm before closing a flagged shift</b>
          <small>The cashier must acknowledge the discrepancy, and it is recorded against the shift either way.</small>
        </span>
      </label>
    </section>
  );
}

function ShortcutSettingsCard(
  props: {
    disabled: boolean;
    products: Product[];
    shortcuts: POSShortcutSettings;
    onChange: (shortcuts: POSShortcutSettings) => void;
  },
) {
  const [quickKeyProductId, setQuickKeyProductId] = useState('');
  const conflicts = useMemo(
    () => findShortcutConflicts(props.shortcuts.actions, props.shortcuts.quickKeys),
    [props.shortcuts.actions, props.shortcuts.quickKeys],
  );

  const productOptions = useMemo(
    () => props.products.slice(0, 500).map((product) => ({
      value: product.id,
      label: `${product.sku} - ${product.name}`,
    })),
    [props.products],
  );

  const setAction = (action: POSActionShortcutId, binding: string) => {
    props.onChange({
      ...props.shortcuts,
      actions: { ...props.shortcuts.actions, [action]: binding },
    });
  };

  const addQuickKey = () => {
    const product = props.products.find((candidate) => candidate.id === quickKeyProductId);
    if (product == null) return;

    props.onChange({
      ...props.shortcuts,
      quickKeys: [
        ...props.shortcuts.quickKeys,
        {
          id: createQuickKeyId(),
          binding: '',
          productId: product.id,
          sku: product.sku,
          label: product.name,
        },
      ],
    });
    setQuickKeyProductId('');
  };

  const updateQuickKey = (id: string, changes: Partial<POSQuickKey>) => {
    props.onChange({
      ...props.shortcuts,
      quickKeys: props.shortcuts.quickKeys.map((quickKey) => (
        quickKey.id === id ? { ...quickKey, ...changes } : quickKey
      )),
    });
  };

  const removeQuickKey = (id: string) => {
    props.onChange({
      ...props.shortcuts,
      quickKeys: props.shortcuts.quickKeys.filter((quickKey) => quickKey.id !== id),
    });
  };

  const conflictNote = (binding: string) => {
    const normalized = normalizeBinding(binding);
    const claimants = normalized == null ? undefined : conflicts.get(normalized);
    return claimants == null ? null : `Also used by ${claimants.join(', ')}`;
  };

  return (
    <section className="settings-card settings-card-wide">
      <div className="settings-card-head">
        <div>
          <div className="section-kicker">Keyboard</div>
          <div className="section-title">Shortcuts and product quick keys</div>
        </div>
        <div className="report-chip mono">Per workstation</div>
      </div>

      <div className="meta-label">Action bar</div>
      <div className="shortcut-grid">
        {ACTION_SHORTCUT_IDS.map((action) => {
          const note = conflictNote(props.shortcuts.actions[action]);
          return (
            <div className="shortcut-row" key={action}>
              <span className="shortcut-row-label">
                <b>{ACTION_SHORTCUT_LABELS[action]}</b>
                <small>{ACTION_SHORTCUT_HINTS[action]}</small>
              </span>
              <KeyBindingInput
                ariaLabel={`Shortcut for ${ACTION_SHORTCUT_LABELS[action]}`}
                disabled={props.disabled}
                value={props.shortcuts.actions[action]}
                onChange={(binding) => setAction(action, binding)}
                onReset={() => setAction(action, DEFAULT_POS_ACTION_SHORTCUTS[action])}
              />
              {note != null && <small className="shortcut-conflict">{note}</small>}
            </div>
          );
        })}
      </div>

      <div className="settings-inline-actions">
        <button
          className="ghost-button"
          disabled={props.disabled}
          onClick={() => props.onChange({ ...props.shortcuts, actions: { ...DEFAULT_POS_ACTION_SHORTCUTS } })}
        >
          Restore default shortcuts
        </button>
      </div>

      <div className="field-hint">
        While recording, press Backspace to restore the default. Escape stays bound to closing whatever
        window is open before it reaches the action assigned to it.
      </div>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          disabled={props.disabled}
          checked={props.shortcuts.quickKeysEnabled}
          onChange={(event) => props.onChange({ ...props.shortcuts, quickKeysEnabled: event.target.checked })}
        />
        <span>
          <b>Enable product quick keys</b>
          <small>Ring up a bound product straight into the cart without searching for it.</small>
        </span>
      </label>

      <div className="quick-key-add">
        <SearchableSelect
          className="glass-input compact"
          value={quickKeyProductId}
          onChange={setQuickKeyProductId}
          options={productOptions}
          disabled={props.disabled || !props.shortcuts.quickKeysEnabled}
          placeholder="Choose a product..."
          ariaLabel="Quick key product"
        />
        <button
          className="ghost-button"
          disabled={props.disabled || !props.shortcuts.quickKeysEnabled || quickKeyProductId === ''}
          onClick={addQuickKey}
        >
          Add quick key
        </button>
      </div>

      {props.shortcuts.quickKeys.length === 0 ? (
        <div className="field-hint">No quick keys are bound on this workstation yet.</div>
      ) : (
        <div className="quick-key-list">
          {props.shortcuts.quickKeys.map((quickKey) => {
            const note = conflictNote(quickKey.binding);
            const isUnbound = !isValidQuickKeyBinding(quickKey.binding);
            return (
              <div className="quick-key-row" key={quickKey.id}>
                <KeyBindingInput
                  ariaLabel={`Quick key for ${quickKey.label || quickKey.sku}`}
                  disabled={props.disabled || !props.shortcuts.quickKeysEnabled}
                  requireModifier
                  value={quickKey.binding}
                  onChange={(binding) => updateQuickKey(quickKey.id, { binding })}
                  onReset={() => updateQuickKey(quickKey.id, { binding: '' })}
                />
                <span className="quick-key-product">
                  <b>{quickKey.label || quickKey.sku}</b>
                  <small>{quickKey.sku}</small>
                </span>
                {isUnbound && <small className="shortcut-conflict">Not saved until a key is assigned</small>}
                {note != null && <small className="shortcut-conflict">{note}</small>}
                <button
                  className="line-remove"
                  aria-label={`Remove quick key for ${quickKey.label || quickKey.sku}`}
                  disabled={props.disabled}
                  onClick={() => removeQuickKey(quickKey.id)}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="field-hint">{QUICK_KEY_BINDING_HINT}</div>
    </section>
  );
}

function ScannerSettingsCard(
  props: {
    disabled: boolean;
    scanner: POSScannerSettings;
    onChange: (scanner: POSScannerSettings) => void;
  },
) {
  const update = <K extends keyof POSScannerSettings>(key: K, value: POSScannerSettings[K]) => {
    props.onChange({ ...props.scanner, [key]: value });
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <div className="section-kicker">Hardware</div>
          <div className="section-title">Barcode scanner</div>
        </div>
        <div className="report-chip mono">Keyboard wedge</div>
      </div>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={props.scanner.enabled}
          onChange={(event) => update('enabled', event.target.checked)}
        />
        <span>
          <b>Capture scans anywhere on the screen</b>
          <small>
            Scanned codes go straight to the cart even when the cursor is in another field,
            instead of being typed into whatever has focus.
          </small>
        </span>
      </label>

      <div className="settings-field-row">
        <LabelBlock label="Shortest code">
          <input
            className="glass-input"
            type="number"
            min={2}
            max={32}
            disabled={props.disabled || !props.scanner.enabled}
            value={props.scanner.minLength}
            onChange={(event) => update('minLength', Number.parseInt(event.target.value, 10) || 4)}
          />
        </LabelBlock>

        <LabelBlock label="Max gap between keys (ms)">
          <input
            className="glass-input"
            type="number"
            min={10}
            max={200}
            disabled={props.disabled || !props.scanner.enabled}
            value={props.scanner.maxInterKeyMs}
            onChange={(event) => update('maxInterKeyMs', Number.parseInt(event.target.value, 10) || 35)}
          />
        </LabelBlock>

        <LabelBlock label="Scanner prefix (optional)">
          <input
            className="glass-input"
            maxLength={8}
            disabled={props.disabled || !props.scanner.enabled}
            value={props.scanner.prefix}
            onChange={(event) => update('prefix', event.target.value)}
          />
        </LabelBlock>
      </div>

      <div className="field-hint">
        Anything typed faster than the gap above is treated as a scan. Raise it for slow
        scanners; lower it if fast typing is being mistaken for a scan.
      </div>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          disabled={props.disabled || !props.scanner.enabled}
          checked={props.scanner.requireTerminator}
          onChange={(event) => update('requireTerminator', event.target.checked)}
        />
        <span>
          <b>Only accept scans that end with Enter or Tab</b>
          <small>Leave on unless the scanner is programmed with no suffix.</small>
        </span>
      </label>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          disabled={props.disabled || !props.scanner.enabled}
          checked={props.scanner.beepOnScan}
          onChange={(event) => update('beepOnScan', event.target.checked)}
        />
        <span>
          <b>Beep when a scan is recognised</b>
          <small>A short tone from the workstation, separate from the scanner's own beep.</small>
        </span>
      </label>
    </section>
  );
}

/**
 * Settings for the second screen the customer reads.
 *
 * On the desktop the display is a real window the main process places on a
 * second monitor; in a browser it is a pop-up this window drives through local
 * storage. Both are opened from the same button here.
 */
function CustomerDisplayCard(
  props: {
    disabled?: boolean;
    hasDesktopBridge: boolean;
    settings: POSCustomerDisplaySettings;
    status: POSCustomerDisplayStatus;
    onChange: (settings: POSCustomerDisplaySettings) => void;
    onToggleDisplay: () => void;
  },
) {
  const update = <K extends keyof POSCustomerDisplaySettings>(
    key: K,
    value: POSCustomerDisplaySettings[K],
  ) => {
    props.onChange({ ...props.settings, [key]: value });
  };

  const placementHint = props.hasDesktopBridge
    ? props.status.displayCount > 1
      ? `${props.status.displayCount} monitors detected. The display opens full screen on the monitor the workstation is not using.`
      : 'Only one monitor detected. The display opens as a movable window you can drag onto a customer screen.'
    : 'In a browser the display opens as a separate pop-up window that follows this one. Allow pop-ups for this site.';

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <div className="section-kicker">Customer display</div>
          <div className="section-title">Second screen</div>
        </div>
        <div className="report-chip mono">{props.status.open ? 'Display open' : 'Display closed'}</div>
      </div>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          disabled={props.disabled}
          checked={props.settings.enabled}
          onChange={(event) => update('enabled', event.target.checked)}
        />
        <span>
          <b>Show a customer display</b>
          <small>Open it automatically with the workstation and mirror every bill to it.</small>
        </span>
      </label>

      <LabelBlock label="Welcome message">
        <input
          className="glass-input"
          disabled={props.disabled}
          value={props.settings.welcomeMessage}
          onChange={(event) => update('welcomeMessage', event.target.value)}
        />
      </LabelBlock>

      <LabelBlock label="Welcome subtitle">
        <input
          className="glass-input"
          disabled={props.disabled}
          value={props.settings.welcomeSubtitle}
          onChange={(event) => update('welcomeSubtitle', event.target.value)}
        />
      </LabelBlock>

      <div className="field-hint">Shown between sales, whenever the cart is empty.</div>

      <LabelBlock label="Thank-you message">
        <input
          className="glass-input"
          disabled={props.disabled}
          value={props.settings.thankYouMessage}
          onChange={(event) => update('thankYouMessage', event.target.value)}
        />
      </LabelBlock>

      <div className="settings-field-row">
        <LabelBlock label="Store name">
          <input
            className="glass-input"
            disabled={props.disabled}
            placeholder="Branch name"
            value={props.settings.storeName}
            onChange={(event) => update('storeName', event.target.value)}
          />
        </LabelBlock>

        <LabelBlock label="Completed sale stays up (seconds)">
          <input
            className="glass-input"
            type="number"
            min={0}
            max={600}
            disabled={props.disabled}
            value={props.settings.completedSaleTimeoutSeconds}
            onChange={(event) => update('completedSaleTimeoutSeconds', Number(event.target.value))}
          />
        </LabelBlock>
      </div>

      <div className="field-hint">
        Zero leaves the completed sale on screen until the next bill starts.
      </div>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          disabled={props.disabled}
          checked={props.settings.showCashierName}
          onChange={(event) => update('showCashierName', event.target.checked)}
        />
        <span>
          <b>Show the cashier's name</b>
          <small>Adds "Served by" to the display header.</small>
        </span>
      </label>

      <div className="settings-inline-actions">
        <button className="ghost-button" disabled={props.disabled} onClick={props.onToggleDisplay}>
          {props.status.open ? 'Close display' : 'Open display now'}
        </button>
      </div>

      <div className="field-hint">{placementHint}</div>
    </section>
  );
}

const TRANSPORT_LABELS: Record<POSPrinterTransport, string> = {
  network: 'Network (TCP 9100)',
  system: 'Installed printer (USB)',
  device: 'Device path / serial port',
};

function PrinterSettingsCard(
  props: {
    disabled: boolean;
    hasPrintingBridge: boolean;
    printers: POSPrinterConfig[];
    onChange: (printers: POSPrinterConfig[]) => void;
  },
) {
  const [discovered, setDiscovered] = useState<POSDiscoveredPrinter[]>([]);
  const [discoveryNote, setDiscoveryNote] = useState('');
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const runDiscovery = async (includeNetwork: boolean) => {
    setIsDiscovering(true);
    setDiscoveryNote(includeNetwork ? 'Scanning the local network for printers...' : 'Reading installed printers...');
    try {
      const result = await discoverPrinters({ includeNetwork });
      setDiscovered(result.printers);
      setDiscoveryNote([
        `Found ${formatInteger(result.printers.length)} printer(s)`,
        result.scannedSubnets.length > 0 ? `on ${result.scannedSubnets.join(', ')}` : '',
        ...result.warnings,
      ].filter(Boolean).join(' - '));
    } catch (error) {
      setDiscoveryNote(error instanceof Error ? error.message : 'Printer discovery failed.');
    } finally {
      setIsDiscovering(false);
    }
  };

  const addPrinter = (role: POSPrinterRole, overrides: Partial<POSPrinterConfig> = {}) => {
    const hasRoleDefault = props.printers.some((printer) => printer.role === role && printer.isDefault);
    props.onChange([
      ...props.printers,
      createPrinterDraft(role, { isDefault: !hasRoleDefault, ...overrides }),
    ]);
  };

  const adoptDiscovered = (candidate: POSDiscoveredPrinter) => {
    addPrinter(candidate.suggestedRole, {
      name: candidate.name,
      language: candidate.suggestedLanguage,
      transport: candidate.transport,
      address: candidate.address,
      port: candidate.port || 9100,
      cutPaper: candidate.suggestedRole === 'receipt',
    });
  };

  const runTest = async (printer: POSPrinterConfig) => {
    setTestingPrinterId(printer.id);
    setTestResult(null);
    try {
      const result = await testPrinter(printer);
      setTestResult({
        ok: result.ok,
        text: result.ok
          ? `Test page sent to ${result.printerName ?? printer.name}.`
          : result.message ?? 'The test failed.',
      });
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : 'The test failed.' });
    } finally {
      setTestingPrinterId(null);
    }
  };

  return (
    <section className="settings-card settings-card-wide">
      <div className="settings-card-head">
        <div>
          <div className="section-kicker">Hardware</div>
          <div className="section-title">Printers</div>
        </div>
        <div className="report-chip mono">ESC/POS and ZPL</div>
      </div>

      {!props.hasPrintingBridge ? (
        <div className="inline-alert info">
          Direct printing is only available inside the Electron app. In a browser, Print opens the
          system print dialog instead.
        </div>
      ) : (
        <>
          <div className="settings-inline-actions">
            <button className="ghost-button" disabled={isDiscovering} onClick={() => void runDiscovery(false)}>
              Find installed printers
            </button>
            <button className="ghost-button" disabled={isDiscovering} onClick={() => void runDiscovery(true)}>
              {isDiscovering ? 'Scanning...' : 'Scan network too'}
            </button>
            <button className="ghost-button" disabled={props.disabled} onClick={() => addPrinter('receipt')}>
              Add receipt printer
            </button>
            <button className="ghost-button" disabled={props.disabled} onClick={() => addPrinter('label')}>
              Add label printer
            </button>
          </div>

          {discoveryNote && <div className="field-hint">{discoveryNote}</div>}

          {discovered.length > 0 && (
            <div className="printer-discovery-list">
              {discovered.map((candidate) => (
                <div key={`${candidate.transport}-${candidate.address}`} className="printer-discovery-row">
                  <div className="printer-discovery-copy">
                    <div>{candidate.name}{candidate.isSystemDefault ? ' (system default)' : ''}</div>
                    <div>
                      {TRANSPORT_LABELS[candidate.transport]} - {candidate.address}
                      {candidate.transport === 'network' ? `:${candidate.port}` : ''}
                      {' - looks like '}
                      {candidate.suggestedLanguage === 'zpl' ? 'a ZPL label printer' : 'an ESC/POS receipt printer'}
                    </div>
                  </div>
                  <button className="ghost-button" disabled={props.disabled} onClick={() => adoptDiscovered(candidate)}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {testResult && (
        <div className={`inline-alert ${testResult.ok ? 'success' : 'error'}`}>{testResult.text}</div>
      )}

      {props.printers.length === 0 ? (
        <div className="empty-state compact">
          <div className="empty-title">No printers configured</div>
          <div className="empty-copy">
            Receipts and Z readings fall back to the system print dialog until a printer is added here.
          </div>
        </div>
      ) : (
        <div className="printer-config-list">
          {props.printers.map((printer) => (
            <PrinterConfigRow
              key={printer.id}
              disabled={props.disabled}
              isTesting={testingPrinterId === printer.id}
              printer={printer}
              onChange={(changes) => props.onChange(withPrinterUpdate(props.printers, printer.id, changes))}
              onRemove={() => props.onChange(props.printers.filter((entry) => entry.id !== printer.id))}
              onTest={() => void runTest(printer)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PrinterConfigRow(
  props: {
    disabled: boolean;
    isTesting: boolean;
    printer: POSPrinterConfig;
    onChange: (changes: Partial<POSPrinterConfig>) => void;
    onRemove: () => void;
    onTest: () => void;
  },
) {
  const { printer } = props;
  const isLabelPrinter = printer.role === 'label';

  return (
    <div className={`printer-config-row ${printer.enabled ? '' : 'disabled'}`}>
      <div className="printer-config-head">
        <input
          className="glass-input printer-name-input"
          disabled={props.disabled}
          value={printer.name}
          onChange={(event) => props.onChange({ name: event.target.value })}
        />
        <div className="printer-config-flags">
          <label className="printer-flag">
            <input
              type="checkbox"
              disabled={props.disabled}
              checked={printer.enabled}
              onChange={(event) => props.onChange({ enabled: event.target.checked })}
            />
            <span>Enabled</span>
          </label>
          <label className="printer-flag">
            <input
              type="radio"
              name={`default-${printer.role}`}
              disabled={props.disabled || !printer.enabled}
              checked={printer.isDefault}
              onChange={() => props.onChange({ isDefault: true })}
            />
            <span>Default {printer.role}</span>
          </label>
        </div>
      </div>

      <div className="settings-field-row">
        <LabelBlock label="Used for">
          <select
            className="glass-input"
            disabled={props.disabled}
            value={printer.role}
            onChange={(event) => {
              const role = event.target.value as POSPrinterRole;
              props.onChange({
                role,
                language: role === 'label' ? 'zpl' : 'escpos',
                cutPaper: role === 'receipt',
              });
            }}
          >
            <option value="receipt">Receipts and Z readings</option>
            <option value="label">Product labels</option>
          </select>
        </LabelBlock>

        <LabelBlock label="Language">
          <select
            className="glass-input"
            disabled={props.disabled}
            value={printer.language}
            onChange={(event) => props.onChange({ language: event.target.value as POSPrinterConfig['language'] })}
          >
            <option value="escpos">ESC/POS (Epson, Star, Bixolon)</option>
            <option value="zpl">ZPL (Zebra, TSC, Godex)</option>
          </select>
        </LabelBlock>

        <LabelBlock label="Connection">
          <select
            className="glass-input"
            disabled={props.disabled}
            value={printer.transport}
            onChange={(event) => {
              const transport = event.target.value as POSPrinterTransport;
              props.onChange({ transport, port: transport === 'network' ? printer.port || 9100 : 0 });
            }}
          >
            {(Object.keys(TRANSPORT_LABELS) as POSPrinterTransport[]).map((transport) => (
              <option key={transport} value={transport}>{TRANSPORT_LABELS[transport]}</option>
            ))}
          </select>
        </LabelBlock>
      </div>

      <div className="settings-field-row">
        <LabelBlock
          label={
            printer.transport === 'network'
              ? 'Host or IP address'
              : printer.transport === 'system'
                ? 'Installed printer name'
                : 'Device path or port'
          }
        >
          <input
            className="glass-input"
            disabled={props.disabled}
            placeholder={
              printer.transport === 'network'
                ? '192.168.1.50'
                : printer.transport === 'system'
                  ? 'EPSON TM-T88VI Receipt'
                  : '/dev/usb/lp0'
            }
            value={printer.address}
            onChange={(event) => props.onChange({ address: event.target.value })}
          />
        </LabelBlock>

        {printer.transport === 'network' && (
          <LabelBlock label="Port">
            <input
              className="glass-input"
              type="number"
              min={1}
              max={65535}
              disabled={props.disabled}
              value={printer.port}
              onChange={(event) => props.onChange({ port: Number.parseInt(event.target.value, 10) || 9100 })}
            />
          </LabelBlock>
        )}

        <LabelBlock label="Copies">
          <input
            className="glass-input"
            type="number"
            min={1}
            max={5}
            disabled={props.disabled}
            value={printer.copies}
            onChange={(event) => props.onChange({ copies: Number.parseInt(event.target.value, 10) || 1 })}
          />
        </LabelBlock>
      </div>

      {isLabelPrinter ? (
        <div className="settings-field-row">
          <LabelBlock label="Label width (mm)">
            <input
              className="glass-input"
              type="number"
              min={10}
              max={220}
              disabled={props.disabled}
              value={printer.labelWidthMm}
              onChange={(event) => props.onChange({ labelWidthMm: Number.parseFloat(event.target.value) || 50 })}
            />
          </LabelBlock>

          <LabelBlock label="Label height (mm)">
            <input
              className="glass-input"
              type="number"
              min={10}
              max={300}
              disabled={props.disabled}
              value={printer.labelHeightMm}
              onChange={(event) => props.onChange({ labelHeightMm: Number.parseFloat(event.target.value) || 25 })}
            />
          </LabelBlock>

          <LabelBlock label="Head resolution">
            <select
              className="glass-input"
              disabled={props.disabled}
              value={printer.dpi}
              onChange={(event) => props.onChange({ dpi: Number.parseInt(event.target.value, 10) })}
            >
              <option value={152}>152 dpi</option>
              <option value={203}>203 dpi</option>
              <option value={300}>300 dpi</option>
              <option value={600}>600 dpi</option>
            </select>
          </LabelBlock>

          <LabelBlock label="Darkness">
            <input
              className="glass-input"
              type="number"
              min={-30}
              max={30}
              disabled={props.disabled}
              value={printer.darkness}
              onChange={(event) => props.onChange({ darkness: Number.parseInt(event.target.value, 10) || 0 })}
            />
          </LabelBlock>
        </div>
      ) : (
        <div className="settings-field-row">
          <LabelBlock label="Paper width">
            <select
              className="glass-input"
              disabled={props.disabled}
              value={printer.columns}
              onChange={(event) => props.onChange({ columns: Number.parseInt(event.target.value, 10) })}
            >
              <option value={32}>58mm paper (32 columns)</option>
              <option value={42}>80mm paper (42 columns)</option>
              <option value={48}>80mm paper, small font (48 columns)</option>
            </select>
          </LabelBlock>

          <label className="printer-flag standalone">
            <input
              type="checkbox"
              disabled={props.disabled}
              checked={printer.cutPaper}
              onChange={(event) => props.onChange({ cutPaper: event.target.checked })}
            />
            <span>Cut paper after each receipt</span>
          </label>

          <label className="printer-flag standalone">
            <input
              type="checkbox"
              disabled={props.disabled}
              checked={printer.openDrawer}
              onChange={(event) => props.onChange({ openDrawer: event.target.checked })}
            />
            <span>Cash drawer attached to this printer</span>
          </label>
        </div>
      )}

      <div className="settings-inline-actions">
        <button className="ghost-button" disabled={props.disabled || props.isTesting} onClick={props.onTest}>
          {props.isTesting ? 'Testing...' : 'Print test page'}
        </button>
        <button className="ghost-button danger" disabled={props.disabled} onClick={props.onRemove}>
          Remove
        </button>
      </div>

      <div className="field-hint">
        {printer.transport === 'system'
          ? 'Sent through the Windows spooler as a RAW job, so the vendor driver does not re-render the bytes.'
          : printer.transport === 'network'
            ? 'Sent as raw bytes over a TCP socket, the standard port for Epson and Zebra network printers.'
            : 'Written directly to the device. Serial printers must already be configured at the right baud rate.'}
      </div>
    </div>
  );
}

function SearchOverlay(
  props: {
    canPrintLabels: boolean;
    hideOutOfStock: boolean;
    products: Product[];
    onClose: () => void;
    onPick: (product: Product) => void;
    onPrintLabel: (product: Product) => void;
  },
) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'sku' | 'name' | 'category' | 'subcategory'>('all');
  const [results, setResults] = useState<Product[]>(props.products.slice(0, 12));
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = query.trim().toLowerCase();

    function filterByScope(rows: Product[]) {
      return rows.filter((product) => {
        if (props.hideOutOfStock && product.stockOnHand <= 0) {
          return false;
        }

        const categoryToken = getCategoryToken(product.categoryId).toLowerCase();
        if (!term) {
          return true;
        }

        if (scope === 'sku') {
          return product.sku.toLowerCase().includes(term);
        }
        if (scope === 'name') {
          return product.name.toLowerCase().includes(term);
        }
        if (scope === 'category') {
          return categoryToken.includes(term) || product.categoryId.toLowerCase().includes(term);
        }
        if (scope === 'subcategory') {
          return product.subcategory.toLowerCase().includes(term);
        }

        return [
          product.sku.toLowerCase(),
          product.name.toLowerCase(),
          product.subcategory.toLowerCase(),
          product.categoryId.toLowerCase(),
          product.barcode?.toLowerCase() ?? '',
        ].some((value) => value.includes(term));
      });
    }

    if (!term) {
      setResults(filterByScope(props.products).slice(0, 12));
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    const timer = window.setTimeout(() => {
      void searchProducts(term)
        .then((rows) => {
          if (!cancelled) {
            setResults(filterByScope(rows).slice(0, 24));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults(filterByScope(props.products).slice(0, 24));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearching(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.hideOutOfStock, props.products, query, scope]);

  return (
    <ModalShell onClose={props.onClose} title="Search products" width="wide">
      <div className="search-panel">
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="glass-input search-box"
            // Scans typed here should populate the box instead of jumping
            // straight into the cart, so the global capture stands down.
            data-scanner-passthrough="true"
            placeholder="Search by SKU, barcode, name, or subcategory"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) {
                props.onPick(results[0]);
              }
            }}
          />
          <kbd className="kbd">F3</kbd>
        </div>

        <div className="scope-row">
          {(['all', 'sku', 'name', 'category', 'subcategory'] as const).map((entry) => (
            <button
              key={entry}
              className={scope === entry ? 'active' : ''}
              onClick={() => setScope(entry)}
            >
              {entry}
            </button>
          ))}
        </div>

        <div className="search-results">
          {isSearching && (
            <div className="inline-alert info">
              Searching local SQLite index...
            </div>
          )}
          {results.map((product) => (
            <div key={product.id} className="search-result-row">
              <button className="search-result-main" onClick={() => props.onPick(product)}>
                <div className="product-thumb compact">{getCategoryToken(product.subcategory || product.name)}</div>
                <div className="search-result-copy">
                  <div>{product.name}</div>
                  <div>
                    {product.sku} - {product.subcategory} - stock {formatInteger(product.stockOnHand)}
                    {(product.variants?.length ?? 0) > 0 ? ` - ${formatInteger(product.variants?.length ?? 0)} variants` : ''}
                  </div>
                </div>
                <div className="search-result-price">{formatCurrency(product.priceTiers[0]?.price ?? 0)}</div>
              </button>
              {props.canPrintLabels && (
                <button
                  className="search-result-label-action"
                  title={`Print a shelf label for ${product.name}`}
                  onClick={() => props.onPrintLabel(product)}
                >
                  Label
                </button>
              )}
            </div>
          ))}
          {results.length === 0 && (
            <div className="empty-state compact">
              <div className="empty-title">No products matched "{query}"</div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

type VariantAttributeGroup = {
  id: string;
  name: string;
  type?: ProductVariant['attributes'][number]['attributeType'];
  values: Array<{
    id: string;
    label: string;
    representedValue?: string;
    sortOrder: number;
  }>;
};

function buildVariantSelectionMap(variant?: ProductVariant | null): Record<string, string> {
  return Object.fromEntries((variant?.attributes ?? []).map((attribute) => [attribute.attributeId, attribute.valueId]));
}

function variantMatchesSelection(
  variant: ProductVariant,
  selection: Record<string, string>,
  ignoreAttributeId?: string,
): boolean {
  for (const [attributeId, valueId] of Object.entries(selection)) {
    if (!valueId || attributeId === ignoreAttributeId) {
      continue;
    }

    if (!variant.attributes.some((attribute) => (
      attribute.attributeId === attributeId
      && attribute.valueId === valueId
    ))) {
      return false;
    }
  }

  return true;
}

function collectVariantAttributeGroups(variants: ProductVariant[]): VariantAttributeGroup[] {
  const groups = new Map<
    string,
    {
      id: string;
      name: string;
      type?: VariantAttributeGroup['type'];
      values: Map<string, VariantAttributeGroup['values'][number]>;
    }
  >();

  for (const variant of variants) {
    for (const attribute of variant.attributes) {
      const group = groups.get(attribute.attributeId) ?? {
        id: attribute.attributeId,
        name: attribute.attributeName,
        type: attribute.attributeType,
        values: new Map<string, VariantAttributeGroup['values'][number]>(),
      };

      if (!groups.has(attribute.attributeId)) {
        groups.set(attribute.attributeId, group);
      }

      if (!group.values.has(attribute.valueId)) {
        group.values.set(attribute.valueId, {
          id: attribute.valueId,
          label: attribute.value,
          representedValue: attribute.representedValue,
          sortOrder: attribute.sortOrder ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }
  }

  return Array.from(groups.values()).map((group) => ({
    id: group.id,
    name: group.name,
    type: group.type,
    values: Array.from(group.values.values()).sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }

      return left.label.localeCompare(right.label);
    }),
  }));
}

function VariantSelectionModal(
  props: {
    initialVariantId?: string | null;
    onClose: () => void;
    onConfirm: (variant: ProductVariant) => void;
    product: Product;
  },
) {
  const variants = useMemo(() => props.product.variants ?? [], [props.product.variants]);
  const attributeGroups = useMemo(() => collectVariantAttributeGroups(variants), [variants]);
  const isSingleAxis = attributeGroups.length <= 1;
  const resolvedInitialVariant = useMemo(
    () => variants.find((variant) => variant.id === props.initialVariantId) ?? variants[0] ?? null,
    [props.initialVariantId, variants],
  );
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(resolvedInitialVariant?.id ?? null);
  const [selectedValues, setSelectedValues] = useState<Record<string, string>>(() => (
    buildVariantSelectionMap(resolvedInitialVariant)
  ));

  useEffect(() => {
    setSelectedVariantId(resolvedInitialVariant?.id ?? null);
    setSelectedValues(buildVariantSelectionMap(resolvedInitialVariant));
  }, [props.initialVariantId, props.product.id, resolvedInitialVariant?.id]);

  const selectedVariant = useMemo(
    () => variants.find((variant) => variant.id === selectedVariantId)
      ?? variants.find((variant) => variantMatchesSelection(variant, selectedValues))
      ?? resolvedInitialVariant
      ?? null,
    [resolvedInitialVariant, selectedValues, selectedVariantId, variants],
  );

  const handleDirectVariantPick = useCallback((variant: ProductVariant) => {
    setSelectedVariantId(variant.id);
    setSelectedValues(buildVariantSelectionMap(variant));
  }, []);

  const handleAttributePick = useCallback((attributeId: string, valueId: string) => {
    const nextSelection = {
      ...selectedValues,
      [attributeId]: valueId,
    };
    const matchedVariant = variants.find((variant) => variantMatchesSelection(variant, nextSelection));
    if (matchedVariant == null) {
      return;
    }

    setSelectedVariantId(matchedVariant.id);
    setSelectedValues(buildVariantSelectionMap(matchedVariant));
  }, [selectedValues, variants]);

  return (
    <ModalShell onClose={props.onClose} title={`Choose variant - ${props.product.name}`} width="wide">
      <div className="modal-stack variant-modal">
        {variants.length === 0 ? (
          <div className="empty-state compact">
            <div className="empty-title">No variants are configured for this product.</div>
          </div>
        ) : (
          <>
            <div className="variant-modal-copy">
              {isSingleAxis
                ? 'Choose the variant before sending the item into the active sale.'
                : 'Choose each attribute below. The selector keeps the combination on a real stocked variant.'}
            </div>

            {isSingleAxis ? (
              <div className="variant-tile-grid">
                {variants.map((variant) => {
                  const label = getProductVariantLabel(variant);
                  return (
                    <button
                      key={variant.id}
                      className={`variant-choice-tile ${selectedVariant?.id === variant.id ? 'active' : ''}`}
                      onClick={() => handleDirectVariantPick(variant)}
                    >
                      <div className="variant-choice-head">
                        <span>{label}</span>
                        <span className="variant-choice-stock">Stock {formatInteger(variant.stockOnHand)}</span>
                      </div>
                      <div className="variant-choice-subtitle">{variant.variantCode}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="variant-attribute-stack">
                {attributeGroups.map((group) => (
                  <section key={group.id} className="variant-attribute-group">
                    <div className="variant-attribute-title">{group.name}</div>
                    <div className="variant-attribute-options">
                      {group.values.map((value) => {
                        const isAvailable = variants.some((variant) => (
                          variantMatchesSelection(variant, selectedValues, group.id)
                          && variant.attributes.some((attribute) => (
                            attribute.attributeId === group.id
                            && attribute.valueId === value.id
                          ))
                        ));
                        const swatchColor = value.representedValue || (group.type === 'color' ? value.label : undefined);

                        return (
                          <button
                            key={value.id}
                            className={[
                              'variant-attribute-option',
                              selectedValues[group.id] === value.id ? 'active' : '',
                              !isAvailable ? 'unavailable' : '',
                            ].filter(Boolean).join(' ')}
                            disabled={!isAvailable}
                            onClick={() => handleAttributePick(group.id, value.id)}
                          >
                            {swatchColor && <span className="variant-color-dot" style={{ backgroundColor: swatchColor }} />}
                            <span>{value.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}

            <div className="variant-selection-card">
              <div>
                <div className="meta-label">Selected variant</div>
                <div className="variant-selection-title">
                  {selectedVariant != null ? getProductVariantLabel(selectedVariant) : 'Choose a variant'}
                </div>
                {selectedVariant != null && selectedVariant.attributes.length > 0 && (
                  <div className="variant-selection-attributes">
                    {selectedVariant.attributes.map((attribute) => `${attribute.attributeName}: ${attribute.value}`).join(' | ')}
                  </div>
                )}
              </div>
              {selectedVariant != null && (
                <div className="variant-selection-meta">
                  <span>{selectedVariant.variantCode}</span>
                  <span>Stock {formatInteger(selectedVariant.stockOnHand)}</span>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button className="ghost-button" onClick={props.onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={selectedVariant == null}
                onClick={() => {
                  if (selectedVariant != null) {
                    props.onConfirm(selectedVariant);
                  }
                }}
              >
                Use this variant
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function PaymentModal(
  props: {
    total: number;
    onClose: () => void;
    onComplete: (payments: PaymentInput[]) => void;
    /** Reports live tender so the customer display can follow the payment. */
    onProgressChange: (progress: CustomerDisplayPaymentProgress) => void;
    addDenominationsToPaymentList: boolean;
    showDenominationCombinations: boolean;
    allowShortPayments: boolean;
  },
) {
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [tendered, setTendered] = useState(0);
  const [reference, setReference] = useState('');
  const [splitPayments, setSplitPayments] = useState<PaymentInput[]>([]);
  const isSplit = true;
  const [installmentCount, setInstallmentCount] = useState(3);
  const [denominationCounts, setDenominationCounts] = useState<Record<string, number>>({});
  const [isTenderedManuallyEdited, setIsTenderedManuallyEdited] = useState(false);
  const splitPaid = roundToMoney(splitPayments.reduce((sum, payment) => sum + payment.amount, 0));
  const splitRemaining = Math.max(0, roundToMoney(props.total - splitPaid));
  const splitChange = roundToMoney(splitPayments.reduce((sum, payment) => sum + (payment.changeDue ?? 0), 0));
  const change = Math.max(0, roundToMoney(tendered - props.total));

  // Change is what has already been given back on completed entries, plus what
  // the amount now being keyed would return once it is added.
  const progressChange = roundToMoney(splitChange + Math.max(0, roundToMoney(tendered - splitRemaining)));
  const onProgressChange = props.onProgressChange;
  useEffect(() => {
    onProgressChange({
      payments: splitPayments,
      tendered,
      balanceDue: splitRemaining,
      changeDue: progressChange,
    });
  }, [onProgressChange, progressChange, splitPayments, splitRemaining, tendered]);

  const quickAmounts = useMemo(() => {
    const rounded100 = Math.ceil(props.total / 100) * 100;
    const rounded500 = Math.ceil(props.total / 500) * 500;
    const rounded1000 = Math.ceil(props.total / 1000) * 1000;
    return [...new Set([props.total, rounded100, rounded500, rounded1000])];
  }, [props.total]);

  const possibleDenominationCombinations = useMemo(() => {
    if (method !== PaymentMethod.CASH || !props.showDenominationCombinations || !isTenderedManuallyEdited || Object.keys(denominationCounts).length > 0) {
      return [] as number[][];
    }

    const target = Math.round(tendered);
    if (target <= 0 || Math.abs(tendered - target) > 0.001) {
      return [] as number[][];
    }

    const results: number[][] = [];
    const values = DENOMINATIONS.map((entry) => entry.value).sort((left, right) => right - left);
    const search = (remaining: number, startIndex: number, combination: number[]) => {
      if (results.length >= 4 || combination.length > 20) {
        return;
      }
      if (remaining === 0) {
        results.push(combination);
        return;
      }

      for (let index = startIndex; index < values.length; index += 1) {
        const value = values[index];
        if (value > remaining) {
          continue;
        }
        search(remaining - value, index, [...combination, value]);
      }
    };
    search(target, 0, []);
    return results;
  }, [denominationCounts, isTenderedManuallyEdited, method, props.showDenominationCombinations, tendered]);

  /**
   * How to hand the change back, and whether asking the customer for a little
   * more would make it simpler. Computed against the amount still outstanding
   * on the bill, so it stays correct part-way through a split payment.
   */
  const changeGuidance = useMemo(() => {
    const dueNow = Math.min(splitRemaining, roundToMoney(tendered));
    const changeAmount = roundToMoney(tendered - dueNow);
    if (changeAmount <= 0) {
      return null;
    }

    return {
      amount: changeAmount,
      breakdowns: suggestChangeBreakdowns(changeAmount, 3),
      topUps: suggestTenderTopUps(splitRemaining, tendered, 3),
    };
  }, [splitRemaining, tendered]);

  const hasUnsavedChanges = method !== PaymentMethod.CASH
    || tendered !== 0
    || reference.trim().length > 0
    || splitPayments.length > 0
    || Object.keys(denominationCounts).length > 0
    || installmentCount !== 3;

  const handleClose = () => {
    if (hasUnsavedChanges && !window.confirm('You have payment changes that have not been completed. Close this window?')) {
      return;
    }
    props.onClose();
  };

  const selectMethod = (nextMethod: PaymentMethod) => {
    setMethod(nextMethod);
    setIsTenderedManuallyEdited(false);
    setTendered(0);
  };

  const addSplitPayment = () => {
    if (splitRemaining <= 0) {
      return;
    }
    if (method === PaymentMethod.GIFT && !reference.trim()) {
      return;
    }

    const entered = Math.max(0, roundToMoney(tendered));
    if (method === PaymentMethod.INSTALLMENT) {
      setSplitPayments((current) => [...current, {
        method,
        amount: splitRemaining,
        tenderedAmount: splitRemaining,
        changeDue: 0,
        metadata: {
          type: 'INSTALLMENT_PLAN',
          numberOfInstallments: installmentCount,
          installmentAmount: roundToMoney(props.total / installmentCount),
        },
      }]);
      setTendered(0);
      return;
    }
    if (entered <= 0) {
      return;
    }

    const amount = Math.min(entered, splitRemaining);
    setSplitPayments((current) => [...current, {
      method,
      amount,
      tenderedAmount: method === PaymentMethod.CASH ? entered : amount,
      changeDue: method === PaymentMethod.CASH ? roundToMoney(entered - amount) : 0,
      reference: method === PaymentMethod.CASH ? undefined : reference.trim() || undefined,
      metadata: method === PaymentMethod.CASH && Object.keys(denominationCounts).length > 0
        ? { denominations: denominationCounts }
        : undefined,
    }]);
    setReference('');
    setDenominationCounts({});
    setIsTenderedManuallyEdited(false);
    setTendered(0);
  };

  const completeSplitPayment = () => {
    if (splitPaid <= 0 || (!props.allowShortPayments && splitRemaining > 0)) {
      return;
    }

    const completedPayments = props.allowShortPayments && splitRemaining > 0
      ? splitPayments.map((payment, index) => index === splitPayments.length - 1
        ? {
          ...payment,
          metadata: {
            ...(payment.metadata ?? {}),
            underpayment: true,
            balanceDue: splitRemaining,
          },
        }
        : payment)
      : splitPayments;
    props.onComplete(completedPayments);
  };

  return (
    <ModalShell onClose={handleClose} title="Payment" width="payment">
      <div className="payment-layout">
        <div className="payment-methods">
          {PAYMENT_OPTIONS.map((option) => (
            <button
              key={option.method}
              className={`payment-method ${method === option.method ? 'active' : ''}`}
              onClick={() => selectMethod(option.method)}
            >
              <span>{option.short}</span>
              <div>{option.label}</div>
            </button>
          ))}
        </div>

        <div className={`payment-main ${isSplit ? 'split-payment-main' : ''}`}>
          <div className="meta-label">Total due</div>
          <div className="payment-total">{formatCurrency(props.total)}</div>

          {isSplit && (
            <aside className="payment-stack-sidebar">
              <div className="payment-stack-head">
                <span className="meta-label">Payment stack</span>
                <span>{splitPayments.length} source{splitPayments.length === 1 ? '' : 's'}</span>
              </div>
              {splitPayments.length === 0 && (!props.addDenominationsToPaymentList || Object.keys(denominationCounts).length === 0) ? (
                <div className="payment-stack-empty">Add cash, card or another source to settle this bill.</div>
              ) : (
                <div className="payment-stack-list">
                  {splitPayments.map((payment, index) => {
                    const label = PAYMENT_OPTIONS.find((option) => option.method === payment.method)?.label ?? payment.method;
                    const denominationSummary = payment.metadata?.denominations
                      ? Object.entries(payment.metadata.denominations as Record<string, number>)
                        .map(([value, count]) => `${value}×${count}`)
                        .join(' · ')
                      : '';
                    return (
                      <div className="payment-stack-item" key={`${payment.method}-${index}`}>
                        <span>{label}{denominationSummary && <small>{denominationSummary}</small>}</span>
                        <b>{formatCurrency(payment.amount)}</b>
                        <button
                          className="payment-stack-remove"
                          aria-label={`Remove ${label} payment`}
                          onClick={() => setSplitPayments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  {props.addDenominationsToPaymentList && Object.keys(denominationCounts).length > 0 && (
                    <div className="payment-stack-item payment-stack-draft">
                      <span>Cash selected<small>{Object.entries(denominationCounts).map(([value, count]) => `${value}×${count}`).join(' · ')}</small></span>
                      <b>{formatCurrency(tendered)}</b>
                    </div>
                  )}
                </div>
              )}
              <div className="payment-stack-total"><span>{props.allowShortPayments ? 'Balance due' : 'Remaining'}</span><b>{formatCurrency(splitRemaining)}</b></div>
              {props.allowShortPayments && splitRemaining > 0 && <div className="payment-stack-underpayment">Short payment is allowed by admin settings.</div>}
              {splitChange > 0 && <div className="payment-stack-change"><span>Change</span><b>{formatCurrency(splitChange)}</b></div>}
            </aside>
          )}

          {method === PaymentMethod.INSTALLMENT ? (
            <LabelBlock label="Number of installments">
              <SearchableSelect
                className="glass-input large"
                value={String(installmentCount)}
                disabled={splitPayments.length > 0}
                onChange={(value) => setInstallmentCount(Number(value))}
                options={[2, 3, 4, 6, 12].map((count) => ({ value: String(count), label: `${count} installments` }))}
                ariaLabel="Number of installments"
              />
              <div className="installment-preview">
                {formatCurrency(roundToMoney(props.total / installmentCount))} per installment
              </div>
            </LabelBlock>
          ) : (
            <LabelBlock label={method === PaymentMethod.CASH ? 'Tendered' : 'Amount'}>
            <input
              className="glass-input large"
              disabled={false}
              type="number"
              min={0}
              step={0.01}
              value={tendered}
              onChange={(event) => {
                setIsTenderedManuallyEdited(true);
                setDenominationCounts({});
                setTendered(Number(event.target.value) || 0);
              }}
            />
            </LabelBlock>
          )}

          {method !== PaymentMethod.INSTALLMENT && <div className="quick-cash-row">
            {(isSplit ? [...new Set([splitRemaining, ...quickAmounts.filter((amount) => amount >= splitRemaining)])] : quickAmounts).map((amount) => (
              <button key={amount} className="quick-cash" onClick={() => { setIsTenderedManuallyEdited(false); setDenominationCounts({}); setTendered(amount); }}>
                {formatCurrency(amount)}
              </button>
            ))}
          </div>}
          {method === PaymentMethod.CASH && (
            <div className="cash-denomination-shortcuts">
              <div className="meta-label">Cash denomination shortcuts</div>
              <div className="cash-denomination-list">
                {DENOMINATIONS.map((denomination) => (
                  <button
                    key={denomination.value}
                    className="cash-denomination-button"
                    onClick={() => {
                      setIsTenderedManuallyEdited(false);
                      setTendered((current) => roundToMoney(current + denomination.value));
                      if (props.addDenominationsToPaymentList) {
                        setDenominationCounts((current) => ({
                          ...current,
                          [String(denomination.value)]: (current[String(denomination.value)] ?? 0) + 1,
                        }));
                      }
                    }}
                    title={`Add ${denomination.label}`}
                  >
                    <img src={`./currency/${denomination.value}.png`} alt="" />
                    <span>{denomination.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {method === PaymentMethod.CASH && props.showDenominationCombinations && possibleDenominationCombinations.length > 0 && (
            <div className="denomination-suggestions">
              <div className="meta-label">Possible combinations</div>
              {possibleDenominationCombinations.map((combination, index) => (
                <div className="denomination-suggestion" key={`${combination.join('-')}-${index}`}>
                  {combination.map((value) => formatCurrency(value)).join(' + ')}
                </div>
              ))}
            </div>
          )}

          {method === PaymentMethod.CASH && changeGuidance != null && (
            <div className="change-guidance">
              <div className="meta-label">Change for {formatCurrency(changeGuidance.amount)}</div>

              {changeGuidance.breakdowns.length === 0 ? (
                <div className="change-guidance-empty">
                  This amount cannot be made exactly from the denominations in use.
                </div>
              ) : (
                <div className="change-option-list">
                  {changeGuidance.breakdowns.map((option, index) => (
                    <div className={`change-option ${index === 0 ? 'preferred' : ''}`} key={formatDenominationBreakdown(option)}>
                      <span className="change-option-pieces">{formatDenominationBreakdown(option)}</span>
                      <small>{formatInteger(option.pieceCount)} piece{option.pieceCount === 1 ? '' : 's'}</small>
                    </div>
                  ))}
                </div>
              )}

              {changeGuidance.topUps.length > 0 && (
                <>
                  <div className="meta-label">Or ask for a little more</div>
                  <div className="change-option-list">
                    {changeGuidance.topUps.map((topUp) => (
                      <button
                        className="change-option topup"
                        key={topUp.askFor}
                        onClick={() => {
                          setIsTenderedManuallyEdited(false);
                          setDenominationCounts({});
                          setTendered(roundToMoney(tendered + topUp.askFor));
                        }}
                        title={`Set the tendered amount to ${formatCurrency(tendered + topUp.askFor)}`}
                      >
                        <span className="change-option-pieces">
                          Ask for {formatCurrency(topUp.askFor)} ({formatDenominationBreakdown(topUp.askBreakdown)})
                        </span>
                        <small>
                          Change becomes {formatDenominationBreakdown(topUp.changeBreakdown)}
                          {' · '}{formatInteger(topUp.piecesSaved)} fewer piece{topUp.piecesSaved === 1 ? '' : 's'}
                        </small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {method !== PaymentMethod.CASH && method !== PaymentMethod.INSTALLMENT && (
            <LabelBlock label="Reference">
              <input
                className="glass-input"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder={method === PaymentMethod.GIFT ? 'Voucher code (required)' : 'Auth code / last 4 digits'}
              />
            </LabelBlock>
          )}

          <div className="payment-change-row">
            <span>Change</span>
            <b>{formatCurrency(isSplit ? splitChange : change)}</b>
          </div>

          {isSplit ? (
            <div className="payment-split-actions">
              <button className="ghost-button" disabled={splitRemaining <= 0 || (method !== PaymentMethod.INSTALLMENT && tendered <= 0) || (method === PaymentMethod.GIFT && !reference.trim())} onClick={addSplitPayment}>
                {method === PaymentMethod.INSTALLMENT ? 'Add installment plan' : 'Add payment source'}
              </button>
              <button className="btn-primary full-width" disabled={splitPaid <= 0 || (!props.allowShortPayments && splitRemaining > 0)} onClick={completeSplitPayment}>
                Complete sale
              </button>
            </div>
          ) : (
            <button
              className="btn-primary full-width"
              disabled={(method === PaymentMethod.CASH && tendered < props.total) || (method === PaymentMethod.GIFT && !reference.trim())}
              onClick={() => props.onComplete(buildPayments(props.total, method, tendered, change, reference))}
            >
              Complete sale
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function HoldRecallModal(
  props: {
    cartItemCount: number;
    heldSales: HeldSaleSummary[];
    mode: HoldMode;
    onClose: () => void;
    onHold: () => void;
    onRecall: (heldSale: HeldSaleSummary) => void;
  },
) {
  const orderedHeldSales = useMemo(
    () => [...props.heldSales].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [props.heldSales],
  );

  return (
    <ModalShell onClose={props.onClose} title="Held bills" width="medium">
      <div className="modal-stack">
        <div className="held-toolbar">
          <div>{props.heldSales.length} bills currently on hold</div>
          <button className="btn-primary" onClick={props.onHold} disabled={props.cartItemCount === 0 || props.mode === 'recall'}>
            Save current bill
          </button>
        </div>

        <div className="held-list">
          {orderedHeldSales.map((heldSale) => (
            <button key={heldSale.id} className="held-row" onClick={() => props.onRecall(heldSale)}>
              <div>
                <div className="held-id">{heldSale.holdNumber}</div>
                <div className="held-copy">{heldSale.customerName ?? 'Walk-in'} - {heldSale.itemCount} items</div>
                <div className="held-meta">{heldSale.cashierName} - {formatDateTime(heldSale.createdAt)}</div>
              </div>
              <div className="held-side">
                <div>{formatCurrency(heldSale.total)}</div>
                <span>Recall</span>
              </div>
            </button>
          ))}
          {orderedHeldSales.length === 0 && (
            <div className="empty-state compact">
              <div className="empty-title">No held bills are waiting on this workstation.</div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

type MoneyDeclareSubmission = {
  counts: Record<string, number>;
  tenders: Record<string, number>;
  /** Which tender buckets were asked for on this close. */
  declaredTenders: string[];
  /** Cash variance against the transaction log, recorded with the declaration. */
  variance?: number;
};

function MoneyDeclareModal(
  props: {
    cashSalesHidden: boolean;
    mode: MoneyModalMode;
    report: ZReportSummary | null;
    reportError: string;
    isReportLoading: boolean;
    settings: POSShiftReconciliationSettings;
    onClose: () => void;
    onSubmit: (submission: MoneyDeclareSubmission) => void;
  },
) {
  const [counts, setCounts] = useState<Record<string, number>>(() => createEmptyDenominationCounts());
  const [tenders, setTenders] = useState<Record<string, number>>({});
  const isClosing = props.mode === 'close';
  // Non-cash tender is reconciled against completed sales, which only exist at
  // close; asking for it when opening a shift would have nothing to compare to.
  const declaredTenderKeys = isClosing ? props.settings.declaredTenders : [];

  const declaration = useMemo(
    () => buildCashDeclaration(
      isClosing ? CashCountMode.CLOSING : CashCountMode.OPENING,
      counts,
      { tenders, declaredTenders: declaredTenderKeys },
    ),
    [counts, declaredTenderKeys, isClosing, tenders],
  );

  const reconciliation: ShiftReconciliation | null = useMemo(() => {
    if (!isClosing || props.report == null) return null;
    return summarizeShiftReconciliation(props.report, declaration, props.settings);
  }, [declaration, isClosing, props.report, props.settings]);

  // A host running a build from before drawer movements existed answers the
  // Z-report without this list at all, and a close screen must not die on it.
  const cashMovements = props.report?.cashMovements ?? [];

  const tenderRows = declaredTenderKeys.map((key) => ({
    key,
    label: PAYMENT_METHOD_LABELS[key] ?? key,
  }));

  const updateTender = (key: string, value: number) => {
    setTenders((previous) => ({ ...previous, [key]: Math.max(0, value) }));
  };

  const handleSubmit = () => {
    props.onSubmit({
      counts,
      tenders,
      declaredTenders: declaredTenderKeys,
      variance: reconciliation?.cash.variance,
    });
  };

  const varianceClass = (variance: number, flagged: boolean) => {
    if (flagged) return 'variance-alert';
    return variance === 0 ? 'variance-ok' : 'variance-warn';
  };

  return (
    <ModalShell
      onClose={props.onClose}
      title={isClosing ? 'Close shift - declaration' : 'Open shift - money declare'}
      width="wide"
    >
      <div className="modal-stack">
        <div className="cash-grid">
          <div>
            <div className="meta-label">Notes</div>
            {DENOMINATIONS.filter((entry) => entry.kind === 'note').map((entry) => (
              <DenominationRow
                key={entry.value}
                count={counts[String(entry.value)] ?? 0}
                denomination={entry}
                onChange={(nextCount) => setCounts((previous) => ({ ...previous, [String(entry.value)]: Math.max(0, nextCount) }))}
              />
            ))}
          </div>
          <div>
            <div className="meta-label">Coins</div>
            {DENOMINATIONS.filter((entry) => entry.kind === 'coin').map((entry) => (
              <DenominationRow
                key={entry.value}
                count={counts[String(entry.value)] ?? 0}
                denomination={entry}
                onChange={(nextCount) => setCounts((previous) => ({ ...previous, [String(entry.value)]: Math.max(0, nextCount) }))}
              />
            ))}
          </div>
        </div>

        <div className="cash-total-bar">
          <div>
            <div className="meta-label">{isClosing ? 'Counted drawer' : 'Declared float'}</div>
            <div className="payment-total">{formatCurrency(declaration.total)}</div>
          </div>
          {isClosing && !props.cashSalesHidden && reconciliation != null && (
            <div className="variance-card">
              <div className="meta-label">Expected drawer</div>
              <div>{formatCurrency(reconciliation.cash.expected)}</div>
              <div className={varianceClass(reconciliation.cash.variance, reconciliation.cash.flagged)}>
                Variance {formatCurrency(reconciliation.cash.variance)}
              </div>
            </div>
          )}
        </div>

        {isClosing && !props.cashSalesHidden && cashMovements.length > 0 && (
          <section className="tender-declare">
            <div className="settings-card-head">
              <div>
                <div className="section-kicker">Drawer movements</div>
                <div className="section-title">Cash moved during this shift</div>
              </div>
              <div className="report-chip mono">Already in the expected drawer</div>
            </div>
            <div className="tender-declare-list">
              {cashMovements.map((movement) => (
                <div className="tender-declare-row" key={movement.id}>
                  <span className="tender-declare-label">
                    {movement.direction === 'in' ? 'Cash in' : 'Cash out'}
                  </span>
                  <span className="tender-declare-expected">{movement.reason ?? 'No reason recorded'}</span>
                  <span className="tender-declare-expected">{formatTime(movement.createdAt)}</span>
                  <span className={`tender-declare-variance ${movement.direction === 'in' ? 'variance-ok' : 'variance-warn'}`}>
                    {movement.direction === 'in' ? '+' : '-'}{formatCurrency(movement.amount)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {isClosing && props.isReportLoading && (
          <div className="inline-alert info">Loading this shift's transaction log to reconcile the declaration...</div>
        )}

        {isClosing && props.reportError !== '' && (
          <div className="inline-alert warning">
            {props.reportError} The declaration will still be recorded, but it cannot be checked against the transaction log.
          </div>
        )}

        {tenderRows.length > 0 && (
          <section className="tender-declare">
            <div className="settings-card-head">
              <div>
                <div className="section-kicker">Non-cash tender</div>
                <div className="section-title">
                  {tenderMode === 'category' ? 'Declare each payment type' : 'Declare the non-cash total'}
                </div>
              </div>
              <div className="report-chip mono">Checked against the transaction log</div>
            </div>

            <div className="tender-declare-list">
              {tenderRows.map((row) => {
                const summary = reconciliation?.tenders.find((entry) => entry.key === row.key);
                const expected = summary?.expected
                  ?? (row.key === TENDER_TOTAL_KEY
                    ? Object.entries(props.report?.paymentBreakdown ?? {})
                      .filter(([method]) => method !== PaymentMethod.CASH)
                      .reduce((sum, [, amount]) => sum + amount, 0)
                    : props.report?.paymentBreakdown[row.key] ?? 0);

                return (
                  <div className="tender-declare-row" key={row.key}>
                    <span className="tender-declare-label">{row.label}</span>
                    <input
                      className="glass-input compact"
                      type="number"
                      min={0}
                      step={0.01}
                      value={tenders[row.key] ?? 0}
                      onChange={(event) => updateTender(row.key, Number(event.target.value) || 0)}
                      aria-label={`Declared ${row.label}`}
                    />
                    <span className="tender-declare-expected">
                      Expected {formatCurrency(expected)}
                    </span>
                    <span className={`tender-declare-variance ${summary ? varianceClass(summary.variance, summary.flagged) : ''}`}>
                      {summary ? formatCurrency(summary.variance) : '--'}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {reconciliation?.hasAlert && (
          <div className="inline-alert danger">
            <b>Large discrepancy against the transaction log.</b>
            <ul className="discrepancy-list">
              {reconciliation.flaggedRows.map((row) => (
                <li key={row.key}>
                  {row.label}: declared {formatCurrency(row.declared)} against {formatCurrency(row.expected)} expected
                  {' '}({row.variance > 0 ? 'over' : 'short'} by {formatCurrency(Math.abs(row.variance))}).
                </li>
              ))}
            </ul>
            <small>
              Threshold: {formatCurrency(props.settings.alertThresholdAmount)} or {props.settings.alertThresholdPercent}% of the expected figure.
            </small>
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost-button" onClick={props.onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit}>
            {isClosing ? 'Submit and close shift' : 'Confirm and open shift'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

const CASH_IN_REASONS = ['Change reload from the safe', 'Float top-up', 'Petty cash returned'];
const CASH_OUT_REASONS = ['Safe drop', 'Banking', 'Supplier payout', 'Petty cash taken'];

/**
 * Records a mid-shift drawer movement.
 *
 * Counted by denomination like every other cash declaration, because the point
 * is that the expected drawer at close accounts for it. A reason is mandatory:
 * an unexplained movement is indistinguishable from a shortage.
 */
function CashMovementModal(
  props: {
    expectedDrawer?: number;
    isSaving: boolean;
    onClose: () => void;
    onSubmit: (input: { direction: 'in' | 'out'; counts: Record<string, number>; reason: string }) => void;
  },
) {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [counts, setCounts] = useState<Record<string, number>>(() => createEmptyDenominationCounts());
  const [reason, setReason] = useState('');

  const total = useMemo(
    () => buildCashDeclaration(
      direction === 'in' ? CashCountMode.PAID_IN : CashCountMode.PAID_OUT,
      counts,
    ).total,
    [counts, direction],
  );

  const reasonOptions = direction === 'in' ? CASH_IN_REASONS : CASH_OUT_REASONS;
  const trimmedReason = reason.trim();
  const exceedsDrawer = direction === 'out' && props.expectedDrawer != null && total > props.expectedDrawer;
  const canSubmit = total > 0 && trimmedReason !== '' && !props.isSaving;

  return (
    <ModalShell onClose={props.onClose} title="Cash in / cash out" width="wide">
      <div className="modal-stack">
        <div className="theme-option-row">
          <button
            className={`theme-option ${direction === 'in' ? 'active' : ''}`}
            onClick={() => setDirection('in')}
          >
            <span className="theme-option-title">Cash in</span>
            <span className="theme-option-copy">Reloading change or topping the float up from the safe.</span>
          </button>
          <button
            className={`theme-option ${direction === 'out' ? 'active' : ''}`}
            onClick={() => setDirection('out')}
          >
            <span className="theme-option-title">Cash out</span>
            <span className="theme-option-copy">Dropping takings to the safe, banking, or paying something out.</span>
          </button>
        </div>

        <div className="cash-grid">
          <div>
            <div className="meta-label">Notes</div>
            {DENOMINATIONS.filter((entry) => entry.kind === 'note').map((entry) => (
              <DenominationRow
                key={entry.value}
                count={counts[String(entry.value)] ?? 0}
                denomination={entry}
                onChange={(nextCount) => setCounts((previous) => ({ ...previous, [String(entry.value)]: Math.max(0, nextCount) }))}
              />
            ))}
          </div>
          <div>
            <div className="meta-label">Coins</div>
            {DENOMINATIONS.filter((entry) => entry.kind === 'coin').map((entry) => (
              <DenominationRow
                key={entry.value}
                count={counts[String(entry.value)] ?? 0}
                denomination={entry}
                onChange={(nextCount) => setCounts((previous) => ({ ...previous, [String(entry.value)]: Math.max(0, nextCount) }))}
              />
            ))}
          </div>
        </div>

        <LabelBlock label="Reason">
          <input
            className="glass-input"
            value={reason}
            maxLength={140}
            placeholder={direction === 'in' ? 'Why is cash going in?' : 'Why is cash coming out?'}
            onChange={(event) => setReason(event.target.value)}
          />
        </LabelBlock>

        <div className="reason-chip-row">
          {reasonOptions.map((option) => (
            <button
              key={option}
              className={`reason-chip ${trimmedReason === option ? 'active' : ''}`}
              onClick={() => setReason(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="cash-total-bar">
          <div>
            <div className="meta-label">{direction === 'in' ? 'Cash going in' : 'Cash coming out'}</div>
            <div className="payment-total">{formatCurrency(total)}</div>
          </div>
          {props.expectedDrawer != null && (
            <div className="variance-card">
              <div className="meta-label">Drawer after this</div>
              <div className={exceedsDrawer ? 'variance-alert' : ''}>
                {formatCurrency(direction === 'in' ? props.expectedDrawer + total : props.expectedDrawer - total)}
              </div>
            </div>
          )}
        </div>

        {exceedsDrawer && (
          <div className="inline-alert warning">
            This takes out more than the drawer is expected to hold. Recheck the count before submitting.
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost-button" onClick={props.onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!canSubmit}
            onClick={() => props.onSubmit({ direction, counts, reason: trimmedReason })}
          >
            {props.isSaving ? 'Recording...' : direction === 'in' ? 'Record cash in' : 'Record cash out'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function DenominationRow(
  props: {
    count: number;
    denomination: { label: string; value: number; kind: 'note' | 'coin' };
    onChange: (nextCount: number) => void;
  },
) {
  return (
    <div className="denomination-row">
      <div className="denomination-visual">
        <button
          aria-label={`Add one ${props.denomination.label}`}
          className="currency-image-button"
          onClick={() => props.onChange(props.count + 1)}
          title={`Add one ${props.denomination.label}`}
          type="button"
        >
          <img
            className={`currency-image ${props.denomination.kind === 'coin' ? 'coin-image' : ''}`}
            src={`./currency/${props.denomination.value}.png`}
            alt=""
          />
        </button>
        <span>{props.denomination.label}</span>
      </div>
      <div className="qty-stepper compact">
        <button onClick={() => props.onChange(props.count - 1)}>-</button>
        <input
          value={props.count}
          onChange={(event) => props.onChange(Number(event.target.value) || 0)}
        />
        <button onClick={() => props.onChange(props.count + 1)}>+</button>
      </div>
      <span>{formatCurrency(props.denomination.value * props.count)}</span>
    </div>
  );
}

type ReportPeriod = 'week' | 'month' | 'year';

function reportPeriodRange(period: ReportPeriod, anchor: Date) {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === 'month') start.setDate(1);
  if (period === 'year') { start.setMonth(0, 1); }
  const end = new Date(start);
  if (period === 'week') end.setDate(end.getDate() + 7);
  if (period === 'month') end.setMonth(end.getMonth() + 1);
  if (period === 'year') end.setFullYear(end.getFullYear() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
}

function moveReportPeriod(period: ReportPeriod, anchor: Date, direction: number) {
  const next = new Date(anchor);
  if (period === 'week') next.setDate(next.getDate() + (7 * direction));
  if (period === 'month') next.setMonth(next.getMonth() + direction);
  if (period === 'year') next.setFullYear(next.getFullYear() + direction);
  return next;
}

function ZReportModal(props: {
  cashSalesHidden: boolean;
  onClose: () => void;
  onPrinted: (result: POSPrintResult) => void;
  terminalId: string;
  terminalCode: string;
}) {
  const [isPrinting, setIsPrinting] = useState(false);
  const [period, setPeriod] = useState<ReportPeriod>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [slots, setSlots] = useState<ZReportSlot[]>([]);
  const [selectedShiftId, setSelectedShiftId] = useState('');
  const [isLoadingSlots, setIsLoadingSlots] = useState(true);
  const [loadError, setLoadError] = useState('');
  const selectedSlot = slots.find((slot) => slot.shift.id === selectedShiftId) ?? slots[0];
  const range = useMemo(() => reportPeriodRange(period, anchor), [period, anchor]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingSlots(true);
    setLoadError('');
    listZReportSlots({ fromDate: range.start.toISOString(), toDate: range.end.toISOString(), terminalId: props.terminalId })
      .then((rows) => {
        if (cancelled) return;
        setSlots(rows);
        setSelectedShiftId((current) => rows.some((row) => row.shift.id === current) ? current : (rows[0]?.shift.id ?? ''));
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Failed to load Z-report slots'); })
      .finally(() => { if (!cancelled) setIsLoadingSlots(false); });
    return () => { cancelled = true; };
  }, [props.terminalId, range.start.getTime(), range.end.getTime()]);

  const visibleReport = selectedSlot?.report;
  const zReading = visibleReport ? {
    paymentCounts: visibleReport.paymentCounts,
    discountedLineCount: visibleReport.discountedLineCount,
    productCount: visibleReport.productCount,
    cashSales: visibleReport.paymentBreakdown.CASH ?? 0,
    nonCashSales: Object.entries(visibleReport.paymentBreakdown).filter(([method]) => method !== 'CASH').reduce((sum, [, amount]) => sum + amount, 0),
  } : null;

  const handlePrint = async () => {
    if (!selectedSlot || !visibleReport) {
      return;
    }

    setIsPrinting(true);
    try {
      props.onPrinted(await printReceiptDocument(buildZReportDocument(
        visibleReport,
        selectedSlot.shift,
        props.terminalCode,
        { cashSalesHidden: props.cashSalesHidden },
      )));
    } finally {
      setIsPrinting(false);
    }
  };

  const downloadSheet = () => {
    if (!selectedSlot || !visibleReport || !zReading) return;
    const rows: Array<[string, string | number, string | number]> = [
      ['Metric', 'Count', 'Amount'],
	  ...(!props.cashSalesHidden ? [
        ['Gross sale', visibleReport.transactionCount, visibleReport.grossSales],
        ['Product discount', zReading.discountedLineCount, visibleReport.discounts],
        ['Refunds', '', visibleReport.refunds],
        ['Net sale', visibleReport.transactionCount, visibleReport.netSales],
	  ] as Array<[string, string | number, string | number]> : [
		['Visible non-cash sale', '', zReading.nonCashSales],
	  ] as Array<[string, string | number, string | number]>),
	  ...(!props.cashSalesHidden ? [
		['Opening float', '', visibleReport.openingFloat],
		['Cash sale', zReading.paymentCounts.CASH ?? 0, zReading.cashSales],
	  ] as Array<[string, string | number, string | number]> : []),
      ['Non-cash total', '', zReading.nonCashSales],
      ...Object.entries(visibleReport.paymentBreakdown).map(([method, amount]) => [method, zReading.paymentCounts[method] ?? 0, amount] as [string, number, number]),
	  ...(!props.cashSalesHidden ? [
		['Expected drawer', '', visibleReport.expectedDrawer],
		['Counted drawer', '', visibleReport.countedDrawer ?? ''],
		['Variance', '', visibleReport.variance ?? ''],
	  ] as Array<[string, string | number, string | number]> : []),
	  ...(!props.cashSalesHidden ? [
        ['Bill count', visibleReport.transactionCount, ''],
        ['Product count', zReading.productCount, ''],
	  ] as Array<[string, string | number, string | number]> : []),
    ];
    const cell = (value: string | number) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = rows.map((row) => `<tr>${row.map((value) => `<td>${cell(value)}</td>`).join('')}</tr>`).join('');
    const html = `<html><head><meta charset="utf-8"></head><body><h2>JINGLES - Z Reading</h2><p>Slot: ${cell(formatShiftReference(selectedSlot.shift, props.terminalCode))}</p><p>Cashier: ${cell(selectedSlot.shift.cashierName)} | Unit: ${cell(props.terminalCode)}</p><table border="1">${body}</table></body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `z-reading-${formatShiftReference(selectedSlot.shift, props.terminalCode).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xls`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <ModalShell onClose={props.onClose} title="Z-report" width="wide">
      <div className="modal-stack z-report-modal">
        <div className="z-period-toolbar">
          <div className="orders-tabs" role="tablist" aria-label="Report period">
            {(['week', 'month', 'year'] as ReportPeriod[]).map((value) => (
              <button key={value} className={period === value ? 'active' : ''} onClick={() => { setPeriod(value); setAnchor(new Date()); }}>
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <div className="z-period-nav">
            <button className="ghost-button" onClick={() => setAnchor((current) => moveReportPeriod(period, current, -1))}>‹</button>
            <strong>{range.start.toLocaleDateString()} – {range.end.toLocaleDateString()}</strong>
            <button className="ghost-button" onClick={() => setAnchor((current) => moveReportPeriod(period, current, 1))}>›</button>
          </div>
        </div>
        {props.cashSalesHidden && (
          <div className="inline-alert info">Cash sales and drawer figures are hidden from this report view.</div>
        )}
        {loadError && <div className="inline-alert error">{loadError}</div>}
        <div className="z-slot-layout">
          <aside className="z-slot-list" aria-label="Z-report slots">
            <h3>Sales slots</h3>
            {isLoadingSlots && <p>Loading slots…</p>}
            {!isLoadingSlots && slots.length === 0 && <p>No open or closed slots in this period.</p>}
            {slots.map((slot) => (
              <button key={slot.shift.id} className={selectedSlot?.shift.id === slot.shift.id ? 'active' : ''} onClick={() => setSelectedShiftId(slot.shift.id)}>
                <strong>{slot.shift.closedAt ? new Date(slot.shift.closedAt).toLocaleDateString() : 'Current open slot'}</strong>
                <span>{formatDateTime(slot.shift.openedAt)} → {slot.shift.closedAt ? formatDateTime(slot.shift.closedAt) : 'Open'}</span>
                <small>{slot.shift.cashierName} · {formatCurrency(props.cashSalesHidden
                  ? Object.entries(slot.report.paymentBreakdown).filter(([method]) => method !== 'CASH').reduce((sum, [, amount]) => sum + amount, 0)
                  : slot.report.netSales)}</small>
              </button>
            ))}
          </aside>
          {selectedSlot && visibleReport && zReading ? <div className="z-reading-paper">
          <header className="z-reading-header">
            <strong>JINGLES</strong>
            <span>For everything you look for</span>
            <span>Cashier: {selectedSlot.shift.cashierName}</span>
            <span>Unit No: {props.terminalCode}</span>
            <span>Location: {selectedSlot.shift.branchId || 'JINGLES'}</span>
            <h2>Z Reading</h2>
            <small>{formatDateTime(selectedSlot.shift.openedAt)}{selectedSlot.shift.closedAt ? ` - ${formatDateTime(selectedSlot.shift.closedAt)}` : ' - Open'}</small>
          </header>

          <div className="z-reading-lines">
			{!props.cashSalesHidden && <>
			  <ReportRow label="Gross sale" value={formatCurrency(visibleReport.grossSales)} />
			  <ReportRow label="Product discount" value={`${formatInteger(zReading.discountedLineCount)}    ${formatCurrency(visibleReport.discounts)}`} muted />
			  <ReportRow label="Refunds" value={formatCurrency(visibleReport.refunds)} muted />
			  <ReportRow label="Net sale" value={formatCurrency(visibleReport.netSales)} strong />
			</>}
			{props.cashSalesHidden && <ReportRow label="Visible non-cash sale" value={formatCurrency(zReading.nonCashSales)} strong />}
          </div>

          {!props.cashSalesHidden && (
            <div className="z-reading-lines">
              <ReportRow label="Cash sale" value={`${formatInteger(zReading.paymentCounts.CASH ?? 0)}    ${formatCurrency(zReading.cashSales)}`} />
              <ReportRow label="Opening float" value={formatCurrency(visibleReport.openingFloat)} />
              {visibleReport.cashPaidIn > 0 && (
                <ReportRow label="Cash in" value={formatCurrency(visibleReport.cashPaidIn)} />
              )}
              {visibleReport.cashPaidOut > 0 && (
                <ReportRow label="Cash out" value={`- ${formatCurrency(visibleReport.cashPaidOut)}`} />
              )}
              <ReportRow label="Expected drawer" value={formatCurrency(visibleReport.expectedDrawer)} strong />
              {visibleReport.countedDrawer != null && <ReportRow label="Declared amount" value={formatCurrency(visibleReport.countedDrawer)} />}
              {visibleReport.variance != null && <ReportRow label="Cash excess / (short)" value={formatCurrency(visibleReport.variance)} strong />}
            </div>
          )}

          <section className="z-reading-noncash">
            <h3>Non cash sales</h3>
            {Object.entries(visibleReport.paymentBreakdown).filter(([method]) => method !== 'CASH').map(([method, amount]) => (
              <ReportRow key={method} label={method} value={`${formatInteger(zReading.paymentCounts[method] ?? 0)}    ${formatCurrency(amount)}`} />
            ))}
            <ReportRow label="Non cash total" value={formatCurrency(zReading.nonCashSales)} strong />
          </section>

          {visibleReport.declaredTenders != null && (
            <section className="z-reading-noncash">
              <h3>Declared at close</h3>
              {Object.entries(visibleReport.declaredTenders).map(([key, declared]) => {
                const expected = key === TENDER_TOTAL_KEY
                  ? zReading.nonCashSales
                  : visibleReport.paymentBreakdown[key] ?? 0;
                return (
                  <ReportRow
                    key={key}
                    label={PAYMENT_METHOD_LABELS[key] ?? key}
                    value={`${formatCurrency(declared)}    (${formatCurrency(declared - expected)})`}
                  />
                );
              })}
            </section>
          )}

          <footer className="z-reading-footer">
			{!props.cashSalesHidden && <>
			  <span>Bill count: {formatInteger(visibleReport.transactionCount)}</span>
			  <span>Product count: {formatInteger(zReading.productCount)}</span>
			</>}
            <span>Slot: {formatShiftReference(selectedSlot.shift, props.terminalCode)}</span>
          </footer>
        </div> : <div className="z-reading-empty">Select a sales slot to view its Z reading.</div>}
        </div>

        <div className="modal-actions">
          <button className="ghost-button" disabled={isPrinting || !selectedSlot} onClick={() => void handlePrint()}>
            {isPrinting ? 'Printing...' : 'Print'}
          </button>
          <button className="ghost-button" onClick={downloadSheet} disabled={!selectedSlot}>Download Excel</button>
          <button className="ghost-button" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </ModalShell>
  );
}

function ReportRow(props: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <>
      <span className={`report-label ${props.muted ? 'muted' : ''} ${props.strong ? 'strong' : ''}`}>{props.label}</span>
      <span className={`report-value ${props.muted ? 'muted' : ''} ${props.strong ? 'strong' : ''}`}>{props.value}</span>
    </>
  );
}

type OrderHistoryTab = 'current' | 'other';

function OrderHistoryModal(
  props: {
    cashSalesHidden: boolean;
    currentTerminalId: string;
    isLoading: boolean;
    isManager: boolean;
    onClose: () => void;
    onOpenReceipt: (sale: SaleSummary) => void;
    sales: SaleSummary[];
    terminals: POSBootstrap['terminals'];
    users: POSUser[];
  },
) {
  const [activeTab, setActiveTab] = useState<OrderHistoryTab>('current');
  const [cashierId, setCashierId] = useState('all');
  const [terminalId, setTerminalId] = useState('all');
  const [query, setQuery] = useState('');

  const terminalMap = useMemo(
    () => new Map(props.terminals.map((terminal) => [terminal.id, terminal])),
    [props.terminals],
  );
  const baseSales = useMemo(
    () => props.sales.filter((sale) => (
      activeTab === 'current'
        ? sale.terminalId === props.currentTerminalId
        : sale.terminalId !== props.currentTerminalId
    )),
    [activeTab, props.currentTerminalId, props.sales],
  );
  const availableCashiers = useMemo(() => {
    const cashierIds = new Set(baseSales.map((sale) => sale.cashierId));
    return props.users
      .filter((user) => cashierIds.has(user.id))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [baseSales, props.users]);
  const availableTerminals = useMemo(() => {
    const terminalIds = new Set(baseSales.map((sale) => sale.terminalId));
    return props.terminals.filter((terminal) => terminalIds.has(terminal.id));
  }, [baseSales, props.terminals]);
  const filteredSales = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return baseSales.filter((sale) => {
      if (cashierId !== 'all' && sale.cashierId !== cashierId) return false;
      if (activeTab === 'other' && terminalId !== 'all' && sale.terminalId !== terminalId) return false;
      if (!needle) return true;
      return [
        sale.receiptNumber,
        sale.cashierName,
        sale.customerName ?? '',
        terminalMap.get(sale.terminalId)?.code ?? sale.terminalId,
        sale.status,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [activeTab, baseSales, cashierId, query, terminalId, terminalMap]);

  const cashierSummaries = useMemo(
    () => groupSalesSummary(filteredSales, (sale) => sale.cashierId, (sale) => sale.cashierName),
    [filteredSales],
  );
  const terminalSummaries = useMemo(
    () => groupSalesSummary(
      filteredSales,
      (sale) => sale.terminalId,
      (sale) => {
        const terminal = terminalMap.get(sale.terminalId);
        return terminal ? `${terminal.code} - ${terminal.name}` : sale.terminalId;
      },
    ),
    [filteredSales, terminalMap],
  );
  const totalRevenue = useMemo(
    () => filteredSales.reduce((sum, sale) => sum + sale.total, 0),
    [filteredSales],
  );

  const switchTab = (tab: OrderHistoryTab) => {
    setActiveTab(tab);
    setCashierId('all');
    setTerminalId('all');
    setQuery('');
  };

  return (
    <ModalShell onClose={props.onClose} title="Orders" width="payment">
      <div className="orders-workspace">
        <div className="orders-tabs" role="tablist" aria-label="Order history scope">
          <button
            className={activeTab === 'current' ? 'active' : ''}
            onClick={() => switchTab('current')}
            role="tab"
            aria-selected={activeTab === 'current'}
          >
            This terminal
          </button>
          {props.isManager && (
            <button
              className={activeTab === 'other' ? 'active' : ''}
              onClick={() => switchTab('other')}
              role="tab"
              aria-selected={activeTab === 'other'}
            >
              Other terminals
            </button>
          )}
          {props.cashSalesHidden && <span className="orders-mask-indicator">Cash sales hidden</span>}
        </div>

        <div className="orders-filters">
          <input
            className="glass-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Receipt, customer, cashier or status"
            value={query}
          />
          {activeTab === 'other' && (
            <SearchableSelect className="glass-input" value={terminalId} onChange={setTerminalId} options={[{ value: 'all', label: 'All other terminals' }, ...availableTerminals.map((terminal) => ({ value: terminal.id, label: `${terminal.code} - ${terminal.name}` }))]} ariaLabel="Terminal filter" />
          )}
          <SearchableSelect className="glass-input" value={cashierId} onChange={setCashierId} options={[{ value: 'all', label: 'All cashiers' }, ...availableCashiers.map((user) => ({ value: user.id, label: user.name }))]} ariaLabel="Cashier filter" />
        </div>

        <div className="orders-metrics">
          <MetricCard label="Orders" value={formatInteger(filteredSales.length)} />
          <MetricCard label="Revenue" value={formatCurrency(totalRevenue)} />
          <MetricCard label="Cashiers" value={formatInteger(cashierSummaries.length)} />
          <MetricCard label="Terminals" value={formatInteger(terminalSummaries.length)} />
        </div>

        <div className="orders-summary-grid">
          <OrderSummaryCard title="Summary by cashier" rows={cashierSummaries} />
          <OrderSummaryCard title="Summary by terminal" rows={terminalSummaries} />
        </div>

        <div className="orders-list-wrap">
          <div className="orders-list-head">
            <span>Receipt</span>
            <span>Date</span>
            <span>Terminal</span>
            <span>Cashier</span>
            <span>Payment</span>
            <span>Status</span>
            <span>Total</span>
          </div>
          <div className="orders-list">
            {props.isLoading && <div className="orders-empty">Loading orders...</div>}
            {!props.isLoading && filteredSales.map((sale) => (
              <button className="orders-row" key={sale.id} onClick={() => props.onOpenReceipt(sale)}>
                <b>{sale.receiptNumber}</b>
                <span>{formatDateTime(sale.createdAt)}</span>
                <span>{terminalMap.get(sale.terminalId)?.code ?? sale.terminalId}</span>
                <span>{sale.cashierName}</span>
                <span>{sale.payments.map((payment) => payment.method).join(' + ') || 'Unpaid'}</span>
                <span className={`order-status ${sale.status.toLowerCase()}`}>{sale.status}</span>
                <b>{formatCurrency(sale.total)}</b>
              </button>
            ))}
            {!props.isLoading && filteredSales.length === 0 && (
              <div className="orders-empty">No orders match this view.</div>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

type OrderSummaryRow = { id: string; label: string; count: number; total: number };

function groupSalesSummary(
  sales: SaleSummary[],
  getId: (sale: SaleSummary) => string,
  getLabel: (sale: SaleSummary) => string,
): OrderSummaryRow[] {
  const grouped = new Map<string, OrderSummaryRow>();
  for (const sale of sales) {
    const id = getId(sale);
    const current = grouped.get(id) ?? { id, label: getLabel(sale), count: 0, total: 0 };
    current.count += 1;
    current.total += sale.total;
    grouped.set(id, current);
  }
  return [...grouped.values()].sort((left, right) => right.total - left.total);
}

function OrderSummaryCard(props: { rows: OrderSummaryRow[]; title: string }) {
  return (
    <section className="orders-summary-card">
      <h3>{props.title}</h3>
      <div className="orders-summary-rows">
        {props.rows.map((row) => (
          <div className="orders-summary-row" key={row.id}>
            <span>{row.label}</span>
            <span>{formatInteger(row.count)} orders</span>
            <b>{formatCurrency(row.total)}</b>
          </div>
        ))}
        {props.rows.length === 0 && <div className="orders-summary-empty">No data in this view.</div>}
      </div>
    </section>
  );
}

function ReceiptModal(
  props: {
    onClose: () => void;
    onPrinted: (result: POSPrintResult) => void;
    sale: SaleSummary;
    terminalCode: string;
  },
) {
  const [isPrinting, setIsPrinting] = useState(false);

  const handlePrint = async () => {
    setIsPrinting(true);
    try {
      props.onPrinted(await printReceiptDocument(buildReceiptDocument(props.sale, props.terminalCode)));
    } finally {
      setIsPrinting(false);
    }
  };

  const paidAmount = roundToMoney(props.sale.payments.reduce((sum, payment) => sum + payment.amount, 0));
  const tenderedAmount = roundToMoney(props.sale.payments.reduce(
    (sum, payment) => sum + (payment.tenderedAmount ?? payment.amount),
    0,
  ));
  const changeDue = Math.max(0, roundToMoney(props.sale.payments.reduce(
    (sum, payment) => sum + (payment.changeDue ?? 0),
    0,
  )));
  const balanceDue = Math.max(0, roundToMoney(props.sale.total - paidAmount));
  const itemCount = props.sale.lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <ModalShell onClose={props.onClose} title="Receipt" width="narrow">
      <div className="receipt-paper">
        <div className="receipt-header">
          <div className="receipt-brand">JINGLES</div>
          <div>42 Main Street, Colombo</div>
          <div>{props.terminalCode}</div>
        </div>
        <div className="receipt-divider" />
        <div className="receipt-meta">
          <span>Receipt</span>
          <span>{props.sale.receiptNumber}</span>
        </div>
        <div className="receipt-meta">
          <span>Date</span>
          <span>{formatDateTime(props.sale.createdAt)}</span>
        </div>
        <div className="receipt-meta">
          <span>Cashier</span>
          <span>{props.sale.cashierName}</span>
        </div>
        <div className="receipt-meta">
          <span>Customer</span>
          <span>{props.sale.customerName ?? 'Walk-in customer'}</span>
        </div>
        <div className="receipt-meta">
          <span>Items</span>
          <span>{formatInteger(itemCount)}</span>
        </div>
        <div className="receipt-divider" />
        {props.sale.lines.map((line) => (
          <div key={line.id} className="receipt-line-item">
            <div>
              <div>{line.name}</div>
              {getLineVariantSummary(line) != null && (
                <div className="receipt-line-copy">{getLineVariantSummary(line)}</div>
              )}
              <div className="receipt-line-copy">SKU {line.sku} · {line.tierLabel}</div>
              <div>{line.quantity} x {formatCurrency(line.unitPrice)}</div>
              {line.discountAmount > 0 && (
                <div className="receipt-line-copy">Discount -{formatCurrency(line.discountAmount)}</div>
              )}
            </div>
            <span>{formatCurrency(line.lineTotal)}</span>
          </div>
        ))}
        <div className="receipt-divider" />
        <div className="receipt-line-item">
          <span>Subtotal</span>
          <span>{formatCurrency(props.sale.subtotal)}</span>
        </div>
        <div className="receipt-line-item">
          <span>Discount</span>
          <span>-{formatCurrency(props.sale.discountTotal)}</span>
        </div>
        <div className="receipt-line-item">
          <span>Tax</span>
          <span>{formatCurrency(props.sale.taxTotal)}</span>
        </div>
        <div className="receipt-line-item strong">
          <span>Total</span>
          <span>{formatCurrency(props.sale.total)}</span>
        </div>
        <div className="receipt-subheading">Payment(s)</div>
        {props.sale.payments.map((payment, index) => (
          <div key={`${payment.method}-${index}`} className="receipt-payment-entry">
            <div className="receipt-line-item">
              <span>{PAYMENT_OPTIONS.find((option) => option.method === payment.method)?.label ?? payment.method}</span>
              <span>{formatCurrency(payment.amount)}</span>
            </div>
            {payment.reference && (
              <div className="receipt-payment-detail">
                <span>Reference</span>
                <span>{payment.reference}</span>
              </div>
            )}
            {(payment.tenderedAmount ?? payment.amount) !== payment.amount && (
              <div className="receipt-payment-detail">
                <span>Tendered</span>
                <span>{formatCurrency(payment.tenderedAmount ?? payment.amount)}</span>
              </div>
            )}
          </div>
        ))}
        <div className="receipt-divider" />
        <div className="receipt-settlement" aria-label="Receipt settlement summary">
          <div className="receipt-line-item">
            <span>Tendered</span>
            <span>{formatCurrency(tenderedAmount)}</span>
          </div>
          <div className="receipt-line-item">
            <span>Paid</span>
            <span>{formatCurrency(paidAmount)}</span>
          </div>
          <div className={`receipt-line-item receipt-balance ${balanceDue === 0 ? 'settled' : ''}`}>
            <span>Balance due</span>
            <span>{formatCurrency(balanceDue)}</span>
          </div>
          <div className="receipt-line-item receipt-change">
            <span>Change</span>
            <span>{formatCurrency(changeDue)}</span>
          </div>
        </div>
        <div className="receipt-footer">
          <div>Thank you for shopping with Jingles.</div>
          <div>Please retain this receipt for returns.</div>
        </div>
      </div>

      <div className="modal-actions">
        <button className="ghost-button" disabled={isPrinting} onClick={() => void handlePrint()}>
          {isPrinting ? 'Printing...' : 'Print'}
        </button>
        <button className="btn-primary" onClick={props.onClose}>
          Finish
        </button>
      </div>
    </ModalShell>
  );
}

type ReturnDraft = {
  sale: SaleSummary;
  reason: string;
  quantities: Record<string, number>;
};

function ReturnModal(
  props: {
    isLoading: boolean;
    onClose: () => void;
    onSubmit: (draft: ReturnDraft) => void;
    sales: SaleSummary[];
  },
) {
  const [query, setQuery] = useState('');
  const [selectedSaleId, setSelectedSaleId] = useState(props.sales[0]?.id ?? '');
  const [reason, setReason] = useState('Customer return');
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const filteredSales = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) {
      return props.sales.slice(0, 20);
    }
    return props.sales.filter((sale) => {
      return [
        sale.receiptNumber.toLowerCase(),
        sale.id.toLowerCase(),
        sale.customerName?.toLowerCase() ?? '',
        sale.cashierName.toLowerCase(),
      ].some((value) => value.includes(term));
    });
  }, [props.sales, query]);

  const selectedSale = props.sales.find((sale) => sale.id === selectedSaleId) ?? filteredSales[0] ?? null;

  useEffect(() => {
    if (selectedSale == null) {
      return;
    }

    setSelectedSaleId(selectedSale.id);
    setQuantities(
      Object.fromEntries(selectedSale.lines.map((line) => [line.id, 0])),
    );
  }, [selectedSale?.id]);

  return (
    <ModalShell onClose={props.onClose} title="Refund / return" width="wide">
      <div className="return-layout">
        <div className="return-sales">
          <input
            className="glass-input"
            placeholder="Find receipt or customer"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="return-sales-list">
            {props.isLoading && <div className="meta-label">Loading sales...</div>}
            {!props.isLoading && filteredSales.map((sale) => (
              <button
                key={sale.id}
                className={`return-sale-row ${sale.id === selectedSale?.id ? 'active' : ''}`}
                onClick={() => setSelectedSaleId(sale.id)}
              >
                <div>{sale.receiptNumber}</div>
                <div>{sale.customerName ?? 'Walk-in'}</div>
                <span>{formatCurrency(sale.total)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="return-detail">
          {selectedSale == null ? (
            <div className="empty-state compact">
              <div className="empty-title">No sale selected</div>
            </div>
          ) : (
            <>
              <div className="return-header">
                <div>
                  <div className="meta-label">Receipt</div>
                  <div className="cart-sale-id">{selectedSale.receiptNumber}</div>
                </div>
                <div>
                  <div className="meta-label">Customer</div>
                  <div>{selectedSale.customerName ?? 'Walk-in'}</div>
                </div>
                <div>
                  <div className="meta-label">Date</div>
                  <div>{formatDateTime(selectedSale.createdAt)}</div>
                </div>
              </div>

              <LabelBlock label="Reason">
                <SearchableSelect className="glass-input compact" value={reason} onChange={setReason} options={['Customer return', 'Damaged item', 'Pricing error', 'Order cancellation'].map((label) => ({ value: label, label }))} ariaLabel="Return reason" />
              </LabelBlock>

              <div className="return-lines">
                {selectedSale.lines.map((line) => (
                  <div key={line.id} className="return-line">
                    <div>
                      <div>{line.name}</div>
                      {getLineVariantSummary(line) != null && (
                        <div className="cart-line-variant">{getLineVariantSummary(line)}</div>
                      )}
                      <div className="cart-line-meta">Sold {line.quantity} x {formatCurrency(line.unitPrice)}</div>
                    </div>
                    <input
                      className="glass-input compact narrow"
                      type="number"
                      min={0}
                      max={line.quantity}
                      value={quantities[line.id] ?? 0}
                      onChange={(event) => setQuantities((previous) => ({
                        ...previous,
                        [line.id]: Math.min(line.quantity, Math.max(0, Number(event.target.value) || 0)),
                      }))}
                    />
                  </div>
                ))}
              </div>

              <div className="modal-actions">
                <button className="ghost-button" onClick={props.onClose}>Cancel</button>
                <button
                  className="btn-primary"
                  onClick={() => props.onSubmit({
                    sale: selectedSale,
                    reason,
                    quantities,
                  })}
                >
                  Submit return
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function VoidModal(
  props: {
    line: CartLine | null;
    onClose: () => void;
    onConfirm: () => void;
  },
) {
  return (
    <ModalShell onClose={props.onClose} title={props.line == null ? 'Void current sale' : 'Void line'} width="narrow">
      <div className="modal-stack">
        <p className="modal-copy">
          {props.line == null
            ? 'This clears the current cart before a receipt is issued. The action stays local to the workstation.'
            : `Remove ${props.line.name} from the current cart.`}
        </p>
        <div className="modal-actions">
          <button className="ghost-button" onClick={props.onClose}>Cancel</button>
          <button className="ghost-button danger" onClick={props.onConfirm}>Confirm void</button>
        </div>
      </div>
    </ModalShell>
  );
}

function buildPayments(
  total: number,
  method: PaymentMethod,
  tendered: number,
  change: number,
  reference: string,
): PaymentInput[] {
  if (method === PaymentMethod.CASH) {
    return [{
      method,
      amount: total,
      tenderedAmount: tendered,
      changeDue: change,
    }];
  }

  return [{
    method,
    amount: total,
    tenderedAmount: total,
    changeDue: 0,
    reference: reference.trim() || undefined,
  }];
}

function formatSyncBadge(status: SyncStatusSummary | null): string {
  if (status == null) {
    return 'Sync status unavailable';
  }

  const state = status.needsSyncAuth ? 'Auth needed' : status.online ? 'Online' : 'Offline';
  const parts = [state];
  if (status.pendingEvents > 0) {
    parts.push(`${status.pendingEvents} pending`);
  } else if (status.needsSyncAuth) {
    parts.push('Reconnect');
  } else {
    parts.push('Synced');
  }
  if (status.lastSyncAt) {
    parts.push(`Last ${formatTime(status.lastSyncAt)}`);
  }
  return parts.join(' - ');
}

function getCategoryToken(name: string): string {
  const token = getNameInitials(name);
  return token.length > 0 ? token : 'IT';
}

function resolveTerminalCode(terminals: POSBootstrap['terminals'], terminalId: string): string {
  return terminals.find((terminal) => terminal.id === terminalId)?.code ?? 'TERM-00';
}

function isToday(value: string): boolean {
  const date = new Date(value);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  );
}

function roundToMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function getSyncRunError(result: POSSyncRunResult): string | null {
  if (result.status.needsSyncAuth) {
    return 'Host sync authentication is required. Open Sync Center and reconnect host sync.';
  }

  if (result.status.lastError) {
    return result.status.lastError;
  }

  if (!result.status.online && result.status.pendingEvents > 0) {
    return 'Sync did not finish. Pending local events are still queued.';
  }

  return null;
}

function formatSyncRunSuccess(result: POSSyncRunResult): string {
  const parts: string[] = [];

  if (result.accepted > 0) {
    parts.push(`${result.accepted} local event${result.accepted === 1 ? '' : 's'} sent`);
  }

  if (result.remoteApplied > 0) {
    parts.push(`${result.remoteApplied} remote event${result.remoteApplied === 1 ? '' : 's'} applied`);
  }

  if (result.conflicts > 0) {
    parts.push(`${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'} recorded`);
  }

  if (parts.length === 0) {
    return 'Playback sync finished. Workstation is already up to date.';
  }

  return `Playback sync finished. ${parts.join(', ')}.`;
}
