import { contextBridge, ipcRenderer } from 'electron';

const FALLBACK_DESKTOP_LOCAL_API_URL = 'http://127.0.0.1:3631';

function readDesktopLocalApiUrl() {
  try {
    const resolvedUrl = ipcRenderer.sendSync('app:backend-url-sync');
    return typeof resolvedUrl === 'string' && resolvedUrl.trim()
      ? resolvedUrl.trim()
      : FALLBACK_DESKTOP_LOCAL_API_URL;
  } catch (error) {
    console.error('[Electron preload] Failed to resolve the desktop backend URL.', error);
    return FALLBACK_DESKTOP_LOCAL_API_URL;
  }
}

const DESKTOP_LOCAL_API_URL = readDesktopLocalApiUrl();

contextBridge.exposeInMainWorld('electronAPI', {
  app: {
    backendUrl: DESKTOP_LOCAL_API_URL,
  },
});

declare global {
  interface Window {
    electronAPI?: {
      app?: {
        backendUrl?: string;
      };
    };
  }
}
