import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type SearchableSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
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

const SearchableSelect = forwardRef<HTMLButtonElement, SearchableSelectProps>(function SearchableSelect({
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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? options.filter((option) => option.label.toLocaleLowerCase().includes(query)) : options;
  }, [options, search]);

  useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement);

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 240);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const openAbove = window.innerHeight - rect.bottom < 280 && rect.top > 280;
    setMenuPosition(openAbove
      ? { bottom: window.innerHeight - rect.top + 6, left, width }
      : { top: rect.bottom + 6, left, width });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
    searchRef.current?.focus();

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  const toggle = () => {
    if (disabled) return;
    setSearch('');
    updateMenuPosition();
    setIsOpen((current) => !current);
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
            setSearch('');
            setIsOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? placeholder}</span>
        <span className="searchable-select-caret" aria-hidden="true">▾</span>
      </button>
      {isOpen && createPortal(
        <div className="searchable-select-menu glass-panel" ref={menuRef} style={menuPosition}>
          <input
            ref={searchRef}
            type="search"
            className="searchable-select-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search options…"
            aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
          />
          <div id={listId} className="searchable-select-options" role="listbox">
            {filteredOptions.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`searchable-select-option ${option.value === value ? 'selected' : ''}`}
                disabled={option.disabled}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
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
