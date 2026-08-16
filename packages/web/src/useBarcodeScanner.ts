/**
 * Global capture for keyboard-wedge barcode scanners.
 *
 * Every USB and Bluetooth-HID scanner presents itself as a keyboard, so a scan
 * arrives as a burst of keystrokes ending in Enter. Without a global buffer those
 * keystrokes land in whatever happens to have focus — the discount box, the
 * customer picker, a payment amount — which silently corrupts the field instead
 * of adding the product. This hook watches the whole window, recognises bursts by
 * their inter-key timing, and routes them to the product lookup no matter where
 * focus sits.
 *
 * Timing is the only reliable signal: humans do not type at 30ms per character.
 * The first keystroke of a burst is allowed through (we cannot yet know a burst
 * has started) and is undone when the burst turns out to be a scan; the rest are
 * suppressed and replayed if the burst turns out to be a fast typist instead.
 *
 * Opt out for a field that legitimately wants raw scanner input by setting
 * `data-scanner-passthrough="true"` on it or on any ancestor.
 */
import { useEffect, useRef } from 'react';
import type { POSScannerSettings } from '@jingles/shared';

const TERMINATOR_KEYS = new Set(['Enter', 'Tab']);

type TextEntryElement = HTMLInputElement | HTMLTextAreaElement;

function isTextEntry(target: EventTarget | null): target is TextEntryElement {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (target instanceof HTMLInputElement) {
    // Checkboxes, buttons and friends have no text to restore or replay.
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(target.type);
  }

  return true;
}

function isPasswordField(target: EventTarget | null) {
  return target instanceof HTMLInputElement && target.type === 'password';
}

function allowsPassthrough(target: EventTarget | null) {
  return target instanceof Element && target.closest('[data-scanner-passthrough="true"]') != null;
}

/**
 * Writes a value into a React-controlled input. Assigning `.value` directly is
 * swallowed by React's synthetic event system, so the native setter is invoked
 * before dispatching the input event React actually listens for.
 */
function setNativeValue(element: TextEntryElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function playScanTone() {
  try {
    const AudioContextConstructor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      return;
    }

    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'square';
    oscillator.frequency.value = 2_000;
    gain.gain.setValueAtTime(0.04, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.08);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // A missing or blocked audio context must never break scanning.
  }
}

interface ScanRun {
  characters: string[];
  /** Characters after the first, which were suppressed and may need replaying. */
  suppressed: string;
  lastKeyAt: number;
  target: TextEntryElement | null;
  /** The target's value and caret before the first character landed. */
  valueBefore: string;
  selectionBefore: number | null;
}

