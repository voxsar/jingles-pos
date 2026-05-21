import {
  DEFAULT_DEVICE_ID,
  DEFAULT_TERMINAL_ID,
  SharedCatalogSnapshot,
  SyncPlaybackResponse,
  SyncStatusSummary,
} from '@jingles/shared';
import {
  appendRemoteEvents,
  getPendingSyncEvents,
  getSyncStatus,
  markEventsConfirmed,
  replaceCatalogSnapshot,
  recordSyncFailure,
} from './localDB';

const BACKEND_URL = (process.env.BACKEND_URL || 'https://inv.theredsun.org').replace(/\/+$/, '');

export interface SyncPlaybackResult {
  accepted: number;
  remoteApplied: number;
  conflicts: number;
  status: SyncStatusSummary;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BACKEND_URL}${path}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function refreshCatalogSnapshot(): Promise<SharedCatalogSnapshot> {
  const snapshot = await getJson<SharedCatalogSnapshot>('/api/pos/catalog/snapshot');
  replaceCatalogSnapshot(snapshot);
  return snapshot;
}

export async function syncPlaybackLog(options?: {
  deviceId?: string;
  terminalId?: string;
}): Promise<SyncPlaybackResult> {
  const deviceId = options?.deviceId ?? DEFAULT_DEVICE_ID;
  const terminalId = options?.terminalId ?? DEFAULT_TERMINAL_ID;
  const currentStatus = getSyncStatus(deviceId, terminalId);

  try {
    await postJson('/api/pos/sync/handshake', {
      deviceId,
      terminalId,
      vectorClock: currentStatus.localVectorClock,
    });

    const pendingEvents = getPendingSyncEvents();
    const playback = await postJson<SyncPlaybackResponse>('/api/pos/sync/playback', {
      deviceId,
      terminalId,
      vectorClock: currentStatus.localVectorClock,
      events: pendingEvents,
    });

    markEventsConfirmed(playback.acceptedEventIds, playback.serverVectorClock, deviceId, terminalId);
    const remoteConflicts = appendRemoteEvents(playback.remoteEvents, terminalId);

    const updatedStatus = getSyncStatus(deviceId, terminalId);
    await postJson('/api/pos/sync/confirm', {
      deviceId,
      terminalId,
      vectorClock: updatedStatus.localVectorClock,
    });

    try {
      await refreshCatalogSnapshot();
    } catch (catalogError: any) {
      recordSyncFailure(`Catalog refresh failed: ${catalogError.message}`, deviceId, terminalId);
    }

    return {
      accepted: playback.acceptedEventIds.length,
      remoteApplied: playback.remoteEvents.length,
      conflicts: playback.conflicts.length + remoteConflicts.length,
      status: getSyncStatus(deviceId, terminalId),
    };
  } catch (error: any) {
    recordSyncFailure(error.message, deviceId, terminalId);
    return {
      accepted: 0,
      remoteApplied: 0,
      conflicts: 0,
      status: getSyncStatus(deviceId, terminalId),
    };
  }
}
