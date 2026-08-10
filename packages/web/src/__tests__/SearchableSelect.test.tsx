import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SearchableSelect from '../components/SearchableSelect';

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
});
