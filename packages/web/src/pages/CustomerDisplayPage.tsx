import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_POS_CUSTOMER_DISPLAY,
  createIdleCustomerDisplayState,
  type POSCustomerDisplayState,
} from '@jingles/shared';
import { subscribeCustomerDisplayState } from '../customerDisplay';
import { formatCurrency, formatInteger } from '../utils/pos';

function formatClockTime(value: Date) {
  return value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDisplayDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * The customer-facing screen.
 *
 * It renders snapshots and nothing else: no API calls, no cart maths, no
 * authentication. Everything it shows was decided by the workstation, which
 * means it can be opened, closed or reloaded at any point in a sale without
 * touching the bill.
 */
export default function CustomerDisplayPage() {
  const [state, setState] = useState<POSCustomerDisplayState>(
    () => createIdleCustomerDisplayState(DEFAULT_POS_CUSTOMER_DISPLAY),
  );
  const [now, setNow] = useState(() => new Date());
  const lineListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => subscribeCustomerDisplayState(setState), []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // The display follows the workstation's theme, and owns the document while it
  // is mounted so the POS stylesheet's page background applies here too.
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', state.themeMode);
    document.body.classList.add('customer-display-body');

    return () => {
      if (previousTheme) {
        root.setAttribute('data-theme', previousTheme);
      } else {
        root.removeAttribute('data-theme');
      }
      document.body.classList.remove('customer-display-body');
    };
  }, [state.themeMode]);

  // Newest line last, so the screen behaves like a printed receipt scrolling out.
  useEffect(() => {
    const list = lineListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [state.lines]);

  const headerName = state.storeName || state.branchName || 'Jingles';
  const isComplete = state.mode === 'complete';
  const isIdle = state.mode === 'idle';
  const dateLabel = useMemo(
    () => formatDisplayDate(isComplete ? state.saleDate : now.toISOString()),
    [isComplete, now, state.saleDate],
  );

  return (
    <div className="customer-display">
      <header className="customer-display-header">
        <div className="customer-display-store">{headerName}</div>
        <div className="customer-display-meta">
          <span>{dateLabel}</span>
          <span className="customer-display-meta-dot">·</span>
          <span>{formatClockTime(now)}</span>
          {state.showCashierName && state.cashierName && (
            <>
              <span className="customer-display-meta-dot">·</span>
              <span>Served by {state.cashierName}</span>
            </>
          )}
          {state.terminalCode && (
            <>
              <span className="customer-display-meta-dot">·</span>
              <span>{state.terminalCode}</span>
            </>
          )}
        </div>
      </header>

      {isIdle ? (
        <main className="customer-display-idle">
          <div className="customer-display-welcome">{state.welcomeMessage}</div>
          {state.welcomeSubtitle && (
            <div className="customer-display-welcome-sub">{state.welcomeSubtitle}</div>
          )}
        </main>
      ) : (
        <main className="customer-display-body-grid">
          <section className="customer-display-lines" aria-label="Items">
            <div className="customer-display-lines-head">
              <span>Item</span>
              <span>Qty</span>
              <span>Price</span>
              <span>Amount</span>
            </div>

            <div className="customer-display-lines-scroll" ref={lineListRef}>
              {state.lines.length === 0 ? (
                <div className="customer-display-empty">Waiting for items...</div>
              ) : state.lines.map((line, index) => (
                <div
                  className={`customer-display-line ${!isComplete && index === state.lines.length - 1 ? 'latest' : ''}`}
                  key={line.uid}
                >
                  <div className="customer-display-line-name">
                    <span>{line.name}</span>
                    {line.variant && <small>{line.variant}</small>}
                    {line.discountAmount > 0 && (
                      <small className="customer-display-line-discount">
                        Discount -{formatCurrency(line.discountAmount)}
                      </small>
                    )}
                  </div>
                  <div className="customer-display-line-qty">{formatInteger(line.quantity)}</div>
                  <div className="customer-display-line-price">{formatCurrency(line.unitPrice)}</div>
                  <div className="customer-display-line-total">{formatCurrency(line.lineTotal)}</div>
                </div>
              ))}
            </div>
          </section>

          <aside className="customer-display-summary">
            {isComplete && (
              <div className="customer-display-thanks">
                <div className="customer-display-thanks-title">{state.thankYouMessage}</div>
                {state.receiptNumber && (
                  <div className="customer-display-receipt">Receipt {state.receiptNumber}</div>
                )}
              </div>
            )}

            <div className="customer-display-row">
              <span>Items</span>
              <span>{formatInteger(state.itemCount)}</span>
            </div>
            <div className="customer-display-row">
              <span>Sub total</span>
              <span>{formatCurrency(state.subtotal)}</span>
            </div>
            {state.discountTotal > 0 && (
              <div className="customer-display-row discount">
                <span>Discount</span>
                <span>-{formatCurrency(state.discountTotal)}</span>
              </div>
            )}
            {state.taxTotal > 0 && (
              <div className="customer-display-row">
                <span>Tax</span>
                <span>{formatCurrency(state.taxTotal)}</span>
              </div>
            )}

            <div className="customer-display-total">
              <span>Total</span>
              <span>{formatCurrency(state.total)}</span>
            </div>

            {state.payments.length > 0 && (
              <div className="customer-display-payments">
                <div className="customer-display-section-label">
                  {state.payments.length > 1 ? 'Payments' : 'Payment'}
                </div>
                {state.payments.map((payment, index) => (
                  <div className="customer-display-row" key={`${payment.method}-${index}`}>
                    <span>{payment.label}</span>
                    <span>{formatCurrency(payment.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            {state.balanceDue > 0 && (
              <div className="customer-display-row balance">
                <span>Balance due</span>
                <span>{formatCurrency(state.balanceDue)}</span>
              </div>
            )}

            {state.changeDue > 0 && (
              <div className="customer-display-change">
                <span>Change</span>
                <span>{formatCurrency(state.changeDue)}</span>
              </div>
            )}

            {state.customerName && (
              <div className="customer-display-customer">{state.customerName}</div>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}
