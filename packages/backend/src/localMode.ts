import fs from 'fs';
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

export type PosUpstreamCandidate = {
  url: string;
  mode: 'lan' | 'cloud';
  name?: string;
};

export function getPosUpstreamCandidates(options?: { cloudOnly?: boolean }): PosUpstreamCandidate[] {
  const cloud: PosUpstreamCandidate = { url: getPosUpstreamUrl(), mode: 'cloud' };
  if (options?.cloudOnly) return [cloud];

  const targetFile = process.env.JINGLES_POS_LAN_UPSTREAM_FILE?.trim();
  if (!targetFile || !fs.existsSync(targetFile)) return [cloud];

  try {
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf8')) as {
      url?: unknown;
      deviceName?: unknown;
      expiresAt?: unknown;
    };
    const url = typeof target.url === 'string' ? target.url.trim().replace(/\/+$/, '') : '';
    const expiresAt = typeof target.expiresAt === 'string' ? Date.parse(target.expiresAt) : 0;
    if (!/^https?:\/\//i.test(url) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return [cloud];
    }
    if (url === cloud.url) return [cloud];
    return [
      {
        url,
        mode: 'lan',
        name: typeof target.deviceName === 'string' ? target.deviceName : undefined,
      },
      cloud,
    ];
  } catch {
    return [cloud];
  }
}

export function getPosSyncAppToken() {
  return (
    process.env.JINGLES_POS_SYNC_APP_TOKEN?.trim() ||
    process.env.POS_SYNC_APP_TOKEN?.trim() ||
    ''
  );
}
