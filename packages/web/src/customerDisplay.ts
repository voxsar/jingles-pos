import {
  DEFAULT_POS_CUSTOMER_DISPLAY,
  normalizeCustomerDisplaySettings,
  parseCustomerDisplayState,
  type POSCustomerDisplaySettings,
  type POSCustomerDisplayState,
  type POSCustomerDisplayStatus,
} from '@jingles/shared';

/** HashRouter path the customer-facing screen is served on. */
export const CUSTOMER_DISPLAY_ROUTE = '/customer-display';

/**
 * Browser transport. The desktop app forwards snapshots over IPC, but a browser
 * install has no main process to route through, so the workstation writes the
 * snapshot to shared storage and the popup reads it back:
 *
 * - `localStorage` is the durable copy. A display window opened mid-sale reads
 *   the current bill straight out of it, and `storage` events deliver every
 *   later change to the other window.
 * - `BroadcastChannel` carries the same snapshot for immediacy and for browsers
 *   that throttle storage events in background windows. Either path alone is
 *   enough; both together simply make the display feel instant.
 */
const STATE_STORAGE_KEY = 'jingles-pos-customer-display-state';
const SETTINGS_STORAGE_KEY = 'jingles-pos-customer-display-settings';
const BROADCAST_CHANNEL_NAME = 'jingles-pos-customer-display';
/** How often the workstation re-checks whether the popup was closed by hand. */
const POPUP_POLL_INTERVAL_MS = 1000;

let popupWindow: Window | null = null;

export function hasCustomerDisplayBridge() {
  return typeof window !== 'undefined' && typeof window.electronAPI?.customerDisplay !== 'undefined';
}

function getBridge() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.customerDisplay;
}

function openBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined') {
    return null;
  }

  try {
    return new window.BroadcastChannel(BROADCAST_CHANNEL_NAME);
  } catch {
    return null;
  }
}

/** Settings the browser build keeps locally, since it has no settings file. */
export function readStoredCustomerDisplaySettings(): POSCustomerDisplaySettings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_POS_CUSTOMER_DISPLAY };
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    return normalizeCustomerDisplaySettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_POS_CUSTOMER_DISPLAY };
  }
}

export function persistCustomerDisplaySettings(settings: POSCustomerDisplaySettings) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizeCustomerDisplaySettings(settings)));
  } catch {
    // Storage can be full or blocked; the settings still apply for this session.
  }
}

export function publishCustomerDisplayState(state: POSCustomerDisplayState) {
  const bridge = getBridge();
  if (bridge) {
    bridge.publish(state);
    return;
  }

  if (typeof window === 'undefined') {
    return;
  }

  const payload = JSON.stringify(state);

  try {
    window.localStorage.setItem(STATE_STORAGE_KEY, payload);
  } catch {
    // Fall through to the broadcast; a display already open still updates.
  }

  const channel = openBroadcastChannel();
  if (channel) {
    try {
      channel.postMessage(payload);
    } finally {
      channel.close();
    }
  }
}

function readStoredState(): POSCustomerDisplayState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STATE_STORAGE_KEY);
    return raw ? parseCustomerDisplayState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Subscribes the display window to workstation snapshots. Calls back once with
 * whatever the current snapshot is — cached in the main process on desktop, or
 * held in storage in a browser — so the screen is never blank while it waits
 * for the cashier's next keystroke.
 */
export function subscribeCustomerDisplayState(
  onState: (state: POSCustomerDisplayState) => void,
): () => void {
  const bridge = getBridge();
  if (bridge) {
    const unsubscribe = bridge.onState((state) => {
      const parsed = parseCustomerDisplayState(state);
      if (parsed) {
        onState(parsed);
      }
    });

    void bridge.getState()
      .then((state) => {
        const parsed = parseCustomerDisplayState(state);
        if (parsed) {
          onState(parsed);
        }
      })
      .catch(() => {
        // No cached snapshot yet; the next publish delivers one.
      });

    return unsubscribe;
  }

  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STATE_STORAGE_KEY || !event.newValue) {
      return;
    }

    try {
      const parsed = parseCustomerDisplayState(JSON.parse(event.newValue));
      if (parsed) {
        onState(parsed);
      }
    } catch {
      // Ignore an unparseable write rather than clearing the screen.
    }
  };

  const channel = openBroadcastChannel();
  const handleMessage = (event: MessageEvent) => {
    try {
      const raw = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      const parsed = parseCustomerDisplayState(raw);
      if (parsed) {
        onState(parsed);
      }
    } catch {
      // Same as above: a bad message is dropped, not rendered.
    }
  };

  window.addEventListener('storage', handleStorage);
  channel?.addEventListener('message', handleMessage);

  const initial = readStoredState();
  if (initial) {
    onState(initial);
  }

  return () => {
    window.removeEventListener('storage', handleStorage);
    channel?.removeEventListener('message', handleMessage);
    channel?.close();
  };
}

function getBrowserStatus(): POSCustomerDisplayStatus {
  return {
    supported: false,
    open: popupWindow != null && !popupWindow.closed,
    // `isExtended` is the only monitor hint a browser gives, and not everywhere.
    displayCount: typeof window !== 'undefined' && window.screen && 'isExtended' in window.screen
      ? ((window.screen as Screen & { isExtended?: boolean }).isExtended ? 2 : 1)
      : 0,
  };
}

export async function getCustomerDisplayStatus(): Promise<POSCustomerDisplayStatus> {
  const bridge = getBridge();
  if (bridge) {
    return bridge.getStatus();
  }

  return getBrowserStatus();
}

function buildPopupUrl() {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#${CUSTOMER_DISPLAY_ROUTE}`;
}

export async function openCustomerDisplay(): Promise<POSCustomerDisplayStatus> {
  const bridge = getBridge();
  if (bridge) {
    return bridge.open();
  }

  if (popupWindow && !popupWindow.closed) {
    popupWindow.focus();
    return getBrowserStatus();
  }

  popupWindow = window.open(
    buildPopupUrl(),
    'jingles-customer-display',
    'popup=yes,width=1024,height=720',
  );

  if (popupWindow == null) {
    throw new Error('The browser blocked the customer display window. Allow pop-ups for this site and try again.');
  }

  return getBrowserStatus();
}

export async function closeCustomerDisplay(): Promise<POSCustomerDisplayStatus> {
  const bridge = getBridge();
  if (bridge) {
    return bridge.close();
  }

  if (popupWindow && !popupWindow.closed) {
    popupWindow.close();
  }
  popupWindow = null;

  return getBrowserStatus();
}

/**
 * Reports whether a display is currently up. Desktop pushes status changes; a
 * browser popup gives no close event, so it is polled instead.
 */
export function subscribeCustomerDisplayStatus(
  onStatus: (status: POSCustomerDisplayStatus) => void,
): () => void {
  const bridge = getBridge();
  if (bridge) {
    const unsubscribe = bridge.onStatus(onStatus);
    void bridge.getStatus().then(onStatus).catch(() => {
      // Status stays at whatever the caller started with.
    });
    return unsubscribe;
  }

  if (typeof window === 'undefined') {
    return () => {};
  }

  let lastOpen: boolean | null = null;
  const poll = () => {
    const status = getBrowserStatus();
    if (status.open !== lastOpen) {
      lastOpen = status.open;
      onStatus(status);
    }
  };

  poll();
  const timer = window.setInterval(poll, POPUP_POLL_INTERVAL_MS);
  return () => window.clearInterval(timer);
}
