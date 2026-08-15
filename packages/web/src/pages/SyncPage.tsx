import { useCallback, useEffect, useState } from 'react';
import type { POSSyncDashboard } from '@jingles/shared';
import { useNavigate } from 'react-router-dom';
import { getSyncDashboard, refreshHostSyncAuth, subscribeSyncStatus, syncNow } from '../api';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatInteger } from '../utils/pos';
import { reportCaughtClientError } from '../clientErrorReporter';

const REFRESH_INTERVAL_MS = 2000;

function readClockEntries(clock?: Record<string, number>) {
  return Object.entries(clock ?? {}) as Array<[string, number]>;
}

function getSyncRunError(result: Awaited<ReturnType<typeof syncNow>>): string | null {
  if (result.status.needsSyncAuth) {
    return 'Host sync authentication is required. Reconnect host sync for this workstation.';
  }

  if (result.status.lastError) {
    return result.status.lastError;
  }

  if (!result.status.online && result.status.pendingEvents > 0) {
    return 'Sync did not finish. Pending local events are still queued.';
  }

  return null;
}

function looksLikeLocalPlaceholderIdentity(value: string | null | undefined) {
  return typeof value === 'string' && value.trim().toLowerCase().endsWith('@jingles.local');
}

export default function SyncPage() {
  const navigate = useNavigate();
  const { logout, token, user } = useAuth();
  const [dashboard, setDashboard] = useState<POSSyncDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRefreshingSyncAuth, setIsRefreshingSyncAuth] = useState(false);
  const [syncIdentity, setSyncIdentity] = useState('');
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
      reportCaughtClientError(nextError, 'sync.dashboard.load');
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

  useEffect(() => {
    const nextIdentity = dashboard?.status?.syncAuthIdentity?.trim();
    if (!syncIdentity.trim() && nextIdentity) {
      setSyncIdentity(nextIdentity);
    }
  }, [dashboard?.status?.syncAuthIdentity, syncIdentity]);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    try {
      const result = await syncNow();
      setError(getSyncRunError(result));
      await loadDashboard({ silent: true });
    } catch (nextError) {
      reportCaughtClientError(nextError, 'sync.run');
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

    if (!syncIdentity.trim()) {
      setError('Enter the workstation host account before reconnecting sync.');
      return;
    }

    if (!syncPassword.trim()) {
      setError('Enter the host password to reconnect sync.');
      return;
    }

    setIsRefreshingSyncAuth(true);
    try {
      await refreshHostSyncAuth(syncIdentity, syncPassword, token);
      setSyncPassword('');
      setError(null);
      await loadDashboard({ silent: true });
    } catch (nextError) {
      reportCaughtClientError(nextError, 'sync.authentication.refresh');
      setError(nextError instanceof Error ? nextError.message : 'Failed to refresh host sync authentication');
    } finally {
      setIsRefreshingSyncAuth(false);
    }
  }, [loadDashboard, syncIdentity, syncPassword, token]);

  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  const status = dashboard?.status ?? null;
  const localClockEntries = readClockEntries(status?.localVectorClock);
  const remoteClockEntries = readClockEntries(status?.remoteVectorClock);
  const savedSyncIdentity = status?.syncAuthIdentity ?? null;
  const activeSyncIdentity = syncIdentity.trim() || savedSyncIdentity;
  const usesAppToken = status?.syncAuthMode === 'app_token';
  const hasLocalOnlySyncIdentity = !usesAppToken && looksLikeLocalPlaceholderIdentity(activeSyncIdentity);
  const shouldShowSyncAuthCard = Boolean(status?.needsSyncAuth || status?.syncAuthConfigured || savedSyncIdentity);
  const bannerMessage = error ?? (
    status?.needsSyncAuth
      ? 'Host sync authentication is required. Reconnect host sync for this workstation.'
      : null
  );
  const progress = status?.progress;
  const primarySyncRunning = Boolean(
    progress?.running && progress.phase !== 'history',
  );
  const connectionLabel = status?.online
    ? status.connectionMode === 'lan'
      ? 'Online via LAN'
      : 'Online via cloud'
    : 'Offline';

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
          <button className="btn-primary" disabled={isSyncing || primarySyncRunning} onClick={() => void handleSyncNow()}>
            {isSyncing || primarySyncRunning ? progress?.label ?? 'Syncing...' : 'Sync now'}
          </button>
          <button className="ghost-button danger" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </header>

      {bannerMessage && (
        <div className="toast-banner error">
          {bannerMessage}
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
              <SyncStat label="Connection" value={connectionLabel} />
              <SyncStat label="Route" value={status?.connectionName ?? status?.activeEndpoint ?? 'No active route'} />
              <SyncStat label="Pending" value={formatInteger(status?.pendingEvents ?? 0)} />
              <SyncStat label="Conflicts" value={formatInteger(status?.conflictCount ?? 0)} />
              <SyncStat label="Last sync" value={formatDateTime(status?.lastSyncAt)} />
              <SyncStat label="Last attempt" value={formatDateTime(status?.lastAttemptAt)} />
              <SyncStat label="Device" value={status?.deviceId ?? 'Unknown'} mono />
              <SyncStat label="Last error" value={status?.lastError ?? 'None'} />
            </div>
          </section>

          <section className="glass-panel sync-card sync-card-wide">
            <div className="sync-card-title">Sync progress</div>
            <div className="sync-progress-heading">
              <div>
                <b>{progress?.label ?? 'Waiting for the next sync run'}</b>
                <span>{progress?.detail ?? 'The POS will sync automatically when an endpoint is available.'}</span>
              </div>
              <strong>{formatInteger(progress?.percent ?? 0)}%</strong>
            </div>
            <div className="sync-progress-track" aria-label="Sync progress">
              <div className="sync-progress-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <div className="sync-progress-metrics">
              <span>Phase: {progress?.phase ?? 'idle'}</span>
              <span>Accepted: {formatInteger(progress?.accepted ?? 0)}</span>
              <span>Remote applied: {formatInteger(progress?.remoteApplied ?? 0)}</span>
              {typeof progress?.historyTotal === 'number' && (
                <span>
                  History: {formatInteger(progress.historyImported ?? 0)} / {formatInteger(progress.historyTotal)}
                </span>
              )}
              <span>Updated: {formatDateTime(progress?.updatedAt)}</span>
            </div>
          </section>

          {shouldShowSyncAuthCard && (
            <section className="glass-panel sync-card">
              <div className="sync-card-title">Sync authentication</div>
              <div className="sync-auth-copy">
                {usesAppToken
                  ? 'This workstation sync uses the configured POS app token. Cashier sign-in is not used for upstream sync.'
                  : status?.syncAuthConfigured
                  ? `Workstation sync is currently authenticated${savedSyncIdentity ? ` as ${savedSyncIdentity}` : ''}.`
                  : savedSyncIdentity
                    ? `This workstation will reconnect host sync as ${savedSyncIdentity}.`
                    : 'This workstation needs a host sync account before it can push or pull.'}
              </div>
              {usesAppToken && (
                <div className="sync-auth-copy">
                  Set the same `JINGLES_POS_SYNC_APP_TOKEN` on this desktop app and the hosted inventory backend.
                </div>
              )}
              {hasLocalOnlySyncIdentity && (
                <div className="sync-auth-copy">
                  The local `.local` cashier address will not work upstream. Enter the real inventory email for workstation sync.
                </div>
              )}
              {!usesAppToken && (
                <>
                  <label className="label-block" htmlFor="sync-host-identity">
                    Host account
                  </label>
                  <input
                    id="sync-host-identity"
                    autoComplete="username"
                    className="glass-input"
                    onChange={(event) => setSyncIdentity(event.target.value)}
                    placeholder="Enter real inventory email for workstation sync"
                    value={syncIdentity}
                  />
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
                      disabled={isRefreshingSyncAuth}
                      onClick={() => void handleRefreshSyncAuth()}
                    >
                      {isRefreshingSyncAuth ? 'Reconnecting...' : 'Reconnect host sync'}
                    </button>
                  </div>
                </>
              )}
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
