import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CashCountMode,
  CartLine,
  CompleteSaleInput,
  Customer,
  HeldSaleSummary,
  POSSyncRunResult,
  PaymentInput,
  PaymentMethod,
  POSBootstrap,
  POSUser,
  Product,
  ProductPriceTier,
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

type ProductViewMode = 'list' | 'tile';
type HoldMode = 'hold' | 'recall';
type MoneyModalMode = 'open' | 'close';

const PAYMENT_OPTIONS: Array<{ method: PaymentMethod; label: string; short: string }> = [
  { method: PaymentMethod.CASH, label: 'Cash', short: 'CA' },
  { method: PaymentMethod.VISA, label: 'Visa', short: 'VI' },
  { method: PaymentMethod.MASTER, label: 'Master', short: 'MC' },
  { method: PaymentMethod.AMEX, label: 'Amex', short: 'AX' },
  { method: PaymentMethod.CREDIT, label: 'Credit', short: 'CR' },
  { method: PaymentMethod.GIFT, label: 'Gift voucher', short: 'GV' },
  { method: PaymentMethod.SPLIT, label: 'Split payment', short: 'SP' },
];

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
  const [productView, setProductView] = useState<ProductViewMode>('list');
  const [activeCategoryId, setActiveCategoryId] = useState('all');
  const [activeSubcategory, setActiveSubcategory] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
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

  const discountInputRef = useRef<HTMLInputElement>(null);
  const customerSelectRef = useRef<HTMLSelectElement>(null);

  const showNotice = useCallback((type: 'success' | 'error', text: string) => {
    setNotice({ type, text });
  }, []);

  useEffect(() => {
    if (authUser == null) {
      setSession(null);
    }
  }, [authUser]);

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
  const customerMap = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const categoryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products) {
      counts.set(product.categoryId, (counts.get(product.categoryId) ?? 0) + 1);
    }

    const sorted = [...(bootstrapData?.categories ?? [])]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((category) => ({
        ...category,
        chip: getCategoryToken(category.name),
        count: counts.get(category.id) ?? 0,
      }));

    return [
      { id: 'all', name: 'All Items', icon: 'AL', sortOrder: 0, chip: 'AL', count: products.length },
      ...sorted,
    ];
  }, [bootstrapData?.categories, products]);

  const subcategoryChips = useMemo(() => {
    if (activeCategoryId === 'all') {
      return [];
    }

    return Array.from(
      new Set(
        products
          .filter((product) => product.categoryId === activeCategoryId)
          .map((product) => product.subcategory)
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right));
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
    setIsPaymentOpen(false);
    setIsHoldOpen(false);
    setMoneyMode(null);
    setIsZOpen(false);
    setIsReturnOpen(false);
    setIsVoidOpen(false);
    setReceiptSale(null);
  }, []);

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

  const addProductToCart = useCallback((product: Product) => {
    const salesperson = salespeople[0] ?? users[0];
    if (salesperson == null) {
      showNotice('error', 'No cashier or salesperson is configured for the workstation.');
      return;
    }

    const preferredLabels = [
      defaultTierLabel,
      selectedCustomer?.tier ?? '',
      'Retail',
    ].filter(Boolean);

    setCart((previous) => {
      const existing = previous.find((line) => line.productId === product.id && line.tierLabel === pickPriceTier(product.priceTiers, preferredLabels).label);
      if (existing) {
        return previous.map((line) => (
          line.uid === existing.uid
            ? recalculateCartLine({
              ...line,
              quantity: line.quantity + 1,
              stockOnHand: product.stockOnHand,
            })
            : line
        ));
      }

      return [...previous, createCartLine(product, salesperson, preferredLabels)];
    });
  }, [defaultTierLabel, salespeople, selectedCustomer?.tier, showNotice, users]);

  const updateCartLineById = useCallback((lineId: string, updater: (line: CartLine) => CartLine | null) => {
    setCart((previous) => previous.flatMap((line) => {
      if (line.uid !== lineId) {
        return [line];
      }

      const updated = updater(line);
      return updated == null ? [] : [updated];
    }));
  }, []);

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
          stockOnHand: product?.stockOnHand ?? line.quantity,
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
      <WorkstationAccessScreen
        activeShift={activeShift}
        authenticatedUser={authUser}
        branches={branches}
        notice={notice}
        onBranchChange={setSelectedBranchId}
        onEnterWorkstation={handleStartSession}
        onSignOut={() => void handleSignOut()}
        selectedBranchId={selectedBranchId}
        selectedTerminalId={selectedTerminalId}
        terminals={branchTerminals.length > 0 ? branchTerminals : terminals}
        onTerminalChange={setSelectedTerminalId}
      />
    );
  }

  return (
    <div className="screen-fill workstation-app">
      <div className="bg-layer bg-layer-gradient" />
      <div className="bg-layer bg-layer-grid" />

      <HeaderBar
        activeShift={activeShift}
        cashierName={sessionUser?.name ?? session.user.name}
        conflictCount={syncStatus?.conflictCount ?? 0}
        isSyncing={isSyncing}
        onCashAction={() => setMoneyMode(activeShift == null ? 'open' : 'close')}
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

      <div className="workstation-grid">
        <ProductPanel
          activeCategoryId={activeCategoryId}
          activeSubcategory={activeSubcategory}
          categories={categoryChips}
          onAddProduct={addProductToCart}
          onCategoryChange={(nextCategory) => {
            setActiveCategoryId(nextCategory);
            setActiveSubcategory(null);
          }}
          onOpenSearch={() => setIsSearchOpen(true)}
          onSubcategoryChange={setActiveSubcategory}
          productView={productView}
          products={visibleProducts}
          setProductView={setProductView}
          subcategories={subcategoryChips}
        />

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
            updateCartLineById(lineId, (line) => (
              quantity <= 0
                ? null
                : recalculateCartLine({ ...line, quantity })
            ));
          }}
          onLineRemove={(lineId) => {
            setVoidLineId(lineId);
            setIsVoidOpen(true);
          }}
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
        />
      </div>

      <ActionBar
        canTakePayment={canTakePayment}
        onCashAction={() => setMoneyMode(activeShift == null ? 'open' : 'close')}
        onCustomer={() => customerSelectRef.current?.focus()}
        onDiscount={() => discountInputRef.current?.focus()}
        onHold={() => handleOpenHoldModal('hold')}
        onPay={() => setIsPaymentOpen(true)}
        onQuote={() => showNotice('error', 'Quote mode is not wired yet; use Hold to park the bill.')}
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
            addProductToCart(product);
            setIsSearchOpen(false);
          }}
        />
      )}

      {isPaymentOpen && (
        <PaymentModal
          total={totals.total}
          onClose={() => setIsPaymentOpen(false)}
          onComplete={(payments) => void handleCompleteSale(payments)}
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
  isSyncing: boolean;
  onCashAction: () => void;
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
  return (
    <header className="glass-bar workstation-header">
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
        <MetricCard label="Cashier" value={props.cashierName} />
        <button className="ghost-button" onClick={props.onSync} disabled={props.isSyncing}>
          {props.isSyncing ? 'Syncing...' : 'Sync now'}
        </button>
        <button className="ghost-button" onClick={props.onOpenSync}>
          Sync center
        </button>
        <button className="ghost-button" onClick={props.onCashAction}>
          Cash
        </button>
        <button className="ghost-button" onClick={props.onZReport}>
          Reports
        </button>
        <button className="ghost-button danger" onClick={props.onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

type ProductPanelProps = {
  activeCategoryId: string;
  activeSubcategory: string | null;
  categories: Array<{ id: string; name: string; chip: string; count: number }>;
  onAddProduct: (product: Product) => void;
  onCategoryChange: (nextCategory: string) => void;
  onOpenSearch: () => void;
  onSubcategoryChange: (nextSubcategory: string | null) => void;
  productView: ProductViewMode;
  products: Product[];
  setProductView: (view: ProductViewMode) => void;
  subcategories: string[];
};

function ProductPanel(props: ProductPanelProps) {
  return (
    <section className="glass-panel product-panel">
      <div className="panel-head">
        <button className="search-trigger" onClick={props.onOpenSearch}>
          <span className="search-copy">Search products, SKU, or barcode</span>
          <kbd className="kbd">F3</kbd>
        </button>
        <div className="seg-toggle">
          <button
            className={props.productView === 'list' ? 'active' : ''}
            onClick={() => props.setProductView('list')}
          >
            List
          </button>
          <button
            className={props.productView === 'tile' ? 'active' : ''}
            onClick={() => props.setProductView('tile')}
          >
            Tiles
          </button>
        </div>
      </div>

      <div className="category-rail">
        {props.categories.map((category) => (
          <button
            key={category.id}
            className={`category-chip ${props.activeCategoryId === category.id ? 'active' : ''}`}
            onClick={() => props.onCategoryChange(category.id)}
          >
            <span className="category-token">{category.chip}</span>
            <span className="category-name">{category.name}</span>
            <span className="category-count">{formatInteger(category.count)}</span>
          </button>
        ))}
      </div>

      {props.subcategories.length > 0 && (
        <div className="subcategory-rail">
          <button
            className={`subcategory-chip ${props.activeSubcategory == null ? 'active' : ''}`}
            onClick={() => props.onSubcategoryChange(null)}
          >
            All
          </button>
          {props.subcategories.map((subcategory) => (
            <button
              key={subcategory}
              className={`subcategory-chip ${props.activeSubcategory === subcategory ? 'active' : ''}`}
              onClick={() => props.onSubcategoryChange(subcategory)}
            >
              {subcategory}
            </button>
          ))}
        </div>
      )}

      <div className="product-meta">
        <span>{formatInteger(props.products.length)} products</span>
        <span>Sorted by SKU</span>
      </div>

      <div className={props.productView === 'tile' ? 'product-tile-grid' : 'product-list'}>
        {props.products.map((product) => (
          props.productView === 'tile' ? (
            <button key={product.id} className="product-tile" onClick={() => props.onAddProduct(product)}>
              <div className="product-thumb">{getCategoryToken(product.subcategory || product.name)}</div>
              <div className="product-name">{product.name}</div>
              <div className="product-meta-line">{product.sku} - {product.subcategory}</div>
              <div className="product-price">{formatCurrency(product.priceTiers[0]?.price ?? 0)}</div>
              <div className="product-stock">Stock {formatInteger(product.stockOnHand)}</div>
            </button>
          ) : (
            <button key={product.id} className="product-row" onClick={() => props.onAddProduct(product)}>
              <div className="product-thumb compact">{getCategoryToken(product.subcategory || product.name)}</div>
              <div className="product-row-copy">
                <div className="product-name">{product.name}</div>
                <div className="product-meta-line">{product.sku} - {product.subcategory} - {product.unitLabel}</div>
              </div>
              <div className="product-row-side">
                <div className="product-price">{formatCurrency(product.priceTiers[0]?.price ?? 0)}</div>
                <div className="product-stock">Stock {formatInteger(product.stockOnHand)}</div>
              </div>
            </button>
          )
        ))}
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
  onLineSalespersonChange: (lineId: string, salespersonId: string) => void;
  onLineTierChange: (lineId: string, tierLabel: string) => void;
  onPay: () => void;
  salespeople: POSUser[];
  totals: ReturnType<typeof calcCartTotals>;
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
              <div className="cart-thumb">{getCategoryToken(line.subcategory || line.name)}</div>
              <div className="cart-line-body">
                <div className="cart-line-top">
                  <div>
                    <div className="cart-line-name">{line.name}</div>
                    <div className="cart-line-meta">{line.sku} - stock {formatInteger(line.stockOnHand)}</div>
                  </div>
                  <button className="line-remove" onClick={() => props.onLineRemove(line.uid)}>
                    x
                  </button>
                </div>

                <div className="cart-line-controls">
                  <div className="qty-stepper">
                    <button onClick={() => props.onLineQtyChange(line.uid, line.quantity - 1)}>-</button>
                    <input
                      value={line.quantity}
                      onChange={(event) => props.onLineQtyChange(line.uid, Number(event.target.value) || 1)}
                    />
                    <button onClick={() => props.onLineQtyChange(line.uid, line.quantity + 1)}>+</button>
                  </div>

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

                  <div className="line-total">{formatCurrency(line.lineTotal)}</div>
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
    <div className="glass-bar action-bar">
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
      <b>{props.shortcut}</b>
      <span>{props.label}</span>
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
    width?: 'narrow' | 'medium' | 'wide';
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
                <div>{product.sku} - {product.subcategory} - stock {formatInteger(product.stockOnHand)}</div>
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

function PaymentModal(
  props: {
    total: number;
    onClose: () => void;
    onComplete: (payments: PaymentInput[]) => void;
  },
) {
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [tendered, setTendered] = useState(props.total);
  const [reference, setReference] = useState('');
  const change = Math.max(0, roundToMoney(tendered - props.total));

  const quickAmounts = useMemo(() => {
    const rounded100 = Math.ceil(props.total / 100) * 100;
    const rounded500 = Math.ceil(props.total / 500) * 500;
    const rounded1000 = Math.ceil(props.total / 1000) * 1000;
    return [props.total, rounded100, rounded500, rounded1000];
  }, [props.total]);

  return (
    <ModalShell onClose={props.onClose} title="Payment" width="medium">
      <div className="payment-layout">
        <div className="payment-methods">
          {PAYMENT_OPTIONS.map((option) => (
            <button
              key={option.method}
              className={`payment-method ${method === option.method ? 'active' : ''}`}
              onClick={() => setMethod(option.method)}
            >
              <span>{option.short}</span>
              <div>{option.label}</div>
            </button>
          ))}
        </div>

        <div className="payment-main">
          <div className="meta-label">Total due</div>
          <div className="payment-total">{formatCurrency(props.total)}</div>

          <LabelBlock label="Tendered">
            <input
              className="glass-input large"
              disabled={method !== PaymentMethod.CASH}
              type="number"
              min={0}
              step={0.01}
              value={tendered}
              onChange={(event) => setTendered(Number(event.target.value) || 0)}
            />
          </LabelBlock>

          <div className="quick-cash-row">
            {quickAmounts.map((amount) => (
              <button key={amount} className="quick-cash" onClick={() => setTendered(amount)}>
                {formatCurrency(amount)}
              </button>
            ))}
          </div>

          {method !== PaymentMethod.CASH && (
            <LabelBlock label="Reference">
              <input
                className="glass-input"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Auth code / last 4 digits"
              />
            </LabelBlock>
          )}

          <div className="payment-change-row">
            <span>Change</span>
            <b>{formatCurrency(change)}</b>
          </div>

          <button
            className="btn-primary full-width"
            disabled={method === PaymentMethod.CASH && tendered < props.total}
            onClick={() => props.onComplete(buildPayments(props.total, method, tendered, change, reference))}
          >
            Complete sale
          </button>
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
    denomination: { label: string; value: number };
    onChange: (nextCount: number) => void;
  },
) {
  return (
    <div className="denomination-row">
      <span>{props.denomination.label}</span>
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
        {props.sale.payments.map((payment, index) => (
          <div key={`${payment.method}-${index}`} className="receipt-line-item">
            <span>{payment.method}</span>
            <span>{formatCurrency(payment.amount)}</span>
          </div>
        ))}
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
