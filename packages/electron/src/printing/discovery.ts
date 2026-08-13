/**
 * Finds printers the terminal could use, from two independent sources:
 *
 *  - the OS spooler, which covers every USB-attached printer that has a driver
 *    installed (Electron exposes this without a native module), and
 *  - a bounded sweep of the local subnets for hosts listening on the raw
 *    printing port, which covers network Epson and Zebra units.
 *
 * Discovery never writes to a printer. Probing with a status command would make
 * an ESC/POS unit print the literal characters of a Zebra query and vice versa,
 * so identification is limited to names and reverse DNS, and the user confirms
 * the language when adding the printer.
 */
import dns from 'dns';
import net from 'net';
import os from 'os';
import type {
  POSDiscoveredPrinter,
  POSPrinterDiscoveryResult,
  POSPrinterLanguage,
  POSPrinterRole,
} from '@jingles/shared';

/**
 * The slice of Electron's WebContents this module needs. Narrowing it keeps
 * discovery unit-testable with a plain object stand-in.
 */
export interface PrinterEnumerationSource {
  getPrintersAsync: () => Promise<Array<{
    name: string;
    displayName?: string;
    description?: string;
    isDefault?: boolean;
  }>>;
}

const RAW_PRINT_PORT = 9100;
const SCAN_CONCURRENCY = 48;
const SCAN_TIMEOUT_MS = 400;
const MAX_SCANNED_HOSTS = 1024;

const LABEL_PRINTER_HINTS = [
  'zebra', 'zpl', 'zd220', 'zd230', 'zd420', 'zd421', 'zd621', 'zt230', 'zt411',
  'gk420', 'gx420', 'gx430', 'gc420', 'tlp', 'lp2844',
  'tsc', 'godex', 'argox', 'sato', 'citizen cl', 'label', 'barcode',
];

const RECEIPT_PRINTER_HINTS = [
  'epson', 'tm-t', 'tm-m', 'tm-u', 'tm-p', 'tmt', 'star ', 'tsp1', 'tsp6', 'tsp7',
  'mc-print', 'bixolon', 'srp-', 'rongta', 'rp80', 'xprinter', 'xp-', 'pos-', 'pos58',
  'pos80', 'thermal', 'receipt', 'ncr', 'partner rp',
];

function classify(name: string): { language: POSPrinterLanguage; role: POSPrinterRole } {
  const haystack = name.toLowerCase();

  if (LABEL_PRINTER_HINTS.some((hint) => haystack.includes(hint))) {
    return { language: 'zpl', role: 'label' };
  }

  if (RECEIPT_PRINTER_HINTS.some((hint) => haystack.includes(hint))) {
    return { language: 'escpos', role: 'receipt' };
  }

  return { language: 'escpos', role: 'receipt' };
}

async function listSystemPrinters(webContents: PrinterEnumerationSource | null): Promise<POSDiscoveredPrinter[]> {
  if (!webContents) {
    return [];
  }

  const printers = await webContents.getPrintersAsync();

  return printers.map((printer) => {
    const label = printer.displayName || printer.name;
    const { language, role } = classify(`${printer.name} ${label} ${printer.description ?? ''}`);

    return {
      name: label,
      transport: 'system' as const,
      address: printer.name,
      port: 0,
      description: printer.description || undefined,
      suggestedLanguage: language,
      suggestedRole: role,
      isSystemDefault: printer.isDefault === true,
      source: 'system' as const,
    };
  });
}

