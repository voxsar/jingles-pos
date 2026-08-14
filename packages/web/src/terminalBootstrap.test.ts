import type { Terminal } from '@jingles/shared';
import { resolveBootstrapTerminal } from './terminalBootstrap';

const terminals: Terminal[] = [
  { id: 'terminal-a', code: 'A', name: 'A', branchId: 'branch-a', branchCode: 'A' },
  { id: 'terminal-b', code: 'B', name: 'B', branchId: 'branch-b', branchCode: 'B' },
];

describe('resolveBootstrapTerminal', () => {
  it('recovers the terminal that owns an existing shift on first load', () => {
    const terminal = resolveBootstrapTerminal({
      terminals,
      activeShift: { terminalId: 'terminal-b' },
    });

    expect(terminal?.id).toBe('terminal-b');
  });

  it('honours an explicit terminal selection', () => {
    const terminal = resolveBootstrapTerminal({
      terminals,
      activeShift: { terminalId: 'terminal-b' },
    }, 'terminal-a');

    expect(terminal?.id).toBe('terminal-a');
  });

  it('falls back to the first available terminal without a shift', () => {
    expect(resolveBootstrapTerminal({ terminals, activeShift: null })?.id).toBe('terminal-a');
  });
});
