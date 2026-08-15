import {
	CashMovementInput,
	CompleteSaleInput,
	CustomerAccountDetail,
	DrawerContents,
	POSAuthLoginInput,
	POSAuthResult,
	POSSyncRunResult,
	POSSyncTokenResult,
	Product,
	POSSyncDashboard,
	RecordCreditPaymentInput,
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
	UpdateCustomerInput,
	Customer,
	ZReportSummary,
	ZReportSlot,
} from '@jingles/shared';
import { resolveBackendUrl } from './runtime';
import { reportClientError } from './clientErrorReporter';

const BASE = resolveBackendUrl('/api/pos');
const TOKEN_STORAGE_KEY = 'jingles-pos-auth-token';

type ApiErrorPayload = {
	error?: string;
	diagnosticId?: string;
	diagnostic?: {
		name?: string;
		message?: string;
		stack?: string;
		code?: string;
	};
};

function buildResponseError(payload: ApiErrorPayload, status: number) {
	const diagnosticId = payload.diagnosticId?.trim();
	const message = payload.error || `HTTP ${status}`;
	const requestError = new Error(
		diagnosticId ? `${message} (Diagnostic ID: ${diagnosticId})` : message,
	);
	(requestError as Error & { posApiStatus?: number }).posApiStatus = status;
	if (payload.diagnostic?.stack) {
		requestError.stack = [
			requestError.stack,
			`--- POS backend stack${diagnosticId ? ` [${diagnosticId}]` : ''} ---`,
			payload.diagnostic.stack,
		].filter(Boolean).join('\n');
	}
	return { requestError, diagnosticId, diagnostic: payload.diagnostic };
}

function buildErrorContext(
	response: Response,
	payload: ApiErrorPayload,
): Record<string, string | number | boolean | null | undefined> {
	return {
		statusText: response.statusText,
		diagnosticId: payload.diagnosticId,
		backendErrorName: payload.diagnostic?.name,
		backendErrorCode: payload.diagnostic?.code,
		backendMessage: payload.diagnostic?.message,
	};
}

