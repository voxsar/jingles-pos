import path from 'path';
import { BrowserWindow, screen, type Display } from 'electron';
import {
  parseCustomerDisplayState,
  type POSCustomerDisplayState,
  type POSCustomerDisplayStatus,
} from '@jingles/shared';
import { resolveRendererTarget } from './rendererTarget';

/** Route the renderer serves the customer-facing screen on (HashRouter). */
const CUSTOMER_DISPLAY_ROUTE = '/customer-display';

let displayWindow: BrowserWindow | null = null;
/**
 * The last snapshot the workstation pushed. Held in the main process so a
 * display window opened — or reopened — part-way through a sale renders the
 * current bill immediately instead of an empty screen.
 */
let lastState: POSCustomerDisplayState | null = null;

type CustomerDisplayHost = {
  /** The workstation window, told whenever the display opens or closes. */
  getMainWindow: () => BrowserWindow | null;
  onError?: (message: string, error: unknown) => void;
};

let host: CustomerDisplayHost = { getMainWindow: () => null };

export function configureCustomerDisplay(nextHost: CustomerDisplayHost) {
  host = nextHost;
}

function reportError(message: string, error: unknown) {
  host.onError?.(message, error);
}

/**
 * The monitor the customer should be looking at: the first one that is not
 * showing the workstation. With a single monitor there is none, and the caller
 * falls back to a plain window the cashier can move themselves.
 */
function pickCustomerDisplayScreen(): Display | null {
  const displays = screen.getAllDisplays();
  if (displays.length < 2) {
    return null;
  }

  const mainWindow = host.getMainWindow();
  const workstationDisplay = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();

  return displays.find((display) => display.id !== workstationDisplay.id) ?? null;
}

export function getCustomerDisplayStatus(): POSCustomerDisplayStatus {
  return {
    supported: true,
    open: displayWindow != null && !displayWindow.isDestroyed(),
    displayCount: screen.getAllDisplays().length,
  };
}

function notifyStatus() {
  const mainWindow = host.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('customer-display:status', getCustomerDisplayStatus());
  }
}

function sendState(target: BrowserWindow, state: POSCustomerDisplayState) {
  if (target.isDestroyed()) {
    return;
  }

  target.webContents.send('customer-display:state', state);
}

export function getCachedCustomerDisplayState(): POSCustomerDisplayState | null {
  return lastState;
}

/**
 * Caches a snapshot and forwards it to the display window when one is open.
 * Publishing with no window open is deliberately not an error: the workstation
 * keeps the cache warm so the next open picks the sale up mid-flight.
 */
export function publishCustomerDisplayState(state: unknown) {
  const parsed = parseCustomerDisplayState(state);
  if (parsed == null) {
    return;
  }

  lastState = parsed;
  if (displayWindow && !displayWindow.isDestroyed()) {
    sendState(displayWindow, parsed);
  }
}

export async function openCustomerDisplayWindow(): Promise<POSCustomerDisplayStatus> {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.show();
    displayWindow.focus();
    return getCustomerDisplayStatus();
  }

  const customerScreen = pickCustomerDisplayScreen();
  const bounds = customerScreen?.bounds;

  displayWindow = new BrowserWindow({
    // On a second monitor the window fills that screen; with only one monitor it
    // opens as an ordinary window so it can be dragged onto a display later.
    ...(bounds
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : { width: 1024, height: 720 }),
    fullscreen: bounds != null,
    frame: bounds == null,
    title: 'Jingles POS - Customer display',
    backgroundColor: '#0f1512',
    autoHideMenuBar: true,
    // The customer screen is a view, never an input surface.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  displayWindow.setMenuBarVisibility(false);

  // The customer screen only ever renders its own route. Nothing on the page
  // navigates, so anything that tries is not something a customer should reach.
  displayWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.includes(`#${CUSTOMER_DISPLAY_ROUTE}`)) {
      event.preventDefault();
    }
  });
  displayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  displayWindow.on('closed', () => {
    displayWindow = null;
    notifyStatus();
  });

  // The renderer asks for the cached snapshot itself once it mounts, but pushing
  // on load covers a window that opens while the workstation sits idle.
  displayWindow.webContents.on('did-finish-load', () => {
    if (displayWindow && lastState) {
      sendState(displayWindow, lastState);
    }
  });

  const rendererTarget = resolveRendererTarget();
  try {
    if (rendererTarget.type === 'url') {
      await displayWindow.loadURL(`${rendererTarget.value}#${CUSTOMER_DISPLAY_ROUTE}`);
    } else {
      await displayWindow.loadFile(rendererTarget.value, { hash: CUSTOMER_DISPLAY_ROUTE });
    }
  } catch (error) {
    reportError('Failed to load the customer display window.', error);
    closeCustomerDisplayWindow();
    throw error;
  }

  notifyStatus();
  return getCustomerDisplayStatus();
}

export function closeCustomerDisplayWindow(): POSCustomerDisplayStatus {
  const target = displayWindow;
  displayWindow = null;

  if (target && !target.isDestroyed()) {
    target.destroy();
  }

  notifyStatus();
  return getCustomerDisplayStatus();
}

export async function toggleCustomerDisplayWindow(): Promise<POSCustomerDisplayStatus> {
  if (displayWindow && !displayWindow.isDestroyed()) {
    return closeCustomerDisplayWindow();
  }

  return openCustomerDisplayWindow();
}
