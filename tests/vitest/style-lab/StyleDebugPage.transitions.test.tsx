import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage transitions lab', () => {
  it('renders the current token inspector tab with visual token groups', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Token 校对' }));

    expect(screen.getByRole('button', { name: 'Token 校对' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByPlaceholderText('搜索 token 名称…')).toBeInTheDocument();
    expect(screen.getByText('Surface 层级')).toBeInTheDocument();
    expect(screen.getByText('阴影')).toBeInTheDocument();
    expect(screen.getByText('圆角')).toBeInTheDocument();
    expect(screen.getByText('--shadow-shell-soft')).toBeInTheDocument();
    expect(screen.getByText('--radius-shell-panel')).toBeInTheDocument();
  });
});
