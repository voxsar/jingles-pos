import { getPendingSyncOps, markSyncOpStatus, markSaleAsSynced } from './localDB';
import { SyncOperationType, SyncStatus } from '@jingles/shared';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

export async function syncPendingOperations(): Promise<{ synced: number; failed: number }> {
  const pending = getPendingSyncOps();
  let synced = 0;
  let failed = 0;

  for (const op of pending) {
    try {
      markSyncOpStatus(op.id, SyncStatus.IN_PROGRESS);
      const payload = JSON.parse(op.payload);

      switch (op.type) {
        case SyncOperationType.CREATE_SALE: {
          const res = await fetch(`${BACKEND_URL}/api/pos/sales`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Unknown' })) as { error?: string };
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const sale = await res.json() as { id: string };
          if (payload.offlineId) {
            markSaleAsSynced(payload.offlineId, sale.id);
          }
          break;
        }

        case SyncOperationType.CREATE_RETURN: {
          const res = await fetch(`${BACKEND_URL}/api/pos/returns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          break;
        }

        case SyncOperationType.OPEN_SHIFT: {
          const res = await fetch(`${BACKEND_URL}/api/pos/shifts/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          break;
        }

        case SyncOperationType.CLOSE_SHIFT: {
          const { shiftId, ...rest } = payload;
          const res = await fetch(`${BACKEND_URL}/api/pos/shifts/${shiftId}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rest),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          break;
        }

        default:
          throw new Error(`Unknown sync op type: ${op.type}`);
      }

      markSyncOpStatus(op.id, SyncStatus.SYNCED);
      synced++;
    } catch (err: any) {
      markSyncOpStatus(op.id, SyncStatus.FAILED, err.message);
      failed++;
    }
  }

  return { synced, failed };
}
