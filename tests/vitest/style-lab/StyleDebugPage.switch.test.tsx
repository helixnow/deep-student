import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage switch lab', () => {
  it('renders switch coverage in the current component comparison tab', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '组件对比' }));
    await user.click(screen.getByRole('button', { name: 'Form Controls' }));

    expect(screen.getByText('Form Controls')).toBeInTheDocument();
    expect(screen.getByText('Switch')).toBeInTheDocument();
    expect(screen.getByText('默认 44×24 / sm 28×16')).toBeInTheDocument();
    expect(screen.getByText('legacy mini (已被 sm 变体取代)')).toBeInTheDocument();
    expect(screen.getByText(/Switch 新增/)).toBeInTheDocument();
  });
});