/** IPv4 networks worth sweeping: local, non-loopback, and no larger than a /22. */
function collectScannableSubnets() {
  const subnets: Array<{ cidr: string; hosts: string[] }> = [];

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) {
        continue;
      }

      const prefix = Number.parseInt(address.cidr?.split('/')[1] ?? '', 10);
      if (!Number.isFinite(prefix) || prefix < 22 || prefix > 30) {
        // Wider than a /22 would mean thousands of probes; narrower than /30 has
        // no usable host range.
        continue;
      }

      const octets = address.address.split('.').map(Number);
      const maskOctets = address.netmask.split('.').map(Number);
      if (octets.length !== 4 || maskOctets.length !== 4 || octets.some(Number.isNaN)) {
        continue;
      }

      const toInt = (parts: number[]) => parts.reduce((sum, part) => (sum << 8) + part, 0) >>> 0;
      const base = toInt(octets) & toInt(maskOctets);
      const total = 2 ** (32 - prefix);
      const hosts: string[] = [];

      for (let offset = 1; offset < total - 1 && hosts.length < MAX_SCANNED_HOSTS; offset += 1) {
        const value = (base + offset) >>> 0;
        const host = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
        if (host !== address.address) {
          hosts.push(host);
        }
      }

      subnets.push({
        cidr: `${[base >>> 24, (base >>> 16) & 0xff, (base >>> 8) & 0xff, base & 0xff].join('.')}/${prefix}`,
        hosts,
      });
    }
  }

  return subnets;
}

function isPortOpen(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host, () => finish(true));
  });
}

async function reverseLookup(host: string) {
  try {
    const names = await dns.promises.reverse(host);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

/** Runs `worker` over `items` with a fixed number of in-flight tasks. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

async function scanNetworkPrinters(): Promise<{ printers: POSDiscoveredPrinter[]; subnets: string[]; warnings: string[] }> {
  const subnets = collectScannableSubnets();
  const warnings: string[] = [];

  if (subnets.length === 0) {
    warnings.push('No suitable IPv4 network was found to scan. Add network printers by IP address instead.');
    return { printers: [], subnets: [], warnings };
  }

  const hosts = subnets.flatMap((subnet) => subnet.hosts);
  const openHosts: string[] = [];

  await mapWithConcurrency(hosts, SCAN_CONCURRENCY, async (host) => {
    if (await isPortOpen(host, RAW_PRINT_PORT, SCAN_TIMEOUT_MS)) {
      openHosts.push(host);
    }
  });

  const printers = await Promise.all(openHosts.map(async (host): Promise<POSDiscoveredPrinter> => {
    const hostname = await reverseLookup(host);
    const { language, role } = classify(hostname ?? '');

    return {
      name: hostname ? `${hostname} (${host})` : `Network printer at ${host}`,
      transport: 'network',
      address: host,
      port: RAW_PRINT_PORT,
      description: `Listening on port ${RAW_PRINT_PORT}`,
      suggestedLanguage: language,
      suggestedRole: role,
      isSystemDefault: false,
      source: 'network',
    };
  }));

  return {
    printers: printers.sort((left, right) => left.address.localeCompare(right.address, undefined, { numeric: true })),
    subnets: subnets.map((subnet) => subnet.cidr),
    warnings,
  };
}

export async function discoverPrinters(
  webContents: PrinterEnumerationSource | null,
  options: { includeNetwork?: boolean } = {},
): Promise<POSPrinterDiscoveryResult> {
  const warnings: string[] = [];

  const systemPrinters = await listSystemPrinters(webContents).catch((error: unknown) => {
    warnings.push(`Could not read installed printers: ${error instanceof Error ? error.message : String(error)}`);
    return [] as POSDiscoveredPrinter[];
  });

  if (options.includeNetwork === false) {
    return { printers: systemPrinters, scannedSubnets: [], warnings };
  }

  const network = await scanNetworkPrinters().catch((error: unknown) => {
    warnings.push(`Network scan failed: ${error instanceof Error ? error.message : String(error)}`);
    return { printers: [] as POSDiscoveredPrinter[], subnets: [] as string[], warnings: [] as string[] };
  });

  return {
    printers: [...systemPrinters, ...network.printers],
    scannedSubnets: network.subnets,
    warnings: [...warnings, ...network.warnings],
  };
}
