/**
 * Delivers an already-encoded byte buffer to a physical printer.
 *
 * Every transport here is deliberately dependency-free: a TCP socket for network
 * printers, the Windows spooler (via {@link RAW_PRINT_SCRIPT}) or CUPS for
 * USB-attached ones, and a plain file write for character devices.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { POSPrinterConfig } from '@jingles/shared';
import { RAW_PRINT_SCRIPT } from './rawPrintScript';
import { reportElectronError } from '../errorReporter';

const NETWORK_CONNECT_TIMEOUT_MS = 5_000;
const NETWORK_WRITE_TIMEOUT_MS = 15_000;
const SPOOLER_TIMEOUT_MS = 30_000;

let cachedScriptPath: string | null = null;

function getPrintingWorkDirectory() {
  // Resolved lazily so this module stays importable from tests without Electron.
  const { app } = require('electron') as typeof import('electron');
  const directory = path.join(app.getPath('userData'), 'printing');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function getRawPrintScriptPath() {
  if (cachedScriptPath && fs.existsSync(cachedScriptPath)) {
    return cachedScriptPath;
  }

  const scriptPath = path.join(getPrintingWorkDirectory(), 'raw-print.ps1');
  const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null;
  if (existing !== RAW_PRINT_SCRIPT) {
    // A BOM keeps PowerShell from mis-decoding the embedded C# on hosts whose
    // default console code page is not UTF-8.
    fs.writeFileSync(scriptPath, `\ufeff${RAW_PRINT_SCRIPT}`, 'utf8');
  }

  cachedScriptPath = scriptPath;
  return scriptPath;
}

function getPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const bundled = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(bundled) ? bundled : 'powershell.exe';
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}.`));
      }
    });
  });
}

async function sendOverNetwork(payload: Buffer, host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(NETWORK_CONNECT_TIMEOUT_MS);
    socket.once('timeout', () => finish(new Error(`${host}:${port} did not respond within ${NETWORK_CONNECT_TIMEOUT_MS}ms.`)));
    socket.once('error', (error) => finish(error));

    socket.connect(port, host, () => {
      socket.setTimeout(NETWORK_WRITE_TIMEOUT_MS);
      socket.write(payload, (error) => {
        if (error) {
          finish(error);
          return;
        }

        // end() flushes, and the printer closing the connection confirms the
        // spooler on the far side accepted the whole job.
        socket.end(() => finish());
      });
    });
  });

  return payload.length;
}

async function sendThroughWindowsSpooler(payload: Buffer, printerName: string, documentName: string) {
  const jobPath = path.join(
    getPrintingWorkDirectory(),
    `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.bin`,
  );
  fs.writeFileSync(jobPath, payload);

  try {
    const { stdout } = await runCommand(
      getPowerShellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        getRawPrintScriptPath(),
        '-PrinterName',
        printerName,
        '-FilePath',
        jobPath,
        '-DocumentName',
        documentName,
      ],
      SPOOLER_TIMEOUT_MS,
    );

    const written = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(written) && written > 0 ? written : payload.length;
  } finally {
    try {
      fs.unlinkSync(jobPath);
    } catch (error) {
      reportElectronError(error, 'electron.print.spool-cleanup-windows');
      // A leftover spool file is harmless; the directory is cleaned on startup.
    }
  }
}

async function sendThroughCups(payload: Buffer, printerName: string, documentName: string) {
  const jobPath = path.join(
    getPrintingWorkDirectory(),
    `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.bin`,
  );
  fs.writeFileSync(jobPath, payload);

  try {
    await runCommand(
      'lp',
      ['-d', printerName, '-o', 'raw', '-t', documentName, jobPath],
      SPOOLER_TIMEOUT_MS,
    );
    return payload.length;
  } finally {
    try {
      fs.unlinkSync(jobPath);
    } catch (error) {
      reportElectronError(error, 'electron.print.spool-cleanup-cups');
      // Ignored, same as the Windows path.
    }
  }
}

function normalizeWindowsPortPath(devicePath: string) {
  if (os.platform() !== 'win32') return null;
  const match = /^(?:\\\\\.\\)?(COM|LPT)([1-9]\d*)$/i.exec(devicePath.trim());
  return match ? `\\\\.\\${match[1]!.toUpperCase()}${match[2]}` : null;
}

async function openWindowsPort(devicePath: string) {
  // r+ maps to OPEN_EXISTING. Windows communication devices cannot be opened
  // with the create/truncate semantics used by writeFile(..., { flag: 'w' }).
  return fs.promises.open(devicePath, 'r+');
}

async function sendToDevice(payload: Buffer, devicePath: string) {
  const windowsPortPath = normalizeWindowsPortPath(devicePath);
  if (!windowsPortPath) {
    await fs.promises.writeFile(devicePath, payload);
    return payload.length;
  }

  const handle = await openWindowsPort(windowsPortPath);
  try {
    const { bytesWritten } = await handle.write(payload, 0, payload.length, null);
    return bytesWritten;
  } finally {
    await handle.close();
  }
}

/** Removes spool files left behind by a crash or a killed job. */
export function cleanPrintingWorkDirectory() {
  try {
    const directory = getPrintingWorkDirectory();
    for (const entry of fs.readdirSync(directory)) {
      if (entry.startsWith('job-') && entry.endsWith('.bin')) {
        fs.unlinkSync(path.join(directory, entry));
      }
    }
  } catch (error) {
    reportElectronError(error, 'electron.print.startup-cleanup');
    // Never let housekeeping block startup.
  }
}

