import {
  CompleteSaleInput,
  POSAuthLoginInput,
  POSAuthResult,
  Product,
  POSSyncDashboard,
  SaleSummary,
  HeldSaleSummary,
  HoldSaleInput,
  POSBootstrap,
  POSUser,
  ReturnInput,
  ShiftSummary,
  ShiftCloseInput,
  ShiftOpenInput,
  SyncStatusSummary,
  ZReportSummary,
} from '@jingles/shared';

const BASE = '/api/pos';

function hasBridge() {
  return typeof window !== 'undefined' && typeof window.posAPI !== 'undefined';
}

function buildAuthHeaders(token?: string | null): Record<string, string> {
  const normalized = token?.trim();
  if (!normalized) {
    return {};
  }

  return { Authorization: `Bearer ${normalized}` };
}

async function getJson<T>(path: string, options?: { token?: string | null }): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: buildAuthHeaders(options?.token),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, payload: unknown, options?: { token?: string | null }): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(options?.token),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function login(input: POSAuthLoginInput): Promise<POSAuthResult> {
  if (hasBridge()) {
    return window.posAPI!.login(input);
  }

  return postJson<POSAuthResult>('/auth/login', input);
}

export async function getCurrentUser(token: string): Promise<POSUser | null> {
  if (hasBridge()) {
    return window.posAPI!.me(token);
  }

  return getJson<POSUser>('/auth/me', { token });
}

export async function logout(token: string): Promise<void> {
  if (hasBridge()) {
    await window.posAPI!.logout(token);
    return;
  }

  await postJson<{ ok: true }>('/auth/logout', {}, { token });
}

export async function bootstrapPOS(options?: { deviceId?: string; terminalId?: string }): Promise<POSBootstrap> {
  if (hasBridge()) {
    return window.posAPI!.bootstrap(options);
  }

  const params = new URLSearchParams();
  if (options?.deviceId) {
    params.set('deviceId', options.deviceId);
  }
  if (options?.terminalId) {
    params.set('terminalId', options.terminalId);
  }
  return getJson<POSBootstrap>(`/bootstrap${params.size > 0 ? `?${params.toString()}` : ''}`);
}

export async function searchProducts(query: string): Promise<Product[]> {
  if (hasBridge()) {
    return window.posAPI!.searchProducts(query);
  }
  return getJson<Product[]>(`${'/products/search'}?q=${encodeURIComponent(query)}`);
}

export async function openShift(input: ShiftOpenInput): Promise<ShiftSummary> {
  if (hasBridge()) {
    return window.posAPI!.openShift(input);
  }
  return postJson<ShiftSummary>('/shifts/open', input);
}

export async function closeShift(input: ShiftCloseInput & { terminalId?: string }): Promise<ShiftSummary> {
  if (hasBridge()) {
    return window.posAPI!.closeShift(input);
  }
  return postJson<ShiftSummary>(`/shifts/${encodeURIComponent(input.shiftId)}/close`, input);
}

export async function saveHeldSale(
  input: Omit<HoldSaleInput, 'holdNumber'> & { holdNumber?: string },
): Promise<HeldSaleSummary> {
  if (hasBridge()) {
    return window.posAPI!.saveHeldSale(input);
  }
  return postJson<HeldSaleSummary>('/held-sales', input);
}

export async function listHeldSales(): Promise<HeldSaleSummary[]> {
  if (hasBridge()) {
    return window.posAPI!.listHeldSales();
  }
  return getJson('/held-sales');
}

export async function recallHeldSale(heldSaleId: string): Promise<HeldSaleSummary> {
  if (hasBridge()) {
    return window.posAPI!.recallHeldSale(heldSaleId);
  }
  return postJson(`/held-sales/${encodeURIComponent(heldSaleId)}/recall`, {});
}

export async function createSale(input: CompleteSaleInput): Promise<SaleSummary> {
  if (hasBridge()) {
    return window.posAPI!.createSale(input);
  }
  return postJson<SaleSummary>('/sales', input);
}

export async function listSales(): Promise<SaleSummary[]> {
  if (hasBridge()) {
    return window.posAPI!.listSales();
  }
  return getJson<SaleSummary[]>('/sales');
}

export async function getSale(saleId: string): Promise<SaleSummary> {
  if (hasBridge()) {
    return window.posAPI!.getSale(saleId);
  }
  return getJson<SaleSummary>(`/sales/${encodeURIComponent(saleId)}`);
}

export async function createReturn(input: ReturnInput): Promise<{ id: string; saleId: string; totalRefund: number }> {
  if (hasBridge()) {
    return window.posAPI!.createReturn(input);
  }
  return postJson<{ id: string; saleId: string; totalRefund: number }>('/returns', input);
}

export async function getZReport(shiftId: string): Promise<ZReportSummary> {
  if (hasBridge()) {
    return window.posAPI!.getZReport(shiftId);
  }
  return getJson(`/shifts/${encodeURIComponent(shiftId)}/z-report`);
}

export async function getSyncStatus(): Promise<SyncStatusSummary> {
  if (hasBridge()) {
    return window.posAPI!.getSyncStatus();
  }
  const bootstrap = await bootstrapPOS();
  return bootstrap.syncStatus;
}

export async function getSyncDashboard(): Promise<POSSyncDashboard> {
  if (hasBridge()) {
    return window.posAPI!.getSyncDashboard();
  }

  const bootstrap = await bootstrapPOS();
  return {
    status: bootstrap.syncStatus,
    pendingEvents: [],
    recentEvents: [],
    conflicts: [],
  };
}

export async function syncNow() {
  if (hasBridge()) {
    return window.posAPI!.syncNow();
  }
  return postJson('/sync/playback', {
    deviceId: 'browser-client',
    terminalId: 'TERM-03',
    vectorClock: {},
    events: [],
  });
}

export function subscribeSyncStatus(callback: (status: SyncStatusSummary) => void): () => void {
  if (hasBridge()) {
    return window.posAPI!.onSyncStatus(callback);
  }
  return () => undefined;
}
