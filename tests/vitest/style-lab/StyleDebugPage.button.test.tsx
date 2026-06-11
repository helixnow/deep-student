import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage button lab', () => {
  it('renders the current component comparison tab with unified button paths', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '组件对比' }));

    expect(screen.getByRole('button', { name: '组件对比' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Button')).toBeInTheDocument();
    expect(screen.getByText('NotionButton (目标)')).toBeInTheDocument();
    expect(screen.getByText('shad Button (遗留)')).toBeInTheDocument();
    expect(screen.getByText('原生 button')).toBeInTheDocument();
    expect(screen.getByText(/buttonPrimitiveContract/)).toBeInTheDocument();
  });
});
