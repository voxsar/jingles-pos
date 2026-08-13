import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type SearchableSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

/**
 * What callers get from a ref. `open()` exists because the action bar and its
 * keyboard shortcut must drop the operator straight into the option list —
 * focusing the trigger alone looks like the button did nothing.
 */
export type SearchableSelectHandle = {
  focus: () => void;
  open: () => void;
  close: () => void;
};

type SearchableSelectProps = {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
};

/** Smallest usable menu height; below this we would show search with no options. */
const MIN_MENU_HEIGHT = 140;
/** Keeps the menu clear of the fixed header and action bar, which are ~140px tall. */
const VIEWPORT_MARGIN = 12;

const SearchableSelect = forwardRef<SearchableSelectHandle, SearchableSelectProps>(function SearchableSelect({
  options,
  value,
  onChange,
  className = '',
  disabled = false,
  placeholder = 'Select…',
  ariaLabel = 'Select option',
}, forwardedRef) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? options.filter((option) => option.label.toLocaleLowerCase().includes(query)) : options;
  }, [options, search]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setSearch('');
    setIsOpen(true);
  }, [disabled]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => triggerRef.current?.focus(),
    open: () => {
      triggerRef.current?.focus();
      openMenu();
    },
    close: () => setIsOpen(false),
  }), [openMenu]);

  /**
   * The menu is portalled to `document.body` and positioned in viewport
   * coordinates, so it has to fit itself into the viewport by hand. It prefers
   * to drop down, flips up when the space below is smaller, and always caps its
   * own height to the side it landed on — otherwise a picker near the bottom of
   * a till screen renders its options underneath the fixed action bar, where
   * they cannot be clicked.
   */
  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const viewportHeight = window.innerHeight;
    const width = Math.min(
      Math.max(rect.width, 240),
      Math.max(160, window.innerWidth - (VIEWPORT_MARGIN * 2)),
    );
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );

    const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const openAbove = spaceBelow < MIN_MENU_HEIGHT && spaceAbove > spaceBelow;
    const available = Math.max(MIN_MENU_HEIGHT, openAbove ? spaceAbove : spaceBelow);

    setMenuPosition({
      left,
      width,
      maxHeight: available,
      ...(openAbove
        ? { bottom: Math.max(VIEWPORT_MARGIN, viewportHeight - rect.top + 6) }
        : { top: Math.min(rect.bottom + 6, viewportHeight - MIN_MENU_HEIGHT - VIEWPORT_MARGIN) }),
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
    searchRef.current?.focus();
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
    // `options` and `value` only seed the initial highlight, so they are read
    // once per open rather than resetting the highlight on every catalog refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    setActiveIndex(0);
  }, [search]);

  useEffect(() => {
    if (!isOpen) return;
    const option = optionsRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    // jsdom has no layout, so it does not implement scrollIntoView.
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, isOpen]);

  const commit = (nextValue: string) => {
    onChange(nextValue);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Swallow it so the workstation-level Escape handler does not also fire
      // and tear down the modal the picker is sitting in.
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (
        (current + step + filteredOptions.length) % filteredOptions.length
      ));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option && !option.disabled) commit(option.value);
    }
  };

  const toggle = () => {
    if (disabled) return;
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    openMenu();
  };

  return (
    <div className="searchable-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-haspopup="listbox"
        className={`${className} searchable-select-trigger`}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span>{selected?.label ?? placeholder}</span>
        <span className="searchable-select-caret" aria-hidden="true">▾</span>
      </button>
      {isOpen && createPortal(
        <div
          className="searchable-select-menu"
          ref={menuRef}
          style={menuPosition}
          onKeyDown={handleMenuKeyDown}
        >
          <input
            ref={searchRef}
            type="search"
            className="searchable-select-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search options…"
            aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
          />
          <div id={listId} className="searchable-select-options" ref={optionsRef} role="listbox">
            {filteredOptions.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-option-index={index}
                className={[
                  'searchable-select-option',
                  option.value === value ? 'selected' : '',
                  index === activeIndex ? 'active' : '',
                ].filter(Boolean).join(' ')}
                disabled={option.disabled}
                key={option.value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(option.value)}
              >
                {option.label}
              </button>
            ))}
            {filteredOptions.length === 0 && <div className="searchable-select-empty">No matching options</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});

export default SearchableSelect;
