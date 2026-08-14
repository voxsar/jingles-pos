import type { ShiftSummary, Terminal } from '@jingles/shared';

type BootstrapTerminalState = {
  terminals: Terminal[];
  activeShift?: Pick<ShiftSummary, 'terminalId'> | null;
};

/**
 * Resolve the terminal represented by a bootstrap response. On first load there
 * is no trustworthy configured terminal ID, so an existing shift takes
 * precedence. For an explicit operator selection, the requested terminal wins.
 */
export function resolveBootstrapTerminal(
  data: BootstrapTerminalState,
  requestedTerminalId?: string,
): Terminal | null {
  const requested = requestedTerminalId?.trim();
  if (requested) {
    const requestedTerminal = data.terminals.find((terminal) => terminal.id === requested);
    if (requestedTerminal) {
      return requestedTerminal;
    }
  }

  if (data.activeShift) {
    const activeTerminal = data.terminals.find(
      (terminal) => terminal.id === data.activeShift?.terminalId,
    );
    if (activeTerminal) {
      return activeTerminal;
    }
  }

  return data.terminals[0] ?? null;
}
