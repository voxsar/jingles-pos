import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { unlockSession } from '../api';
import { useAuth } from '../auth/AuthContext';
import { readStoredSessionLockMinutes } from '../desktopSettings';

const CASH_VISIBILITY_STORAGE_KEY = 'jingles-pos-hide-cash-sales';
const LAST_ACTIVITY_STORAGE_KEY = 'jingles-pos-last-activity-at';
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousedown',
  'mousemove',
  'keydown',
  'scroll',
  'touchstart',
];

export default function SessionLock() {
  const { logout, token, user } = useAuth();
  const [isLocked, setIsLocked] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [canLock, setCanLock] = useState(Boolean(user?.hasPin));
  const timerRef = useRef<number | null>(null);
  const lockedRef = useRef(false);
  const lastActivityWriteRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const armTimer = useCallback((delay = readStoredSessionLockMinutes() * 60_000) => {
    clearTimer();
    if (!canLock || lockedRef.current) return;
    timerRef.current = window.setTimeout(() => {
      lockedRef.current = true;
      setPin('');
      setError('');
      setIsLocked(true);
    }, Math.max(0, delay));
  }, [canLock, clearTimer]);

  useEffect(() => {
    setCanLock(Boolean(user?.hasPin));
  }, [user?.hasPin, user?.id]);

  useEffect(() => {
    const handleManualLock = () => {
      if (!canLock) return;
      lockedRef.current = true;
      setPin('');
      setError('');
      setIsLocked(true);
    };
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== 'l') return;
      event.preventDefault();
      handleManualLock();
    };
    const handleSettings = () => armTimer();
    const handlePinConfigured = () => setCanLock(true);
    window.addEventListener('jingles:lock-now', handleManualLock);
    window.addEventListener('keydown', handleShortcut, true);
    window.addEventListener('jingles:session-lock-settings', handleSettings);
    window.addEventListener('jingles:pin-configured', handlePinConfigured);
    return () => {
      window.removeEventListener('jingles:lock-now', handleManualLock);
      window.removeEventListener('keydown', handleShortcut, true);
      window.removeEventListener('jingles:session-lock-settings', handleSettings);
      window.removeEventListener('jingles:pin-configured', handlePinConfigured);
    };
  }, [armTimer, canLock]);

  useEffect(() => {
    const timeoutMs = readStoredSessionLockMinutes() * 60_000;
    const lastActivityAt = Number(window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY));
    const remaining = lastActivityAt
      ? timeoutMs - (Date.now() - lastActivityAt)
      : 0;
    lockedRef.current = Boolean(canLock && remaining <= 0);
    setIsLocked(lockedRef.current);
    if (!lockedRef.current) armTimer(remaining || timeoutMs);
    const handleActivity = () => {
      if (!lockedRef.current) {
        const now = Date.now();
        if (now - lastActivityWriteRef.current >= 1000) {
          window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
          lastActivityWriteRef.current = now;
        }
        armTimer();
      }
    };
    ACTIVITY_EVENTS.forEach((eventName) => window.addEventListener(eventName, handleActivity, { passive: true }));
    return () => {
      clearTimer();
      ACTIVITY_EVENTS.forEach((eventName) => window.removeEventListener(eventName, handleActivity));
    };
  }, [armTimer, canLock, clearTimer, user?.id]);

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !/^\d{4,6}$/.test(pin)) {
      setError('Enter your 4 to 6 digit PIN.');
      return;
    }

    setIsUnlocking(true);
    setError('');
    try {
      const result = await unlockSession(pin, token);
      window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
      const hideCashSales = result.mode === 'no-cash';
      window.sessionStorage.setItem(CASH_VISIBILITY_STORAGE_KEY, String(hideCashSales));
      window.dispatchEvent(new CustomEvent('jingles:cash-visibility', {
        detail: { hidden: hideCashSales },
      }));
      lockedRef.current = false;
      setIsLocked(false);
      setPin('');
      armTimer();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to unlock.');
    } finally {
      setIsUnlocking(false);
    }
  }

  if (!isLocked) return null;

  return (
    <div className="modal-overlay session-lock-overlay">
      <div className="modal-shell narrow glass-panel session-lock-card">
        <div className="session-lock-icon">🔒</div>
        <h2>Workstation locked</h2>
        <p className="modal-copy">{user?.name} · {user?.code}</p>
        <p className="state-copy">Enter your PIN to continue.</p>
        <form className="auth-form-stack" onSubmit={handleUnlock}>
          <input
            autoFocus
            aria-label="Unlock PIN"
            className="glass-input session-lock-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            minLength={4}
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          {error && <div className="inline-alert error">{error}</div>}
          <button className="btn-primary login-submit" disabled={isUnlocking || pin.length < 4} type="submit">
            {isUnlocking ? 'Unlocking…' : 'Unlock'}
          </button>
          <button className="ghost-button" type="button" onClick={() => void logout()}>
            Sign in as another user
          </button>
        </form>
      </div>
    </div>
  );
}
