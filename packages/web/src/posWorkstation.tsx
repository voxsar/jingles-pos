import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CashCountMode,
  CartLine,
  CompleteSaleInput,
  Customer,
  HeldSaleSummary,
  POSDesktopSettings,
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
  DEFAULT_TERMINAL_ID,
} from '@jingles/shared';
import {
  bootstrapPOS,
  closeShift,
  createReturn,
  createSale,
  getZReport,
  listHeldSales,
  listSales,
  openShift,
  recallHeldSale,
  saveHeldSale,
  searchProducts,
  subscribeSyncStatus,
  syncNow,
} from './api';
import { useAuth } from './auth/AuthContext';
import HelpGuide from './help/HelpGuide';
import {
  buildFallbackDesktopSettings,
  createDesktopBackup,
  hasDesktopSettingsBridge,
  loadDesktopSettings,
  persistThemeMode,
  pickDesktopBackupDirectory,
  pickDesktopDatabasePath,
  readStoredThemeMode,
  saveDesktopSettings as saveDesktopSettingsToBridge,
} from './desktopSettings';
import {
  buildCashDeclaration,
  calcCartTotals,
  createCartLine,
  createEmptyDenominationCounts,
  DENOMINATIONS,
  formatCurrency,
  formatDateTime,
  formatInteger,
  formatTime,
  generateHoldNumber,
  generateReceiptNumber,
  getLineVariantSummary,
  getProductVariantLabel,
  getNameInitials,
  pickPriceTier,
  recalculateCartLine,
} from './utils/pos';
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
  const [syncStatus, setSyncStatus] = useState<SyncStatusSummary | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [defaultTierLabel, setDefaultTierLabel] = useState('');
  const [billDiscount, setBillDiscount] = useState(0);
  const [activeCategoryId, setActiveCategoryId] = useState('all');
  const [activeSubcategory, setActiveSubcategory] = useState<string | null>(null);
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
  const [isReturnOpen, setIsReturnOpen] = useState(false);
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

  const discountInputRef = useRef<HTMLInputElement>(null);
  const customerSelectRef = useRef<HTMLSelectElement>(null);
  const headerBarRef = useRef<HTMLElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const workstationGridRef = useRef<HTMLDivElement>(null);

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
  const productsWithVariants = useMemo(
    () => new Set(products.filter((product) => (product.variants?.length ?? 0) > 0).map((product) => product.id)),
    [products],
  );
  const customerMap = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const categoryTiles = useMemo<CatalogCategoryTile[]>(() => {
    const counts = new Map<string, number>();
    const subcategoriesByCategory = new Map<string, Set<string>>();

    for (const product of products) {
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
        count: products.length,
        subcategoryCount: sorted.length,
      },
      ...sorted,
    ];
  }, [bootstrapData?.categories, products]);

  const subcategoryTiles = useMemo<CatalogSubcategoryTile[]>(() => {
    if (activeCategoryId === 'all') {
      return [];
    }

    const counts = new Map<string, number>();
    for (const product of products) {
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
  }, [activeCategoryId, products]);

  const visibleProducts = useMemo(() => {
    let rows = [...products];
    if (activeCategoryId !== 'all') {
      rows = rows.filter((product) => product.categoryId === activeCategoryId);
    }
    if (activeSubcategory) {
      rows = rows.filter((product) => product.subcategory === activeSubcategory);
    }

    return rows.sort((left, right) => left.sku.localeCompare(right.sku));
  }, [activeCategoryId, activeSubcategory, products]);

  const activeCategory = useMemo(
    () => categoryTiles.find((category) => category.id === activeCategoryId) ?? categoryTiles[0] ?? null,
    [activeCategoryId, categoryTiles],
  );

  const selectedCustomer = customers.find((customer) => customer.id === customerId) ?? customers[0] ?? null;

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

  const todaySales = useMemo(() => sales.filter((sale) => isToday(sale.createdAt)), [sales]);
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
        setCustomerId((previous) => previous || data.customers[0]?.id || '');
        setDefaultTierLabel((previous) => previous || data.customers[0]?.tier || 'Retail');
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
      const rows = await listSales();
      setSales(rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load sales history';
      showNotice('error', message);
    } finally {
      setSalesLoading(false);
    }
  }, [showNotice]);

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

    try {
      if (hasDesktopSettingsBridge()) {
        const result = await saveDesktopSettingsToBridge(settingsDraft);
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
        setDesktopSettings(settingsDraft);
        setAppliedThemeMode(settingsDraft.themeMode);
        showNotice('success', 'Theme saved for this browser session.');
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
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'F1') {
        event.preventDefault();
        setIsHelpOpen(true);
        return;
      }

      if (session == null) {
        return;
      }

      if (event.key === 'Escape') {
        closeOverlayStack();
        return;
      }

      if (event.key === 'F3') {
        event.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      if (event.key === 'F4') {
        event.preventDefault();
        setHoldMode('hold');
        setIsHoldOpen(true);
        return;
      }

      if (event.key === 'F5') {
        event.preventDefault();
        setHoldMode('recall');
        setIsHoldOpen(true);
        return;
      }

      if (event.key === 'F6') {
        event.preventDefault();
        discountInputRef.current?.focus();
        return;
      }

      if (event.key === 'F7') {
        event.preventDefault();
        customerSelectRef.current?.focus();
        return;
      }

      if (event.key === 'F8') {
        event.preventDefault();
        if (cart.length > 0) {
          setIsPaymentOpen(true);
        }
        return;
      }

      if (event.key === 'F10') {
        event.preventDefault();
        setIsReturnOpen(true);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cart.length, session]);

  const closeOverlayStack = useCallback(() => {
    setIsSearchOpen(false);
    setVariantSelection(null);
    setIsPaymentOpen(false);
    setIsHoldOpen(false);
    setMoneyMode(null);
    setIsZOpen(false);
    setIsReturnOpen(false);
    setIsVoidOpen(false);
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
    if (activeShift != null) {
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
  }, [activeShift, logout, navigate, showNotice]);

  const handleCustomerChange = useCallback((nextCustomerId: string) => {
    const nextCustomer = customerMap.get(nextCustomerId);
    setCustomerId(nextCustomerId);
    if (nextCustomer != null) {
      setDefaultTierLabel(nextCustomer.tier);
    }
  }, [customerMap]);

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

  const handleOpenShift = useCallback(async (counts: Record<string, number>) => {
    if (session == null) {
      return;
    }

    try {
      const shift = await openShift({
        terminalId: session.terminalId,
        branchId: session.branchId,
        cashierId: session.user.id,
        openingFloat: buildCashDeclaration(CashCountMode.OPENING, counts).total,
        declaration: buildCashDeclaration(CashCountMode.OPENING, counts),
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

  const handleCloseShift = useCallback(async (counts: Record<string, number>) => {
    if (session == null || activeShift == null) {
      return;
    }

    try {
      const declaration = buildCashDeclaration(CashCountMode.CLOSING, counts);
      await closeShift({
        shiftId: activeShift.id,
        terminalId: session.terminalId,
        closingFloat: declaration.total,
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
  }, [activeShift, refreshWorkspace, session, showNotice]);

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
      setBootstrapData((previous) => previous
        ? { ...previous, heldSales: [heldSale, ...previous.heldSales.filter((sale) => sale.id !== heldSale.id)] }
        : previous);
      showNotice('success', `Held bill ${heldSale.holdNumber}.`);
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to hold bill';
      showNotice('error', message);
    }
  }, [billDiscount, cart, refreshWorkspace, selectedCustomer?.id, session, showNotice, terminals, totals.rawSubtotal, totals.total]);

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
      setCustomerId(recalled.customerId ?? customers[0]?.id ?? '');
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
      setIsPaymentOpen(false);
      setCart([]);
      setBillDiscount(0);
      setActiveHeldSaleId(null);
      showNotice('success', `Sale ${sale.receiptNumber} completed.`);
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

  const handleOpenZReport = useCallback(async () => {
    if (activeShift == null) {
      showNotice('error', 'Open a shift before viewing a Z-report.');
      return;
    }

    try {
      const report = await getZReport(activeShift.id);
      setZReport(report);
      setIsZOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build Z-report';
      showNotice('error', message);
    }
  }, [activeShift, showNotice]);

  const terminalCode = resolveTerminalCode(terminals, currentTerminalId);
  const terminalName = terminals.find((terminal) => terminal.id === currentTerminalId)?.name ?? 'POS Terminal';
  const sessionUser = session ? userMap.get(session.user.id) ?? session.user : null;
  const canTakePayment = cart.length > 0 && activeShift != null;
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
          onBranchChange={setSelectedBranchId}
          onEnterWorkstation={handleStartSession}
          onOpenHelp={() => setIsHelpOpen(true)}
          onSignOut={() => void handleSignOut()}
          selectedBranchId={selectedBranchId}
          selectedTerminalId={selectedTerminalId}
          terminals={branchTerminals.length > 0 ? branchTerminals : terminals}
          onTerminalChange={setSelectedTerminalId}
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
        onCashAction={() => setMoneyMode(activeShift == null ? 'open' : 'close')}
        onOpenHelp={() => setIsHelpOpen(true)}
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
          onAddProduct={handleProductPick}
          onCategoryChange={(nextCategory) => {
            setActiveCategoryId(nextCategory);
            setActiveSubcategory(null);
          }}
          onOpenSearch={() => setIsSearchOpen(true)}
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
        elementRef={actionBarRef}
        onCashAction={() => setMoneyMode(activeShift == null ? 'open' : 'close')}
        onCustomer={() => customerSelectRef.current?.focus()}
        onDiscount={() => discountInputRef.current?.focus()}
        onHold={() => handleOpenHoldModal('hold')}
        onPay={() => setIsPaymentOpen(true)}
        onQuote={() => handleOpenHoldModal('hold')}
        onRecall={() => handleOpenHoldModal('recall')}
        onRefund={() => setIsReturnOpen(true)}
        onSearch={() => setIsSearchOpen(true)}
        onVoid={() => {
          setVoidLineId(null);
          setIsVoidOpen(true);
        }}
        total={totals.total}
      />

      {isSearchOpen && (
        <SearchOverlay
          products={products}
          onClose={() => setIsSearchOpen(false)}
          onPick={(product) => {
            setIsSearchOpen(false);
            handleProductPick(product);
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
        />
      )}

      {isPaymentOpen && (
        <PaymentModal
          total={totals.total}
          onClose={() => setIsPaymentOpen(false)}
          onComplete={(payments) => void handleCompleteSale(payments)}
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

      {moneyMode != null && (
        <MoneyDeclareModal
          expectedDrawer={moneyMode === 'close' ? zReport?.expectedDrawer : undefined}
          mode={moneyMode}
          onClose={() => setMoneyMode(null)}
          onSubmit={(counts) => {
            if (moneyMode === 'open') {
              void handleOpenShift(counts);
            } else {
              void handleCloseShift(counts);
            }
          }}
        />
      )}

      {isZOpen && zReport != null && activeShift != null && (
        <ZReportModal
          cashierName={session.user.name}
          onClose={() => setIsZOpen(false)}
          report={zReport}
          shift={activeShift}
          terminalCode={terminalCode}
        />
      )}

      {receiptSale != null && (
        <ReceiptModal
          onClose={() => setReceiptSale(null)}
          sale={receiptSale}
          terminalCode={terminalCode}
        />
      )}

      {isReturnOpen && (
        <ReturnModal
          isLoading={salesLoading}
          onClose={() => setIsReturnOpen(false)}
          onSubmit={(draft) => void handleSubmitReturn(draft)}
          sales={sales}
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
            Active shift on this terminal: {props.activeShift.cashierName} since {formatTime(props.activeShift.openedAt)}
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
            <select
              className="glass-input"
              value={props.selectedBranchId}
              onChange={(event) => props.onBranchChange(event.target.value)}
            >
              {props.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.code} - {branch.name}
                </option>
              ))}
            </select>
          </LabelBlock>

          <LabelBlock label="Terminal">
            <select
              className="glass-input"
              value={props.selectedTerminalId}
              onChange={(event) => props.onTerminalChange(event.target.value)}
            >
              {props.terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.code} - {terminal.name}
                </option>
              ))}
            </select>
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
            Shift {props.activeShift.id.slice(0, 8)} - {formatTime(props.activeShift.openedAt)}
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
        <button className="ghost-button" onClick={props.onOpenHelp} title="Help & user guide (F1)">
          Help
        </button>
        <button className="ghost-button" onClick={props.onCashAction}>
          Cash
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
  onAddProduct: (product: Product) => void;
  onCategoryChange: (nextCategory: string) => void;
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
        <div className="catalog-mode-pill">
          Tile catalog
        </div>
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
  customerSelectRef: React.RefObject<HTMLSelectElement>;
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
          <select
            ref={props.customerSelectRef}
            className="glass-input compact"
            value={props.customerId}
            onChange={(event) => props.onCustomerChange(event.target.value)}
          >
            {props.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} - {customer.tier}
              </option>
            ))}
          </select>
        </LabelBlock>

        <LabelBlock label="Default tier">
          <select
            className="glass-input compact"
            value={props.defaultTierLabel}
            onChange={(event) => props.onDefaultTierChange(event.target.value)}
          >
            {props.defaultTierOptions.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
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
                    <select
                      className="line-select"
                      value={line.tierLabel}
                      onChange={(event) => props.onLineTierChange(line.uid, event.target.value)}
                    >
                      {line.priceTiers.map((tier) => (
                        <option key={tier.id} value={tier.label}>
                          {tier.label} - {formatCurrency(tier.price)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="mini-field">
                    <span>Staff</span>
                    <select
                      className="line-select"
                      value={line.salespersonId}
                      onChange={(event) => props.onLineSalespersonChange(line.uid, event.target.value)}
                    >
                      {props.salespeople.map((salesperson) => (
                        <option key={salesperson.id} value={salesperson.id}>
                          {salesperson.initials} - {salesperson.name}
                        </option>
                      ))}
                    </select>
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
  elementRef?: React.Ref<HTMLDivElement>;
  onCashAction: () => void;
  onCustomer: () => void;
  onDiscount: () => void;
  onHold: () => void;
  onPay: () => void;
  onQuote: () => void;
  onRecall: () => void;
  onRefund: () => void;
  onSearch: () => void;
  onVoid: () => void;
  total: number;
};

function ActionBar(props: ActionBarProps) {
  return (
    <div ref={props.elementRef} className="glass-bar action-bar">
      <ActionButton shortcut="F3" label="Search" onClick={props.onSearch} />
      <ActionButton shortcut="F4" label="Hold" onClick={props.onHold} />
      <ActionButton shortcut="F5" label="Recall" onClick={props.onRecall} />
      <ActionButton shortcut="F6" label="Discount" onClick={props.onDiscount} />
      <ActionButton shortcut="F7" label="Customer" onClick={props.onCustomer} />
      <ActionButton shortcut="F8" label={`Pay - ${formatCurrency(props.total)}`} onClick={props.onPay} primary disabled={!props.canTakePayment} />
      <ActionButton shortcut="F9" label="Quote" onClick={props.onQuote} />
      <ActionButton shortcut="F10" label="Refund" onClick={props.onRefund} />
      <ActionButton shortcut="Esc" label="Void" onClick={props.onVoid} danger />
      <ActionButton shortcut="CA" label="Cash drawer" onClick={props.onCashAction} />
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
  },
) {
  return (
    <button
      className={`action-button ${props.primary ? 'primary' : ''} ${props.danger ? 'danger' : ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
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
            </div>

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

function SearchOverlay(
  props: {
    products: Product[];
    onClose: () => void;
    onPick: (product: Product) => void;
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
  }, [props.products, query, scope]);

  return (
    <ModalShell onClose={props.onClose} title="Search products" width="wide">
      <div className="search-panel">
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="glass-input search-box"
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
            <button key={product.id} className="search-result-row" onClick={() => props.onPick(product)}>
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
              <select
                className="glass-input large"
                value={installmentCount}
                disabled={splitPayments.length > 0}
                onChange={(event) => setInstallmentCount(Number(event.target.value))}
              >
                {[2, 3, 4, 6, 12].map((count) => <option key={count} value={count}>{count} installments</option>)}
              </select>
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

function MoneyDeclareModal(
  props: {
    expectedDrawer?: number;
    mode: MoneyModalMode;
    onClose: () => void;
    onSubmit: (counts: Record<string, number>) => void;
  },
) {
  const [counts, setCounts] = useState<Record<string, number>>(() => createEmptyDenominationCounts());
  const total = useMemo(
    () => buildCashDeclaration(
      props.mode === 'open' ? CashCountMode.OPENING : CashCountMode.CLOSING,
      counts,
    ).total,
    [counts, props.mode],
  );

  return (
    <ModalShell
      onClose={props.onClose}
      title={props.mode === 'open' ? 'Open shift - money declare' : 'Close shift - cash count'}
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
            <div className="meta-label">{props.mode === 'open' ? 'Declared float' : 'Counted drawer'}</div>
            <div className="payment-total">{formatCurrency(total)}</div>
          </div>
          {props.expectedDrawer != null && (
            <div className="variance-card">
              <div className="meta-label">Expected drawer</div>
              <div>{formatCurrency(props.expectedDrawer)}</div>
              <div className={total === props.expectedDrawer ? 'variance-ok' : 'variance-alert'}>
                Variance {formatCurrency(total - props.expectedDrawer)}
              </div>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="ghost-button" onClick={props.onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => props.onSubmit(counts)}>
            {props.mode === 'open' ? 'Confirm and open shift' : 'Submit and close shift'}
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
        <img
          className={`currency-image ${props.denomination.kind === 'coin' ? 'coin-image' : ''}`}
              src={`./currency/${props.denomination.value}.png`}
          alt={props.denomination.label}
        />
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

function ZReportModal(
  props: {
    cashierName: string;
    onClose: () => void;
    report: ZReportSummary;
    shift: ShiftSummary;
    terminalCode: string;
  },
) {
  return (
    <ModalShell onClose={props.onClose} title="Z-report" width="wide">
      <div className="modal-stack">
        <div className="report-stat-grid">
          <MetricCard label="Shift" value={props.shift.id.slice(0, 8)} />
          <MetricCard label="Cashier" value={props.cashierName} />
          <MetricCard label="Terminal" value={props.terminalCode} />
        </div>

        <div className="report-grid">
          <ReportRow label="Gross sales" value={formatCurrency(props.report.grossSales)} />
          <ReportRow label="Discounts" value={`- ${formatCurrency(props.report.discounts)}`} muted />
          <ReportRow label="Refunds" value={`- ${formatCurrency(props.report.refunds)}`} muted />
          <ReportRow label="Net sales" value={formatCurrency(props.report.netSales)} strong />
          <ReportRow label="Transactions" value={formatInteger(props.report.transactionCount)} />
          <ReportRow label="Opening float" value={formatCurrency(props.report.openingFloat)} />
          <ReportRow label="Expected drawer" value={formatCurrency(props.report.expectedDrawer)} strong />
          {props.report.countedDrawer != null && (
            <>
              <ReportRow label="Counted drawer" value={formatCurrency(props.report.countedDrawer)} />
              <ReportRow label="Variance" value={formatCurrency(props.report.variance ?? 0)} muted />
            </>
          )}
        </div>

        <div className="report-breakdown">
          {Object.entries(props.report.paymentBreakdown).map(([method, amount]) => (
            <div key={method} className="report-chip">
              <span>{method}</span>
              <b>{formatCurrency(amount)}</b>
            </div>
          ))}
        </div>

        <div className="modal-actions">
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

function ReceiptModal(
  props: {
    onClose: () => void;
    sale: SaleSummary;
    terminalCode: string;
  },
) {
  const paidAmount = roundToMoney(props.sale.payments.reduce((sum, payment) => sum + payment.amount, 0));
  const balanceDue = Math.max(0, roundToMoney(props.sale.total - paidAmount));

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
          <span>{props.sale.receiptNumber}</span>
          <span>{formatDateTime(props.sale.createdAt)}</span>
        </div>
        <div className="receipt-divider" />
        {props.sale.lines.map((line) => (
          <div key={line.id} className="receipt-line-item">
            <div>
              <div>{line.name}</div>
              {getLineVariantSummary(line) != null && (
                <div className="receipt-line-copy">{getLineVariantSummary(line)}</div>
              )}
              <div>{line.quantity} x {formatCurrency(line.unitPrice)}</div>
            </div>
            <span>{formatCurrency(line.lineTotal)}</span>
          </div>
        ))}
        <div className="receipt-divider" />
        <div className="receipt-line-item strong">
          <span>Total</span>
          <span>{formatCurrency(props.sale.total)}</span>
        </div>
        <div className="receipt-subheading">Payment(s)</div>
        <div className="receipt-line-item strong">
          <span>Paid</span>
          <span>{formatCurrency(paidAmount)}</span>
        </div>
        {props.sale.payments.map((payment, index) => (
          <div key={`${payment.method}-${index}`} className="receipt-line-item">
            <span>{payment.method}</span>
            <span>{formatCurrency(payment.amount)}</span>
          </div>
        ))}
        {balanceDue > 0 && (
          <div className="receipt-line-item receipt-balance">
            <span>Balance due</span>
            <span>{formatCurrency(balanceDue)}</span>
          </div>
        )}
      </div>

      <div className="modal-actions">
        <button className="ghost-button" onClick={() => window.print()}>
          Print
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
                <select className="glass-input compact" value={reason} onChange={(event) => setReason(event.target.value)}>
                  <option>Customer return</option>
                  <option>Damaged item</option>
                  <option>Pricing error</option>
                  <option>Order cancellation</option>
                </select>
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
