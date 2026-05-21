import { useCallback, useEffect, useState } from 'react';
import type { POSSyncDashboard } from '@jingles/shared';
import { useNavigate } from 'react-router-dom';
import { getSyncDashboard, refreshHostSyncAuth, subscribeSyncStatus, syncNow } from '../api';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatInteger } from '../utils/pos';

const REFRESH_INTERVAL_MS = 15000;

function readClockEntries(clock?: Record<string, number>) {
  return Object.entries(clock ?? {}) as Array<[string, number]>;
}

export default function SyncPage() {
  const navigate = useNavigate();
  const { logout, token, user } = useAuth();
  const [dashboard, setDashboard] = useState<POSSyncDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRefreshingSyncAuth, setIsRefreshingSyncAuth] = useState(false);
  const [syncPassword, setSyncPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoading(true);
    }

    try {
      const nextDashboard = await getSyncDashboard();
      setDashboard(nextDashboard);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load sync dashboard');
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadDashboard();

    const unsubscribe = subscribeSyncStatus(() => {
      void loadDashboard({ silent: true });
    });

    const interval = window.setInterval(() => {
      void loadDashboard({ silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [loadDashboard]);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    try {
      await syncNow();
      await loadDashboard({ silent: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  }, [loadDashboard]);

  const handleRefreshSyncAuth = useCallback(async () => {
    if (!token) {
      setError('Sign in again before reconnecting host sync.');
      return;
    }

    if (!syncPassword.trim()) {
      setError('Enter the host password to reconnect sync.');
      return;
    }

    setIsRefreshingSyncAuth(true);
    try {
      await refreshHostSyncAuth(syncPassword, token);
      setSyncPassword('');
      setError(null);
      await loadDashboard({ silent: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to refresh host sync authentication');
    } finally {
      setIsRefreshingSyncAuth(false);
    }
  }, [loadDashboard, syncPassword, token]);

  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  const status = dashboard?.status ?? null;
  const localClockEntries = readClockEntries(status?.localVectorClock);
  const remoteClockEntries = readClockEntries(status?.remoteVectorClock);
  const syncIdentity = status?.syncAuthIdentity ?? user?.email ?? null;
  const shouldShowSyncAuthCard = Boolean(status?.needsSyncAuth || status?.syncAuthConfigured || user?.email);

  return (
    <div className="screen-fill workstation-app sync-page">
      <div className="bg-layer bg-layer-gradient" />
      <div className="bg-layer bg-layer-grid" />

      <header className="glass-bar workstation-header sync-header">
        <div className="header-left">
          <div className="brand-mark small">JP</div>
          <div>
            <div className="header-title">POS Sync Center</div>
            <div className="header-subtitle">{user?.name ?? 'Workstation user'} · local-first playback log</div>
          </div>
        </div>

        <div className="header-right">
          <button className="ghost-button" onClick={() => navigate('/')}>
            Back to POS
          </button>
          <button className="ghost-button" onClick={() => void loadDashboard()}>
            Refresh
          </button>
          <button className="btn-primary" disabled={isSyncing} onClick={() => void handleSyncNow()}>
            {isSyncing ? 'Syncing...' : 'Sync now'}
          </button>
          <button className="ghost-button danger" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <div className="toast-banner error">
          {error}
        </div>
      )}

      {isLoading && dashboard == null ? (
        <div className="state-card glass-panel">
          <div className="state-title">Loading sync dashboard...</div>
        </div>
      ) : (
        <div className="sync-grid">
          <section className="glass-panel sync-card">
            <div className="sync-card-title">Current status</div>
            <div className="sync-stat-grid">
              <SyncStat label="Connection" value={status?.online ? 'Online' : 'Offline'} />
              <SyncStat label="Pending" value={formatInteger(status?.pendingEvents ?? 0)} />
              <SyncStat label="Conflicts" value={formatInteger(status?.conflictCount ?? 0)} />
              <SyncStat label="Last sync" value={formatDateTime(status?.lastSyncAt)} />
              <SyncStat label="Device" value={status?.deviceId ?? 'Unknown'} mono />
              <SyncStat label="Last error" value={status?.lastError ?? 'None'} />
            </div>
          </section>

          {shouldShowSyncAuthCard && (
            <section className="glass-panel sync-card">
              <div className="sync-card-title">Host sync authentication</div>
              <div className="sync-auth-copy">
                {status?.syncAuthConfigured
                  ? `Host sync is currently authenticated${syncIdentity ? ` as ${syncIdentity}` : ''}.`
                  : `Host sync needs an inventory backend token${syncIdentity ? ` for ${syncIdentity}` : ''}.`}
              </div>
              <label className="label-block" htmlFor="sync-host-password">
                Host password
              </label>
              <input
                id="sync-host-password"
                autoComplete="current-password"
                className="glass-input"
                onChange={(event) => setSyncPassword(event.target.value)}
                placeholder="Enter inventory password"
                type="password"
                value={syncPassword}
              />
              <div className="sync-auth-actions">
                <button
                  className="btn-primary"
                  disabled={isRefreshingSyncAuth || !user?.email}
                  onClick={() => void handleRefreshSyncAuth()}
                >
                  {isRefreshingSyncAuth ? 'Reconnecting...' : 'Reconnect host sync'}
                </button>
              </div>
            </section>
          )}

          <section className="glass-panel sync-card">
            <div className="sync-card-title">Vector clocks</div>
            <div className="sync-clock-grid">
              <ClockPanel
                title={`Local (${formatInteger(localClockEntries.length)})`}
                rows={localClockEntries}
              />
              <ClockPanel
                title={`Remote (${formatInteger(remoteClockEntries.length)})`}
                rows={remoteClockEntries}
              />
            </div>
          </section>

          <section className="glass-panel sync-card">
            <div className="sync-card-title">Pending outbox</div>
            <SyncEventList
              emptyCopy="No pending local events. This workstation is caught up."
              events={dashboard?.pendingEvents ?? []}
            />
          </section>

          <section className="glass-panel sync-card">
            <div className="sync-card-title">Recent sync activity</div>
            <SyncEventList
              emptyCopy="No sync activity has been recorded yet."
              events={dashboard?.recentEvents ?? []}
            />
          </section>

          <section className="glass-panel sync-card sync-card-wide">
            <div className="sync-card-title">Conflicts</div>
            {(dashboard?.conflicts.length ?? 0) === 0 ? (
              <div className="empty-state compact">
                <div className="empty-title">No open conflicts</div>
                <div className="empty-copy">Incoming server events are applying cleanly.</div>
              </div>
            ) : (
              <div className="sync-list">
                {dashboard?.conflicts.map((conflict) => (
                  <div key={conflict.id} className="sync-row">
                    <div className="sync-row-main">
                      <div className="sync-row-title">
                        {conflict.aggregateType} · {conflict.aggregateId}
                      </div>
                      <div className="sync-row-meta">
                        Policy {conflict.policy} · {conflict.status} · {formatDateTime(conflict.createdAt)}
                      </div>
                    </div>
                    <div className="sync-row-side mono">
                      {conflict.localEventId ?? 'local?'} / {conflict.remoteEventId ?? 'remote?'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function SyncStat(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="sync-stat">
      <span>{props.label}</span>
      <b className={props.mono ? 'mono' : ''}>{props.value}</b>
    </div>
  );
}

function ClockPanel(props: { title: string; rows: Array<[string, number]> }) {
  return (
    <div className="sync-clock-panel">
      <div className="sync-clock-title">{props.title}</div>
      {props.rows.length === 0 ? (
        <div className="sync-clock-empty">No entries yet.</div>
      ) : (
        <div className="sync-list">
          {props.rows.map(([deviceId, sequence]) => (
            <div key={deviceId} className="sync-row">
              <div className="sync-row-main mono">{deviceId}</div>
              <div className="sync-row-side mono">{sequence}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncEventList(props: { events: POSSyncDashboard['recentEvents']; emptyCopy: string }) {
  if (props.events.length === 0) {
    return (
      <div className="empty-state compact">
        <div className="empty-title">Nothing queued</div>
        <div className="empty-copy">{props.emptyCopy}</div>
      </div>
    );
  }

  return (
    <div className="sync-list">
      {props.events.map((event) => (
        <div key={event.id} className="sync-row">
          <div className="sync-row-main">
            <div className="sync-row-title">
              {event.eventType} · {event.aggregateType}
            </div>
            <div className="sync-row-meta">
              {event.aggregateId} · {event.state} · {formatDateTime(event.createdAt)}
            </div>
          </div>
          <div className="sync-row-side mono">
            {event.deviceId} #{event.sequenceNum}
          </div>
        </div>
      ))}
    </div>
  );
}
