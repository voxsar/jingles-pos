import React, { useEffect, useState } from 'react';
import { listSales, voidSale } from '../api';
import { formatCurrency } from '../utils/pos';

interface Sale {
  id: string;
  receiptNumber: string;
  total: number;
  status: string;
  createdAt: string;
  lines: any[];
  payments: any[];
}

export default function SalesHistory() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listSales()
      .then(setSales)
      .catch(() => setError('Failed to load sales'))
      .finally(() => setLoading(false));
  }, []);

  async function handleVoid(id: string) {
    if (!confirm('Void this sale?')) return;
    try {
      await voidSale(id);
      setSales((prev) => prev.map((s) => s.id === id ? { ...s, status: 'VOIDED' } : s));
    } catch (e: any) {
      alert(e.message || 'Failed to void');
    }
  }

  function statusBadge(status: string) {
    const cls: Record<string, string> = {
      COMPLETED: 'badge-success',
      VOIDED: 'badge-danger',
      RETURNED: 'badge-warning',
      PARTIALLY_RETURNED: 'badge-warning',
      DRAFT: 'badge-gray',
    };
    return <span className={`badge ${cls[status] || 'badge-gray'}`}>{status}</span>;
  }

  function paymentMethod(sale: Sale) {
    if (!sale.payments || sale.payments.length === 0) return '—';
    return sale.payments.map((p: any) => p.method).join(', ');
  }

  return (
    <div className="page-container">
      <div className="page-title">Sales History</div>
      {loading && <p>Loading...</p>}
      {error && <div className="error-msg">{error}</div>}
      {!loading && !error && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Date</th>
              <th>Items</th>
              <th>Payment</th>
              <th>Total</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sales.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: '#64748b' }}>No sales yet</td></tr>
            )}
            {sales.map((s) => (
              <tr key={s.id}>
                <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{s.receiptNumber}</td>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td>{s.lines?.length ?? 0} item(s)</td>
                <td>{paymentMethod(s)}</td>
                <td style={{ fontWeight: 600 }}>{formatCurrency(s.total)}</td>
                <td>{statusBadge(s.status)}</td>
                <td>
                  {s.status === 'COMPLETED' && (
                    <button className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => handleVoid(s.id)}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
