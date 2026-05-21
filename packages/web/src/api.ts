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
import { resolveBackendUrl } from './runtime';

const BASE = resolveBackendUrl('/api/pos');

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
  return postJson<POSAuthResult>('/auth/login', input);
}

export async function getCurrentUser(token: string): Promise<POSUser | null> {
  return getJson<POSUser>('/auth/me', { token });
}

export async function logout(token: string): Promise<void> {
  await postJson<{ ok: true }>('/auth/logout', {}, { token });
}

export async function bootstrapPOS(options?: { deviceId?: string; terminalId?: string }): Promise<POSBootstrap> {
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
  return getJson<Product[]>(`${'/products/search'}?q=${encodeURIComponent(query)}`);
}

export async function openShift(input: ShiftOpenInput): Promise<ShiftSummary> {
  return postJson<ShiftSummary>('/shifts/open', input);
}

export async function closeShift(input: ShiftCloseInput & { terminalId?: string }): Promise<ShiftSummary> {
  return postJson<ShiftSummary>(`/shifts/${encodeURIComponent(input.shiftId)}/close`, input);
}

export async function saveHeldSale(
  input: Omit<HoldSaleInput, 'holdNumber'> & { holdNumber?: string },
): Promise<HeldSaleSummary> {
  return postJson<HeldSaleSummary>('/held-sales', input);
}

export async function listHeldSales(): Promise<HeldSaleSummary[]> {
  return getJson('/held-sales');
}

export async function recallHeldSale(heldSaleId: string): Promise<HeldSaleSummary> {
  return postJson(`/held-sales/${encodeURIComponent(heldSaleId)}/recall`, {});
}

export async function createSale(input: CompleteSaleInput): Promise<SaleSummary> {
  return postJson<SaleSummary>('/sales', input);
}

export async function listSales(): Promise<SaleSummary[]> {
  return getJson<SaleSummary[]>('/sales');
}

export async function getSale(saleId: string): Promise<SaleSummary> {
  return getJson<SaleSummary>(`/sales/${encodeURIComponent(saleId)}`);
}

export async function createReturn(input: ReturnInput): Promise<{ id: string; saleId: string; totalRefund: number }> {
  return postJson<{ id: string; saleId: string; totalRefund: number }>('/returns', input);
}

export async function getZReport(shiftId: string): Promise<ZReportSummary> {
  return getJson(`/shifts/${encodeURIComponent(shiftId)}/z-report`);
}

export async function getSyncStatus(options?: { deviceId?: string; terminalId?: string }): Promise<SyncStatusSummary> {
  const params = new URLSearchParams();
  if (options?.deviceId) {
    params.set('deviceId', options.deviceId);
  }
  if (options?.terminalId) {
    params.set('terminalId', options.terminalId);
  }

  return getJson<SyncStatusSummary>(`/local/sync/status${params.size > 0 ? `?${params.toString()}` : ''}`);
}

export async function getSyncDashboard(options?: { deviceId?: string; terminalId?: string; limit?: number }): Promise<POSSyncDashboard> {
  const params = new URLSearchParams();
  if (options?.deviceId) {
    params.set('deviceId', options.deviceId);
  }
  if (options?.terminalId) {
    params.set('terminalId', options.terminalId);
  }
  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(options.limit));
  }

  return getJson<POSSyncDashboard>(`/local/sync/dashboard${params.size > 0 ? `?${params.toString()}` : ''}`);
}

export async function syncNow(options?: { deviceId?: string; terminalId?: string }) {
  return postJson('/local/sync/now', {
    deviceId: options?.deviceId,
    terminalId: options?.terminalId,
  });
}

export function subscribeSyncStatus(_callback: (status: SyncStatusSummary) => void): () => void {
  return () => undefined;
}
