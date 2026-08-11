import dgram, { type RemoteInfo } from 'dgram';
import os from 'os';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_NAME = '_jingles._tcp.local';
const DNS_CLASS_IN = 1;
const DNS_TYPE_A = 1;
const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_AAAA = 28;
const DNS_TYPE_SRV = 33;
const DEFAULT_TTL_SECONDS = 45;
const ANNOUNCE_INTERVAL_MS = 15_000;
const PRUNE_INTERVAL_MS = 5_000;

export type JinglesApplication = 'inventory' | 'pos';

export interface MdnsAdvertisement {
  deviceId: string;
  deviceName: string;
  application: JinglesApplication;
  applicationVersion: string;
  port: number;
  protocol?: 'http' | 'https';
  apiPath?: string;
  branchId?: string;
  terminalId?: string;
}

export interface DiscoveredJinglesDevice extends MdnsAdvertisement {
  address: string;
  hostname: string;
  instanceName: string;
  discoveredAt: string;
  lastSeenAt: string;
  expiresAt: string;
  source: 'mdns';
}

type DnsRecord = {
  name: string;
  type: number;
  ttl: number;
  dataOffset: number;
  dataLength: number;
};

function normalizeDnsName(value: string) {
  return value.replace(/\.$/, '').toLowerCase();
}

function encodeDnsName(value: string) {
  const chunks: Buffer[] = [];
  for (const label of value.replace(/\.$/, '').split('.')) {
    const encoded = Buffer.from(label, 'utf8');
    if (encoded.length === 0 || encoded.length > 63) {
      throw new Error(`Invalid DNS label in ${value}`);
    }
    chunks.push(Buffer.from([encoded.length]), encoded);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function readDnsName(packet: Buffer, initialOffset: number) {
  const labels: string[] = [];
  let offset = initialOffset;
  let nextOffset = initialOffset;
  let jumped = false;
  let hops = 0;

  while (offset < packet.length && hops < 64) {
    hops += 1;
    const length = packet[offset];
    if (length === 0) {
      if (!jumped) nextOffset = offset + 1;
      return { name: labels.join('.'), nextOffset };
    }

    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error('Truncated DNS compression pointer');
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1];
      if (!jumped) nextOffset = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }

    if ((length & 0xc0) !== 0 || offset + 1 + length > packet.length) {
      throw new Error('Malformed DNS name');
    }
    labels.push(packet.subarray(offset + 1, offset + 1 + length).toString('utf8'));
    offset += 1 + length;
    if (!jumped) nextOffset = offset;
  }

  throw new Error('DNS name exceeded packet bounds');
}

function encodeQuestion(name: string, type: number) {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(DNS_CLASS_IN, 2);
  return Buffer.concat([encodeDnsName(name), tail]);
}

function encodeRecord(name: string, type: number, ttl: number, data: Buffer) {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(DNS_CLASS_IN | 0x8000, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeDnsName(name), header, data]);
}

function encodePtrData(target: string) {
  return encodeDnsName(target);
}

function encodeSrvData(port: number, target: string) {
  const prefix = Buffer.alloc(6);
  prefix.writeUInt16BE(0, 0);
  prefix.writeUInt16BE(0, 2);
  prefix.writeUInt16BE(port, 4);
  return Buffer.concat([prefix, encodeDnsName(target)]);
}

function encodeTxtData(values: Record<string, string | undefined>) {
  const chunks: Buffer[] = [];
  for (const [key, rawValue] of Object.entries(values)) {
    if (!rawValue) continue;
    const value = Buffer.from(`${key}=${rawValue}`, 'utf8');
    if (value.length > 255) continue;
    chunks.push(Buffer.from([value.length]), value);
  }
  return Buffer.concat(chunks);
}

function encodeIpv4(address: string) {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }
  return Buffer.from(octets);
}

function readIpv4(data: Buffer) {
  return data.length === 4 ? [...data].join('.') : null;
}

function readTxt(data: Buffer) {
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset];
    offset += 1;
    if (offset + length > data.length) break;
    const entry = data.subarray(offset, offset + length).toString('utf8');
    offset += length;
    const separator = entry.indexOf('=');
    if (separator > 0) values[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return values;
}

