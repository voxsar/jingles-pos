const BASE = '/api';

export async function searchProducts(q: string) {
  const r = await fetch(`${BASE}/pos/products/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Search failed');
  return r.json();
}

export async function scanBarcode(barcode: string) {
  const r = await fetch(`${BASE}/pos/products/barcode/${encodeURIComponent(barcode)}`);
  if (!r.ok) throw new Error('Product not found');
  return r.json();
}

export async function createSale(payload: any) {
  const r = await fetch(`${BASE}/pos/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Sale failed');
  }
  return r.json();
}

export async function listSales() {
  const r = await fetch(`${BASE}/pos/sales`);
  if (!r.ok) throw new Error('Failed to load sales');
  return r.json();
}

export async function getSale(id: string) {
  const r = await fetch(`${BASE}/pos/sales/${id}`);
  if (!r.ok) throw new Error('Sale not found');
  return r.json();
}

export async function voidSale(id: string) {
  const r = await fetch(`${BASE}/pos/sales/${id}/void`, { method: 'POST' });
  if (!r.ok) throw new Error('Failed to void sale');
  return r.json();
}

export async function createReturn(payload: any) {
  const r = await fetch(`${BASE}/pos/returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Return failed');
  }
  return r.json();
}

export async function openShift(payload: any) {
  const r = await fetch(`${BASE}/pos/shifts/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to open shift');
  }
  return r.json();
}

export async function closeShift(id: string, payload: any) {
  const r = await fetch(`${BASE}/pos/shifts/${id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('Failed to close shift');
  return r.json();
}

export async function getActiveShift(terminalId?: string) {
  const url = terminalId
    ? `${BASE}/pos/shifts/active?terminalId=${encodeURIComponent(terminalId)}`
    : `${BASE}/pos/shifts/active`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Failed to get shift');
  return r.json();
}
