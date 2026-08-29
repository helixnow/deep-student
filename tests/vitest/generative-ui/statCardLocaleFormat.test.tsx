import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { StatCardBlock } from '@/features/generative-ui/components/StatCardBlock';
import { formatGenerativeStatValue } from '@/features/generative-ui/utils/formatGenerativeNumber';

describe('StatCardBlock locale format', () => {
  it('renders a formatted numeric value on data-stat-value', () => {
    const expected = formatGenerativeStatValue(1200);
    render(<StatCardBlock title="Due" value={1200} />);

    const valueEl = document.querySelector('[data-stat-value]');
    expect(valueEl).toBeTruthy();
    expect(valueEl).toHaveAttribute('data-stat-value', expected);
    expect(valueEl).toHaveTextContent(expected);
    expect(valueEl).toHaveClass('tabular-nums');
    expect(screen.getByRole('region', { name: 'Due' })).toBeInTheDocument();
  });

  it('leaves a non-numeric string value as-is', () => {
    render(<StatCardBlock title="Due" value="hello" />);

    const valueEl = document.querySelector('[data-stat-value]');
    expect(valueEl).toHaveAttribute('data-stat-value', 'hello');
    expect(valueEl).toHaveTextContent('hello');
  });
});