function parseRecords(packet: Buffer) {
  if (packet.length < 12) return { questions: [] as Array<{ name: string; type: number }>, records: [] as DnsRecord[] };
  const questionCount = packet.readUInt16BE(4);
  const recordCount = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  const questions: Array<{ name: string; type: number }> = [];
  const records: DnsRecord[] = [];
  let offset = 12;

  for (let index = 0; index < questionCount; index += 1) {
    const decoded = readDnsName(packet, offset);
    offset = decoded.nextOffset;
    if (offset + 4 > packet.length) throw new Error('Truncated DNS question');
    questions.push({ name: decoded.name, type: packet.readUInt16BE(offset) });
    offset += 4;
  }

  for (let index = 0; index < recordCount; index += 1) {
    const decoded = readDnsName(packet, offset);
    offset = decoded.nextOffset;
    if (offset + 10 > packet.length) throw new Error('Truncated DNS record');
    const type = packet.readUInt16BE(offset);
    const ttl = packet.readUInt32BE(offset + 4);
    const dataLength = packet.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    if (dataOffset + dataLength > packet.length) throw new Error('Truncated DNS record data');
    records.push({ name: decoded.name, type, ttl, dataOffset, dataLength });
    offset = dataOffset + dataLength;
  }

  return { questions, records };
}

function localIpv4Addresses() {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function safeDnsLabel(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || 'device').slice(0, 48);
}

function buildAnnouncement(advertisement: MdnsAdvertisement, ttl = DEFAULT_TTL_SECONDS) {
  const suffix = safeDnsLabel(advertisement.deviceId);
  const instanceName = `${advertisement.application}-${suffix}.${SERVICE_NAME}`;
  const hostname = `jingles-${suffix}.local`;
  const records = [
    encodeRecord(SERVICE_NAME, DNS_TYPE_PTR, ttl, encodePtrData(instanceName)),
    encodeRecord(instanceName, DNS_TYPE_SRV, ttl, encodeSrvData(advertisement.port, hostname)),
    encodeRecord(instanceName, DNS_TYPE_TXT, ttl, encodeTxtData({
      id: advertisement.deviceId,
      name: advertisement.deviceName,
      app: advertisement.application,
      ver: advertisement.applicationVersion,
      proto: advertisement.protocol ?? 'http',
      path: advertisement.apiPath ?? '/',
      branch: advertisement.branchId,
      terminal: advertisement.terminalId,
    })),
    ...localIpv4Addresses().map((address) =>
      encodeRecord(hostname, DNS_TYPE_A, ttl, encodeIpv4(address))),
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}

function buildQuery() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, encodeQuestion(SERVICE_NAME, DNS_TYPE_PTR)]);
}

function cloneDevice(device: DiscoveredJinglesDevice): DiscoveredJinglesDevice {
  return { ...device };
}

export class JinglesMdnsService {
  private socket: dgram.Socket | null = null;
  private announcementTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private advertisement: MdnsAdvertisement;
  private readonly devices = new Map<string, DiscoveredJinglesDevice>();
  private readonly listeners = new Set<(devices: DiscoveredJinglesDevice[]) => void>();

