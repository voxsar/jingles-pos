import { DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID } from '@jingles/shared';

function normalizeBoolean(value: string | undefined) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

export function isLocalPosBackendMode() {
  return normalizeBoolean(process.env.JINGLES_POS_LOCAL_MODE);
}

export function getLocalPosDeviceId() {
  return process.env.JINGLES_POS_DEVICE_ID?.trim() || DEFAULT_DEVICE_ID;
}

export function getLocalPosTerminalId() {
  return process.env.JINGLES_POS_TERMINAL_ID?.trim() || DEFAULT_TERMINAL_ID;
}

export function getPosUpstreamUrl() {
  const configured =
    process.env.JINGLES_POS_UPSTREAM_URL?.trim() ||
    process.env.BACKEND_URL?.trim() ||
    'https://inv.theredsun.org';

  return trimTrailingSlash(configured);
}