export async function sendToPrinter(
  payload: Buffer,
  printer: POSPrinterConfig,
  documentName = 'Jingles POS',
): Promise<number> {
  if (payload.length === 0) {
    throw new Error('Nothing to print: the encoded job was empty.');
  }

  switch (printer.transport) {
    case 'network': {
      const host = printer.address.trim();
      if (!host) {
        throw new Error(`Printer "${printer.name}" has no host or IP address configured.`);
      }

      return sendOverNetwork(payload, host, printer.port > 0 ? printer.port : 9100);
    }

    case 'system': {
      const printerName = printer.address.trim();
      if (!printerName) {
        throw new Error(`Printer "${printer.name}" has no Windows printer name configured.`);
      }

      return os.platform() === 'win32'
        ? sendThroughWindowsSpooler(payload, printerName, documentName)
        : sendThroughCups(payload, printerName, documentName);
    }

    case 'device': {
      const devicePath = printer.address.trim();
      if (!devicePath) {
        throw new Error(`Printer "${printer.name}" has no device path configured.`);
      }

      return sendToDevice(payload, devicePath);
    }

    default:
      throw new Error(`Unsupported printer transport "${String(printer.transport)}".`);
  }
}

/** Confirms a printer is reachable without putting a job on the paper. */
export async function probePrinter(printer: POSPrinterConfig): Promise<void> {
  if (printer.transport === 'network') {
    const host = printer.address.trim();
    if (!host) {
      throw new Error('No host or IP address is configured.');
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      socket.setTimeout(NETWORK_CONNECT_TIMEOUT_MS);
      socket.once('timeout', () => finish(new Error(`No answer from ${host}:${printer.port} within ${NETWORK_CONNECT_TIMEOUT_MS}ms.`)));
      socket.once('error', (error) => finish(error));
      socket.connect(printer.port > 0 ? printer.port : 9100, host, () => finish());
    });
    return;
  }

  if (printer.transport === 'device') {
    const devicePath = printer.address.trim();
    const windowsPortPath = normalizeWindowsPortPath(devicePath);
    if (windowsPortPath) {
      const handle = await openWindowsPort(windowsPortPath);
      await handle.close();
      return;
    }
    if (!devicePath || !fs.existsSync(devicePath)) {
      throw new Error(`No device exists at ${devicePath || '(unset)'}.`);
    }
    return;
  }

  if (!printer.address.trim()) {
    throw new Error('No spooler printer name is configured.');
  }
}

export const __testing = { normalizeWindowsPortPath };