function readStoredToken(): string | null {
	if (typeof window === 'undefined') return null;
	return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

function buildAuthHeaders(token?: string | null): Record<string, string> {
	const normalized = (token === undefined ? readStoredToken() : token)?.trim();
	if (!normalized) {
		return {};
	}

	return { Authorization: `Bearer ${normalized}` };
}

async function getJson<T>(path: string, options?: { token?: string | null }): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${BASE}${path}`, {
			headers: buildAuthHeaders(options?.token),
		});
	} catch (error) {
		console.error(`[POS API] GET ${path} could not reach the backend`, error);
		reportClientError(error, { source: 'api.network', route: path, method: 'GET' });
		throw error;
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as ApiErrorPayload;
		const { requestError, diagnosticId } = buildResponseError(error, response.status);
		console.error(`[POS API] GET ${path} failed`, {
			status: response.status,
			statusText: response.statusText,
			message: requestError.message,
			diagnosticId,
			backendDiagnostic: error.diagnostic,
		});
		if (response.status >= 500) {
			reportClientError(requestError, {
				source: 'api.response',
				route: path,
				method: 'GET',
				status: response.status,
				context: buildErrorContext(response, error),
			});
		}
		throw requestError;
	}
	return response.json() as Promise<T>;
}

async function postJson<T>(path: string, payload: unknown, options?: { token?: string | null }): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${BASE}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...buildAuthHeaders(options?.token),
			},
			body: JSON.stringify(payload),
		});
	} catch (error) {
		console.error(`[POS API] POST ${path} could not reach the backend`, error);
		reportClientError(error, { source: 'api.network', route: path, method: 'POST' });
		throw error;
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as ApiErrorPayload;
		const { requestError, diagnosticId } = buildResponseError(error, response.status);
		console.error(`[POS API] POST ${path} failed`, {
			status: response.status,
			statusText: response.statusText,
			message: requestError.message,
			diagnosticId,
			backendDiagnostic: error.diagnostic,
		});
		if (response.status >= 500) {
			reportClientError(requestError, {
				source: 'api.response',
				route: path,
				method: 'POST',
				status: response.status,
				context: buildErrorContext(response, error),
			});
		}
		throw requestError;
	}
	return response.json() as Promise<T>;
}

async function patchJson<T>(path: string, payload: unknown, options?: { token?: string | null }): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${BASE}${path}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				...buildAuthHeaders(options?.token),
			},
			body: JSON.stringify(payload),
		});
	} catch (error) {
		console.error(`[POS API] PATCH ${path} could not reach the backend`, error);
		reportClientError(error, { source: 'api.network', route: path, method: 'PATCH' });
		throw error;
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as ApiErrorPayload;
		const { requestError, diagnosticId } = buildResponseError(error, response.status);
		console.error(`[POS API] PATCH ${path} failed`, {
			status: response.status,
			statusText: response.statusText,
			message: requestError.message,
			diagnosticId,
			backendDiagnostic: error.diagnostic,
		});
		if (response.status >= 500) {
			reportClientError(requestError, {
				source: 'api.response',
				route: path,
				method: 'PATCH',
				status: response.status,
				context: buildErrorContext(response, error),
			});
		}
		throw requestError;
	}
	return response.json() as Promise<T>;
}

export async function login(input: POSAuthLoginInput): Promise<POSAuthResult> {
	return postJson<POSAuthResult>('/auth/login', input, { token: null });
}

export async function getCurrentUser(token: string): Promise<POSUser | null> {
	return getJson<POSUser>('/auth/me', { token });
}

export async function logout(token: string): Promise<void> {
	await postJson<{ ok: true }>('/auth/logout', {}, { token });
}

export async function unlockSession(
	pin: string,
	token: string,
): Promise<{ ok: true; mode: 'normal' | 'no-cash' }> {
	return postJson('/auth/unlock', { pin }, { token });
}

export async function refreshHostSyncAuth(
	identifier: string,
	password: string,
	token: string,
): Promise<POSSyncTokenResult> {
	return postJson<POSSyncTokenResult>('/auth/sync-token', { identifier, password }, { token });
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

export async function searchProducts(query: string, terminalId?: string): Promise<Product[]> {
	const params = new URLSearchParams({ q: query });
	if (terminalId?.trim()) params.set('terminalId', terminalId.trim());
	return getJson<Product[]>(`${'/products/search'}?${params.toString()}`);
}

export interface PriceOverrideSubmission {
	code: string;
	price: number;
	tierLabel: string;
	tierPrices: Record<string, number>;
	terminalId?: string;
	cashierName?: string;
	receiptReference?: string;
}

export interface PriceOverrideResult {
	sku: { id: string; skuCode: string; name: string };
	variant: { id: string; variantCode: string } | null;
	batch: { id: string; batchNumber: string; sellingPrice: number | null; createdAt: string };
}

/**
 * Makes a "<price>-<code>" checkout shorthand price permanent by recording a
 * new batch-pricing entry upstream. Never called on the path that finishes a
 * sale - this is a separate, best-effort request the caller fires after the
 * cart line is already in, so a slow or failed request here never holds up
 * the receipt.
 */
export async function submitPriceOverride(input: PriceOverrideSubmission): Promise<PriceOverrideResult> {
	return postJson<PriceOverrideResult>('/pricing/override', input);
}

export async function openShift(input: ShiftOpenInput): Promise<ShiftSummary> {
	return postJson<ShiftSummary>('/shifts/open', input);
}

export async function closeShift(input: ShiftCloseInput & { terminalId?: string }): Promise<ShiftSummary> {
	return postJson<ShiftSummary>(`/shifts/${encodeURIComponent(input.shiftId)}/close`, input);
}

/** What the drawer is believed to hold right now, for change suggestions. */
export async function getDrawerContents(shiftId: string): Promise<DrawerContents> {
	return getJson<DrawerContents>(`/shifts/${encodeURIComponent(shiftId)}/drawer`);
}

/** Records cash moving in or out of the drawer mid-shift; returns the refreshed Z-report. */
export async function recordCashMovement(input: CashMovementInput): Promise<ZReportSummary> {
	return postJson<ZReportSummary>(`/shifts/${encodeURIComponent(input.shiftId)}/cash-movement`, input);
}

export async function endActiveShift(shiftId: string, terminalId: string): Promise<ShiftSummary> {
	return postJson<ShiftSummary>(`/shifts/${encodeURIComponent(shiftId)}/end-session`, { terminalId });
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

export async function listSales(options?: { terminalId?: string; cashierId?: string; limit?: number }): Promise<SaleSummary[]> {
	const params = new URLSearchParams();
	if (options?.terminalId) {
		params.set('terminalId', options.terminalId);
	}
	if (options?.cashierId) {
		params.set('cashierId', options.cashierId);
	}
	if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
		params.set('limit', String(options.limit));
	}
	return getJson<SaleSummary[]>(`/sales${params.size > 0 ? `?${params.toString()}` : ''}`);
}

export async function getSale(saleId: string): Promise<SaleSummary> {
	return getJson<SaleSummary>(`/sales/${encodeURIComponent(saleId)}`);
}

export async function voidSale(
	saleId: string,
	input?: { reason?: string; managerId?: string; terminalId?: string },
): Promise<SaleSummary> {
	return postJson<SaleSummary>(`/sales/${encodeURIComponent(saleId)}/void`, input ?? {});
}

export async function changeOwnPin(currentPin: string, newPin: string): Promise<void> {
	await postJson('/auth/pin', { currentPin, newPin });
}

export async function createReturn(input: ReturnInput): Promise<{ id: string; saleId: string; totalRefund: number }> {
	return postJson<{ id: string; saleId: string; totalRefund: number }>('/returns', input);
}

export async function getZReport(shiftId: string): Promise<ZReportSummary> {
	return getJson(`/shifts/${encodeURIComponent(shiftId)}/z-report`);
}

export async function listZReportSlots(options: { fromDate: string; toDate: string; terminalId?: string }): Promise<ZReportSlot[]> {
	const params = new URLSearchParams({ fromDate: options.fromDate, toDate: options.toDate });
	if (options.terminalId) params.set('terminalId', options.terminalId);
	return getJson<ZReportSlot[]>(`/z-reports?${params.toString()}`);
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

export async function syncNow(options?: { deviceId?: string; terminalId?: string }): Promise<POSSyncRunResult> {
	return postJson<POSSyncRunResult>('/local/sync/now', {
		deviceId: options?.deviceId,
		terminalId: options?.terminalId,
	});
}

export async function getCustomerAccount(customerId: string): Promise<CustomerAccountDetail> {
	return getJson<CustomerAccountDetail>(`/customers/${encodeURIComponent(customerId)}/account`);
}

export async function updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
	return patchJson<Customer>(`/customers/${encodeURIComponent(customerId)}`, input);
}

export async function recordCreditPayment(
	customerId: string,
	input: RecordCreditPaymentInput,
): Promise<void> {
	await postJson(`/customers/${encodeURIComponent(customerId)}/credit-payments`, input);
}

export function subscribeSyncStatus(_callback: (status: SyncStatusSummary) => void): () => void {
	let stopped = false;
	const refresh = async () => {
		try {
			const status = await getSyncStatus();
			if (!stopped) _callback(status);
		} catch {
			// Bootstrap and the sync page surface request errors; a background refresh
			// should not replace their user-facing state.
		}
	};
	const interval = window.setInterval(() => void refresh(), 15_000);
	return () => {
		stopped = true;
		window.clearInterval(interval);
	};
}
