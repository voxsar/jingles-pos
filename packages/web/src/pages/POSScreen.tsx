import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CartLine, PaymentMethod } from '@jingles/shared';
import { searchProducts, createSale, openShift, closeShift, getActiveShift, createReturn, getSale } from '../api';
import { resolvePrice, calcCartTotals, formatCurrency, generateReceiptNumber } from '../utils/pos';

const TERMINAL_ID = 'WEB-TERM-001';
const USER_ID = 'cashier-1';

interface Product {
  id: string;
  sku: string;
  name: string;
  barcode?: string;
  price: number;
  batchPrices: Array<{ id: string; minQty: number; price: number }>;
  inventory?: Array<{ id: string; state: string }>;
}

interface Shift {
  id: string;
  status: string;
  openedAt: string;
  openingFloat: number;
}

interface Sale {
  id: string;
  receiptNumber: string;
  total: number;
  status: string;
  lines: any[];
  payments: any[];
}

export default function POSScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payMethod, setPayMethod] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [cashReceived, setCashReceived] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [shift, setShift] = useState<Shift | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [showReturn, setShowReturn] = useState(false);
  const [returnSaleId, setReturnSaleId] = useState('');
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const { subtotal, discountTotal, taxTotal, total } = calcCartTotals(cart);
  const cashAmount = parseFloat(cashReceived) || 0;
  const changeDue = Math.max(0, cashAmount - total);

  useEffect(() => {
    getActiveShift(TERMINAL_ID)
      .then((s) => setShift(s))
      .catch(() => {});
    searchRef.current?.focus();
  }, []);

  // Keyboard-wedge barcode scanner: rapid input ending with Enter
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      doSearch();
    }
  };

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setIsSearching(true);
    setErrorMsg('');
    try {
      const products = await searchProducts(q);
      setResults(products);
      // If exact barcode match, auto-add to cart
      if (products.length === 1 && products[0].barcode === q) {
        addToCart(products[0]);
        setQuery('');
        setResults([]);
      }
    } catch {
      setErrorMsg('Search failed');
    } finally {
      setIsSearching(false);
    }
  }, [query]);

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((l) => l.productId === product.id);
      if (existing) {
        const newQty = existing.quantity + 1;
        const unitPrice = resolvePrice(product.price, newQty, product.batchPrices);
        return prev.map((l) =>
          l.productId === product.id
            ? { ...l, quantity: newQty, unitPrice, lineTotal: unitPrice * newQty - l.discountAmount }
            : l
        );
      }
      const unitPrice = resolvePrice(product.price, 1, product.batchPrices);
      return [
        ...prev,
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          barcode: product.barcode,
          unitPrice,
          quantity: 1,
          discountAmount: 0,
          lineTotal: unitPrice,
        },
      ];
    });
    setSuccessMsg(`Added: ${product.name}`);
    setTimeout(() => setSuccessMsg(''), 2000);
    searchRef.current?.focus();
  }

  function updateQty(productId: string, qty: number) {
    if (qty <= 0) {
      setCart((prev) => prev.filter((l) => l.productId !== productId));
      return;
    }
    setCart((prev) =>
      prev.map((l) => {
        if (l.productId !== productId) return l;
        const lineTotal = l.unitPrice * qty - l.discountAmount;
        return { ...l, quantity: qty, lineTotal };
      })
    );
  }

  function updateDiscount(productId: string, discount: number) {
    setCart((prev) =>
      prev.map((l) => {
        if (l.productId !== productId) return l;
        const lineTotal = l.unitPrice * l.quantity - discount;
        return { ...l, discountAmount: Math.max(0, discount), lineTotal };
      })
    );
  }

  function removeFromCart(productId: string) {
    setCart((prev) => prev.filter((l) => l.productId !== productId));
  }

  async function handleCompleteSale() {
    if (cart.length === 0) { setErrorMsg('Cart is empty'); return; }
    if (payMethod === PaymentMethod.CASH && cashAmount < total) {
      setErrorMsg('Cash received is less than total'); return;
    }
    setIsProcessing(true);
    setErrorMsg('');
    try {
      const payload = {
        receiptNumber: generateReceiptNumber(),
        terminalId: TERMINAL_ID,
        userId: USER_ID,
        shiftId: shift?.id,
        lines: cart.map((l) => ({
          productId: l.productId,
          sku: l.sku,
          name: l.name,
          barcode: l.barcode,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountAmount: l.discountAmount,
          lineTotal: l.lineTotal,
        })),
        payment: {
          method: payMethod,
          amount: total,
          cashReceived: payMethod === PaymentMethod.CASH ? cashAmount : undefined,
          changeDue: payMethod === PaymentMethod.CASH ? changeDue : undefined,
        },
        subtotal,
        discountTotal,
        taxTotal,
        total,
      };

      const sale = await createSale(payload);
      setLastSale(sale);
      setShowReceipt(true);
      setCart([]);
      setCashReceived('');
      setResults([]);
    } catch (err: any) {
      setErrorMsg(err.message || 'Sale failed');
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleOpenShift() {
    const float = parseFloat(prompt('Enter opening float amount:', '0') ?? '0') || 0;
    try {
      const s = await openShift({ terminalId: TERMINAL_ID, userId: USER_ID, openingFloat: float });
      setShift(s);
      setSuccessMsg('Shift opened');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to open shift');
    }
  }

  async function handleCloseShift() {
    if (!shift) return;
    const float = parseFloat(prompt('Enter closing float amount:', '0') ?? '0') || 0;
    try {
      await closeShift(shift.id, { closingFloat: float });
      setShift(null);
      setSuccessMsg('Shift closed');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to close shift');
    }
  }

  async function handleLoadReturnSale() {
    if (!returnSaleId.trim()) return;
    try {
      const sale = await getSale(returnSaleId.trim());
      setReturnSale(sale);
      const qtys: Record<string, number> = {};
      sale.lines.forEach((l: any) => { qtys[l.id] = 0; });
      setReturnQtys(qtys);
    } catch {
      setErrorMsg('Sale not found');
    }
  }

  async function handleSubmitReturn() {
    if (!returnSale) return;
    const lines = returnSale.lines
      .filter((l: any) => returnQtys[l.id] > 0)
      .map((l: any) => ({
        saleLineId: l.id,
        productId: l.productId,
        quantity: returnQtys[l.id],
        refundAmount: l.unitPrice * returnQtys[l.id],
      }));

    if (lines.length === 0) { setErrorMsg('No items selected for return'); return; }

    try {
      await createReturn({ saleId: returnSale.id, lines, userId: USER_ID, terminalId: TERMINAL_ID });
      setSuccessMsg('Return processed successfully');
      setShowReturn(false);
      setReturnSale(null);
      setReturnSaleId('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Return failed');
    }
  }

  return (
    <div className="pos-container">
      {/* LEFT: Search + Products + Cart */}
      <div className="pos-left">
        {/* Shift status */}
        <div className="shift-panel">
          <div className="shift-status">
            <div className={`shift-dot ${shift ? 'open' : 'closed'}`} />
            <span>{shift ? `Shift open since ${new Date(shift.openedAt).toLocaleTimeString()}` : 'No active shift'}</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {errorMsg && <span className="error-msg">{errorMsg}</span>}
            {successMsg && <span className="success-msg">{successMsg}</span>}
            {!shift ? (
              <button className="shift-btn open-btn" onClick={handleOpenShift}>Open Shift</button>
            ) : (
              <>
                <button className="shift-btn close-btn" onClick={handleCloseShift}>Close Shift</button>
                <button className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.7rem' }} onClick={() => { setShowReturn(true); setErrorMsg(''); }}>Returns</button>
              </>
            )}
          </div>
        </div>

        {/* Search / Scan */}
        <div className="search-bar">
          <input
            ref={searchRef}
            className="search-input"
            placeholder="🔍 Scan barcode or search product name / SKU..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus
          />
          <button className="btn btn-primary" onClick={doSearch} disabled={isSearching}>
            {isSearching ? '...' : 'Search'}
          </button>
        </div>

        {/* Product results */}
        {results.length > 0 && (
          <div className="product-panel">
            <div className="product-grid">
              {results.map((p) => {
                const stock = p.inventory?.length ?? 0;
                return (
                  <button key={p.id} className="product-card" onClick={() => { addToCart(p); setResults([]); setQuery(''); }}>
                    <div className="product-card-name">{p.name}</div>
                    <div className="product-card-sku">{p.sku}</div>
                    <div className="product-card-price">{formatCurrency(p.price)}</div>
                    <div className="product-card-stock">Stock: {stock}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Cart */}
        <div className="cart-section">
          <div className="cart-header">
            <span>🛒 Cart ({cart.length} items)</span>
            {cart.length > 0 && <button className="clear-btn" style={{ width: 'auto', padding: '0.2rem 0.6rem', fontSize: '0.8rem' }} onClick={() => setCart([])}>Clear</button>}
          </div>
          <div className="cart-table-wrap">
            {cart.length === 0 ? (
              <div className="cart-empty">Scan or search a product to begin</div>
            ) : (
              <table className="cart-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Qty</th>
                    <th>Unit Price</th>
                    <th>Discount</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((line) => (
                    <tr key={line.productId}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{line.name}</div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{line.sku}</div>
                      </td>
                      <td>
                        <div className="qty-controls">
                          <button className="qty-btn" onClick={() => updateQty(line.productId, line.quantity - 1)}>−</button>
                          <input
                            className="qty-input"
                            type="number"
                            min={1}
                            value={line.quantity}
                            onChange={(e) => updateQty(line.productId, parseInt(e.target.value) || 1)}
                          />
                          <button className="qty-btn" onClick={() => updateQty(line.productId, line.quantity + 1)}>+</button>
                        </div>
                      </td>
                      <td>{formatCurrency(line.unitPrice)}</td>
                      <td>
                        <input
                          className="discount-input"
                          type="number"
                          min={0}
                          step={0.01}
                          value={line.discountAmount}
                          onChange={(e) => updateDiscount(line.productId, parseFloat(e.target.value) || 0)}
                          placeholder="$0.00"
                        />
                      </td>
                      <td style={{ fontWeight: 600 }}>{formatCurrency(line.lineTotal)}</td>
                      <td>
                        <button className="remove-btn" onClick={() => removeFromCart(line.productId)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT: Payment panel */}
      <div className="pos-right">
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: '1rem' }}>
          💳 Payment
        </div>

        <div className="payment-panel" style={{ flex: 1, overflowY: 'auto' }}>
          {/* Totals */}
          <div className="totals-section">
            <div className="total-row">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            {discountTotal > 0 && (
              <div className="total-row" style={{ color: 'var(--success)' }}>
                <span>Discount</span>
                <span>−{formatCurrency(discountTotal)}</span>
              </div>
            )}
            {taxTotal > 0 && (
              <div className="total-row">
                <span>Tax</span>
                <span>{formatCurrency(taxTotal)}</span>
              </div>
            )}
            <div className="total-row grand">
              <span>TOTAL</span>
              <span>{formatCurrency(total)}</span>
            </div>
          </div>

          {/* Payment method */}
          <div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginBottom: '0.4rem' }}>Payment Method</div>
            <div className="payment-methods">
              {[PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.MIXED].map((m) => (
                <button
                  key={m}
                  className={`pay-method-btn ${payMethod === m ? 'selected' : ''}`}
                  onClick={() => setPayMethod(m)}
                >
                  {m === PaymentMethod.CASH ? '💵 Cash' : m === PaymentMethod.CARD ? '💳 Card' : '🔀 Mixed'}
                </button>
              ))}
            </div>
          </div>

          {/* Cash input */}
          {(payMethod === PaymentMethod.CASH || payMethod === PaymentMethod.MIXED) && (
            <div className="cash-section">
              <div className="cash-row">
                <label>Cash Received</label>
                <input
                  className="cash-input"
                  type="number"
                  min={0}
                  step={0.01}
                  value={cashReceived}
                  onChange={(e) => setCashReceived(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              {cashAmount > 0 && (
                <div className="cash-row">
                  <label>Change Due</label>
                  <span className="change-display">{formatCurrency(changeDue)}</span>
                </div>
              )}
            </div>
          )}

          {/* Complete sale */}
          <button
            className="complete-btn"
            onClick={handleCompleteSale}
            disabled={cart.length === 0 || isProcessing || !shift}
          >
            {isProcessing ? 'Processing...' : !shift ? 'Open a Shift First' : `Complete Sale — ${formatCurrency(total)}`}
          </button>

          <button className="clear-btn" onClick={() => setCart([])}>🗑 Clear Cart</button>
        </div>
      </div>

      {/* Receipt Modal */}
      {showReceipt && lastSale && (
        <div className="modal-overlay" onClick={() => setShowReceipt(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="receipt-header">
              <div className="receipt-title">🧾 Receipt</div>
              <div className="receipt-sub">Jingles POS — {TERMINAL_ID}</div>
              <div className="receipt-sub">{lastSale.receiptNumber}</div>
            </div>
            <hr className="receipt-divider" />
            {lastSale.lines?.map((l: any) => (
              <div key={l.id} className="receipt-line">
                <span>{l.name} × {l.quantity}</span>
                <span>{formatCurrency(l.lineTotal)}</span>
              </div>
            ))}
            <hr className="receipt-divider" />
            <div className="receipt-line receipt-total">
              <span>TOTAL</span>
              <span>{formatCurrency(lastSale.total)}</span>
            </div>
            {lastSale.payments?.[0] && (
              <>
                <div className="receipt-line">
                  <span>Paid ({lastSale.payments[0].method})</span>
                  <span>{formatCurrency(lastSale.payments[0].cashReceived ?? lastSale.payments[0].amount)}</span>
                </div>
                {lastSale.payments[0].changeDue > 0 && (
                  <div className="receipt-line" style={{ color: 'var(--success)' }}>
                    <span>Change</span>
                    <span>{formatCurrency(lastSale.payments[0].changeDue)}</span>
                  </div>
                )}
              </>
            )}
            <hr className="receipt-divider" />
            <div style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-light)' }}>
              Thank you for shopping at Jingles!
            </div>
            <div className="receipt-actions">
              <button className="btn-print" onClick={() => window.print()}>🖨 Print</button>
              <button className="btn-close-modal" onClick={() => setShowReceipt(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Return/Refund Modal */}
      {showReturn && (
        <div className="modal-overlay" onClick={() => setShowReturn(false)}>
          <div className="modal-box returns-modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '1rem' }}>↩ Process Return / Refund</h2>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                className="cash-input"
                style={{ flex: 1 }}
                placeholder="Enter Sale ID or Receipt Number"
                value={returnSaleId}
                onChange={(e) => setReturnSaleId(e.target.value)}
              />
              <button className="btn btn-primary" onClick={handleLoadReturnSale}>Load Sale</button>
            </div>

            {returnSale && (
              <>
                <div style={{ marginBottom: '0.75rem', fontSize: '0.85rem', color: 'var(--text-light)' }}>
                  Sale: {returnSale.receiptNumber} — Total: {formatCurrency(returnSale.total)}
                </div>
                {returnSale.lines.map((l: any) => (
                  <div key={l.id} className="return-line-row">
                    <div className="return-line-name">{l.name} (sold: {l.quantity})</div>
                    <input
                      className="return-qty-input"
                      type="number"
                      min={0}
                      max={l.quantity}
                      value={returnQtys[l.id] ?? 0}
                      onChange={(e) => setReturnQtys((prev) => ({ ...prev, [l.id]: parseInt(e.target.value) || 0 }))}
                    />
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>× {formatCurrency(l.unitPrice)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                  <button className="btn btn-danger" onClick={handleSubmitReturn}>Submit Return</button>
                  <button className="btn btn-secondary" onClick={() => { setShowReturn(false); setReturnSale(null); }}>Cancel</button>
                </div>
              </>
            )}

            {!returnSale && (
              <div style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>Enter a Sale ID to load the sale for return.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