  constructor(advertisement: MdnsAdvertisement) {
    this.advertisement = { ...advertisement };
  }

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (error) => console.warn('[mDNS] Socket error', error));
    socket.on('message', (packet, remote) => this.handlePacket(packet, remote));
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
      } catch (error) {
        console.warn('[mDNS] Failed to join multicast group', error);
      }
      this.announce();
      this.query();
    });
    this.announcementTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    this.pruneTimer = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
  }

  stop() {
    if (this.announcementTimer) clearInterval(this.announcementTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.announcementTimer = null;
    this.pruneTimer = null;
    if (this.socket) {
      this.send(buildAnnouncement(this.advertisement, 0));
      this.socket.close();
      this.socket = null;
    }
    this.devices.clear();
    this.publish();
  }

  updateAdvertisement(next: Partial<MdnsAdvertisement>) {
    this.advertisement = { ...this.advertisement, ...next };
    this.announce();
  }

  query() {
    this.send(buildQuery());
  }

  getDevices() {
    this.pruneExpired();
    return [...this.devices.values()]
      .sort((left, right) => left.deviceName.localeCompare(right.deviceName))
      .map(cloneDevice);
  }

  subscribe(listener: (devices: DiscoveredJinglesDevice[]) => void) {
    this.listeners.add(listener);
    listener(this.getDevices());
    return () => this.listeners.delete(listener);
  }

  private announce() {
    this.send(buildAnnouncement(this.advertisement));
  }

  private send(packet: Buffer) {
    const socket = this.socket;
    if (!socket) return;
    socket.send(packet, MDNS_PORT, MDNS_ADDRESS, (error) => {
      if (error) console.warn('[mDNS] Failed to send packet', error);
    });
  }

  private handlePacket(packet: Buffer, remote: RemoteInfo) {
    try {
      const parsed = parseRecords(packet);
      if (parsed.questions.some((question) =>
        normalizeDnsName(question.name) === SERVICE_NAME &&
        (question.type === DNS_TYPE_PTR || question.type === 255))) {
        this.announce();
      }
      this.consumeRecords(packet, parsed.records, remote);
    } catch (error) {
      console.debug('[mDNS] Ignored malformed packet', error);
    }
  }

  private consumeRecords(packet: Buffer, records: DnsRecord[], remote: RemoteInfo) {
    const ptrInstances = new Set<string>();
    const textByInstance = new Map<string, Record<string, string>>();
    const serviceByInstance = new Map<string, { port: number; hostname: string; ttl: number }>();
    const addressByHostname = new Map<string, string>();

    for (const record of records) {
      const data = packet.subarray(record.dataOffset, record.dataOffset + record.dataLength);
      if (record.type === DNS_TYPE_PTR && normalizeDnsName(record.name) === SERVICE_NAME) {
        ptrInstances.add(readDnsName(packet, record.dataOffset).name);
      } else if (record.type === DNS_TYPE_TXT) {
        textByInstance.set(normalizeDnsName(record.name), readTxt(data));
      } else if (record.type === DNS_TYPE_SRV && data.length >= 6) {
        serviceByInstance.set(normalizeDnsName(record.name), {
          port: data.readUInt16BE(4),
          hostname: readDnsName(packet, record.dataOffset + 6).name,
          ttl: record.ttl,
        });
      } else if (record.type === DNS_TYPE_A) {
        const address = readIpv4(data);
        if (address) addressByHostname.set(normalizeDnsName(record.name), address);
      } else if (record.type === DNS_TYPE_AAAA) {
        // IPv4 is deliberately preferred for the embedded HTTP sync endpoint.
      }
    }

    let changed = false;
    for (const instance of ptrInstances) {
      const key = normalizeDnsName(instance);
      const txt = textByInstance.get(key);
      const service = serviceByInstance.get(key);
      if (!txt?.id || !txt.name || !service || !['inventory', 'pos'].includes(txt.app)) continue;
      const now = new Date();
      if (service.ttl === 0) {
        changed = this.devices.delete(txt.id) || changed;
        continue;
      }
      const ttl = Math.max(1, service.ttl || DEFAULT_TTL_SECONDS);
      const previous = this.devices.get(txt.id);
      const address = addressByHostname.get(normalizeDnsName(service.hostname)) ?? remote.address;
      this.devices.set(txt.id, {
        deviceId: txt.id,
        deviceName: txt.name,
        application: txt.app as JinglesApplication,
        applicationVersion: txt.ver || 'unknown',
        port: service.port,
        protocol: txt.proto === 'https' ? 'https' : 'http',
        apiPath: txt.path || '/',
        branchId: txt.branch || undefined,
        terminalId: txt.terminal || undefined,
        address,
        hostname: service.hostname,
        instanceName: instance,
        discoveredAt: previous?.discoveredAt ?? now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
        source: 'mdns',
      });
      changed = true;
    }
    if (changed) this.publish();
  }

  private pruneExpired() {
    const now = Date.now();
    let changed = false;
    for (const [deviceId, device] of this.devices) {
      if (Date.parse(device.expiresAt) <= now) {
        this.devices.delete(deviceId);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  private publish() {
    const snapshot = [...this.devices.values()]
      .sort((left, right) => left.deviceName.localeCompare(right.deviceName))
      .map(cloneDevice);
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const jinglesMdnsConstants = {
  address: MDNS_ADDRESS,
  port: MDNS_PORT,
  serviceName: SERVICE_NAME,
};
