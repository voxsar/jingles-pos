import { act, useState } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POS_SCANNER_SETTINGS, type POSScannerSettings } from '@jingles/shared';
import { useBarcodeScanner } from '../useBarcodeScanner';

function Harness(props: { settings?: Partial<POSScannerSettings>; onScan: (code: string) => void }) {
  const [value, setValue] = useState('');

  useBarcodeScanner({
    enabled: true,
    settings: { ...DEFAULT_POS_SCANNER_SETTINGS, ...props.settings },
    onScan: props.onScan,
  });

  return (
    <div>
      <input
        aria-label="discount"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <input
        aria-label="search"
        data-scanner-passthrough="true"
        defaultValue=""
      />
    </div>
  );
}

/**
 * jsdom does not run the browser's default action for keydown, so a realistic
 * simulation has to apply the character to the focused input itself — and only
 * when the handler did not call preventDefault.
 */
function pressKey(key: string, timeStamp: number) {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });

  target.dispatchEvent(event);

  if (!event.defaultPrevented && key.length === 1 && target instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(target, `${target.value}${key}`);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  return event;
}

function typeBurst(code: string, startAt: number, gapMs: number) {
  let clock = startAt;
  for (const character of code) {
    act(() => {
      pressKey(character, clock);
    });
    clock += gapMs;
  }
  return clock;
}

describe('useBarcodeScanner', () => {
  it('routes a machine-speed burst to the scan handler', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);

    const clock = typeBurst('4006381333931', 1_000, 8);
    act(() => {
      pressKey('Enter', clock);
    });

    expect(onScan).toHaveBeenCalledWith('4006381333931');
  });

  it('leaves the focused field untouched when a scan arrives', async () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);

    const discount = screen.getByLabelText('discount') as HTMLInputElement;
    discount.focus();

    const clock = typeBurst('5901234123457', 2_000, 8);
    act(() => {
      pressKey('Enter', clock);
    });

    expect(onScan).toHaveBeenCalledWith('5901234123457');
    // The first keystroke lands before the burst can be recognised, then is rolled back.
    expect(discount.value).toBe('');
  });

  it('ignores human-speed typing', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);

    const discount = screen.getByLabelText('discount') as HTMLInputElement;
    discount.focus();

    const clock = typeBurst('12345', 3_000, 120);
    act(() => {
      pressKey('Enter', clock);
    });

    expect(onScan).not.toHaveBeenCalled();
    expect(discount.value).toBe('12345');
  });

  it('lets Enter through when the burst is too short to be a scan', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);

    const clock = typeBurst('12', 4_000, 8);
    let enter: KeyboardEvent | null = null;
    act(() => {
      enter = pressKey('Enter', clock);
    });

    expect(onScan).not.toHaveBeenCalled();
    expect(enter!.defaultPrevented).toBe(false);
  });

  it('stands down inside a field marked for scanner passthrough', () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} />);

    const search = screen.getByLabelText('search') as HTMLInputElement;
    search.focus();

    const clock = typeBurst('4006381333931', 5_000, 8);
    act(() => {
      pressKey('Enter', clock);
    });

    expect(onScan).not.toHaveBeenCalled();
    expect(search.value).toBe('4006381333931');
  });

  it('strips a configured scanner prefix before reporting the code', () => {
    const onScan = vi.fn();
    render(<Harness settings={{ prefix: '#' }} onScan={onScan} />);

    const clock = typeBurst('#4006381333931', 6_000, 8);
    act(() => {
      pressKey('Enter', clock);
    });

    expect(onScan).toHaveBeenCalledWith('4006381333931');
  });

  it('never buffers keystrokes typed into a password field', () => {
    const onScan = vi.fn();
    const { container } = render(<Harness onScan={onScan} />);

    const password = document.createElement('input');
    password.type = 'password';
    container.append(password);
    password.focus();

    const clock = typeBurst('hunter2secret', 7_000, 8);
    act(() => {
      pressKey('Enter', clock);
    });

    expect(onScan).not.toHaveBeenCalled();
  });
});
