import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { DiscoveredJinglesDevice } from './mdns';

const TARGET_FILE_NAME = 'lan-sync-target.json';

export function getLanSyncTargetPath() {
  return path.join(app.getPath('userData'), 'backend', TARGET_FILE_NAME);
}

export function writeLanSyncTarget(device: DiscoveredJinglesDevice | null) {
  const targetPath = getLanSyncTargetPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  if (!device) {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    return;
  }

  const protocol = device.protocol === 'https' ? 'https' : 'http';
  const payload = {
    url: `${protocol}://${device.address}:${device.port}`,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    discoveredAt: device.discoveredAt,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
  };
  const temporaryPath = `${targetPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, targetPath);
}
