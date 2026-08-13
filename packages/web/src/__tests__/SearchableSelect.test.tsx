import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SearchableSelect, { type SearchableSelectHandle } from '../components/SearchableSelect';

describe('SearchableSelect', () => {
  it('opens with a visible search box even when there is only one option', async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect
        ariaLabel="Terminal"
        options={[{ value: 'one', label: 'Only terminal' }]}
        value="one"
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Terminal' }));

    expect(screen.getByRole('searchbox', { name: 'Search terminal' })).toBeVisible();
  });

  it('filters the option list and selects a result', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SearchableSelect
        ariaLabel="Product"
        options={[{ value: 'all', label: 'All products' }, { value: 'gel', label: 'Shaving gel' }]}
        value="all"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Product' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search product' }), 'gel');
    await user.click(screen.getByRole('option', { name: 'Shaving gel' }));

    expect(onChange).toHaveBeenCalledWith('gel');
  });

  it('opens the list from the imperative handle so the action bar button is not a no-op', () => {
    const ref = createRef<SearchableSelectHandle>();
    render(
      <SearchableSelect
        ref={ref}
        ariaLabel="Customer"
        options={[{ value: 'walk-in', label: 'Walk-in - Retail' }]}
        value="walk-in"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('searchbox')).toBeNull();

    act(() => ref.current?.open());

    expect(screen.getByRole('searchbox', { name: 'Search customer' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('flips above the trigger and caps its height when there is no room below', () => {
    // A picker low on a till screen: 60px of space under it, plenty above.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700, bottom: 740, left: 620, right: 900, width: 280, height: 40, x: 620, y: 700,
      toJSON: () => ({}),
    } as DOMRect);
    window.innerHeight = 800;
    window.innerWidth = 1280;

    const ref = createRef<SearchableSelectHandle>();
    render(
      <SearchableSelect
        ref={ref}
        ariaLabel="Customer"
        options={[{ value: 'walk-in', label: 'Walk-in - Retail' }]}
        value="walk-in"
        onChange={vi.fn()}
      />,
    );

    act(() => ref.current?.open());

    const menu = document.querySelector<HTMLElement>('.searchable-select-menu');
    expect(menu).not.toBeNull();
    // Anchored to its bottom edge above the trigger rather than running off-screen
    // underneath the fixed action bar.
    expect(menu!.style.bottom).toBe('106px');
    expect(menu!.style.top).toBe('');
    expect(menu!.style.maxHeight).toBe('688px');

    vi.restoreAllMocks();
  });

  it('drops below the trigger when there is room, and never exceeds the space it has', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100, bottom: 140, left: 620, right: 900, width: 280, height: 40, x: 620, y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    window.innerHeight = 800;
    window.innerWidth = 1280;

    const ref = createRef<SearchableSelectHandle>();
    render(
      <SearchableSelect
        ref={ref}
        ariaLabel="Customer"
        options={[{ value: 'walk-in', label: 'Walk-in - Retail' }]}
        value="walk-in"
        onChange={vi.fn()}
      />,
    );

    act(() => ref.current?.open());

    const menu = document.querySelector<HTMLElement>('.searchable-select-menu');
    expect(menu!.style.top).toBe('146px');
    expect(menu!.style.bottom).toBe('');
    expect(menu!.style.maxHeight).toBe('648px');

    vi.restoreAllMocks();
  });
});
