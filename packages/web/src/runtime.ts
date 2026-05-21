function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function isElectronUserAgent() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /\bElectron\/\d+/i.test(navigator.userAgent);
}

export function isDesktopRuntime() {
  return (
    typeof window !== 'undefined' &&
    (
      window.location.protocol === 'file:' ||
      typeof window.electronAPI !== 'undefined' ||
      isElectronUserAgent()
    )
  );
}

function getDesktopApiBaseUrl() {
  if (!isDesktopRuntime()) {
    return null;
  }

  const backendUrl = window.electronAPI?.app?.backendUrl?.trim();
  if (backendUrl) {
    return trimTrailingSlash(backendUrl);
  }

  return 'http://127.0.0.1:3631';
}

export function getApiBaseUrl() {
  const desktopApiBaseUrl = getDesktopApiBaseUrl();
  if (desktopApiBaseUrl) {
    return desktopApiBaseUrl;
  }

  const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configuredApiBaseUrl) {
    if (import.meta.env.DEV) {
      return '';
    }

    return trimTrailingSlash(configuredApiBaseUrl);
  }

  return '';
}

export function resolveBackendUrl(rawUrl: string, apiBaseUrl = getApiBaseUrl()) {
  if (!rawUrl) {
    return rawUrl;
  }

  const normalizedApiBaseUrl = trimTrailingSlash(apiBaseUrl);

  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  if (rawUrl.startsWith('/')) {
    return normalizedApiBaseUrl ? `${normalizedApiBaseUrl}${rawUrl}` : rawUrl;
  }

  return normalizedApiBaseUrl
    ? `${normalizedApiBaseUrl}/${rawUrl.replace(/^\/+/, '')}`
    : rawUrl;
}