export function useBarcodeScanner(options: {
  enabled: boolean;
  settings: POSScannerSettings;
  onScan: (code: string) => void;
  /** Allows real catalog codes shorter than the scanner's generic safety limit. */
  isKnownCode?: (code: string) => boolean;
}) {
  const { enabled, settings } = options;

  // Kept in refs so the window listener is installed once and never misses a
  // keystroke while React re-renders between characters of a burst.
  const onScanRef = useRef(options.onScan);
  const isKnownCodeRef = useRef(options.isKnownCode);
  const settingsRef = useRef(settings);
  const runRef = useRef<ScanRun | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  onScanRef.current = options.onScan;
  isKnownCodeRef.current = options.isKnownCode;
  settingsRef.current = settings;

  useEffect(() => {
    if (!enabled || !settings.enabled) {
      return undefined;
    }

    const clearFlushTimer = () => {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };

    /** Puts suppressed characters back where the user was typing. */
    const abandonRun = (explicitRun?: ScanRun | null) => {
      const run = explicitRun ?? runRef.current;
      runRef.current = null;
      clearFlushTimer();

      if (!run || !run.suppressed || !run.target?.isConnected) {
        return;
      }

      const target = run.target;
      if (document.activeElement !== target) {
        target.focus();
      }

      // execCommand keeps the caret position and undo stack intact, which a
      // wholesale value rewrite would destroy.
      if (!document.execCommand('insertText', false, run.suppressed)) {
        const caret = target.selectionStart ?? target.value.length;
        setNativeValue(target, `${target.value.slice(0, caret)}${run.suppressed}${target.value.slice(caret)}`);
      }
    };

    /** Undoes the first character, which was allowed through before we knew. */
    const rollBackFirstCharacter = (run: ScanRun) => {
      const target = run.target;
      if (!target?.isConnected || target.value === run.valueBefore) {
        return;
      }

      setNativeValue(target, run.valueBefore);
      if (run.selectionBefore != null) {
        try {
          target.setSelectionRange(run.selectionBefore, run.selectionBefore);
        } catch {
          // Inputs of type number or email reject selection ranges.
        }
      }
    };

    /** The buffered characters with any configured scanner prefix removed. */
    const resolveCode = (run: ScanRun) => {
      const current = settingsRef.current;
      const raw = run.characters.join('');
      return current.prefix && raw.startsWith(current.prefix)
        ? raw.slice(current.prefix.length)
        : raw;
    };

    const isLongEnoughOrKnown = (run: ScanRun) => {
      const code = resolveCode(run);
      return code.length >= settingsRef.current.minLength
        || isKnownCodeRef.current?.(code) === true;
    };

    const completeRun = (run: ScanRun) => {
      runRef.current = null;
      clearFlushTimer();
      rollBackFirstCharacter(run);

      if (settingsRef.current.beepOnScan) {
        playScanTone();
      }

      onScanRef.current(resolveCode(run));
    };

    const scheduleFlush = () => {
      clearFlushTimer();

      const current = settingsRef.current;
      if (current.requireTerminator) {
        // The burst is only a scan if a terminator arrives, so a stalled run is
        // abandoned rather than submitted.
        flushTimerRef.current = window.setTimeout(abandonRun, current.maxInterKeyMs * 6);
        return;
      }

      flushTimerRef.current = window.setTimeout(() => {
        const run = runRef.current;
        if (!run) {
          return;
        }

        if (isLongEnoughOrKnown(run)) {
          completeRun(run);
        } else {
          abandonRun(run);
        }
      }, current.maxInterKeyMs * 4);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
        abandonRun();
        return;
      }

      // Passwords must never enter the buffer, and fields that asked for raw
      // scanner input handle the burst themselves.
      if (isPasswordField(event.target) || allowsPassthrough(event.target)) {
        abandonRun();
        return;
      }

      const current = settingsRef.current;
      const run = runRef.current;

      if (TERMINATOR_KEYS.has(event.key)) {
        if (!run) {
          return;
        }

        const withinBurst = event.timeStamp - run.lastKeyAt <= current.maxInterKeyMs;
        if (!withinBurst || !isLongEnoughOrKnown(run)) {
          // Not a scan. Let the key do its normal job — submitting the payment
          // form, moving focus — instead of swallowing it.
          abandonRun();
          return;
        }

        // Consume the terminator so it cannot also submit whatever has focus.
        event.preventDefault();
        event.stopPropagation();
        completeRun(run);
        return;
      }

      if (event.key.length !== 1) {
        // Arrows, function keys and modifiers all mean this is not a scan.
        if (run) {
          abandonRun();
        }
        return;
      }

      const now = event.timeStamp;

      if (run && now - run.lastKeyAt <= current.maxInterKeyMs) {
        // Machine-speed continuation: hold this character back so it cannot
        // reach the focused field.
        event.preventDefault();
        event.stopPropagation();
        run.characters.push(event.key);
        run.suppressed += event.key;
        run.lastKeyAt = now;
        scheduleFlush();
        return;
      }

      if (run) {
        abandonRun();
      }

      const target = isTextEntry(event.target) ? event.target : null;
      runRef.current = {
        characters: [event.key],
        suppressed: '',
        lastKeyAt: now,
        target,
        valueBefore: target?.value ?? '',
        selectionBefore: target?.selectionStart ?? null,
      };
      scheduleFlush();
    };

    const handleBlur = () => abandonRun();

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
      clearFlushTimer();
      runRef.current = null;
    };
  }, [enabled, settings.enabled]);
}
