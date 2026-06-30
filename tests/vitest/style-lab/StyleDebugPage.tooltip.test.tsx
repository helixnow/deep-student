import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage tooltip lab', () => {
  it('renders the tooltip comparison content', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '组件对比' }));
    await user.click(screen.getByRole('button', { name: 'Tooltip' }));

    expect(screen.getByText('Tooltip')).toBeInTheDocument();
    expect(screen.getByText('CommonTooltip (目标)')).toBeInTheDocument();
    expect(screen.getByText('shad Tooltip (遗留)')).toBeInTheDocument();
    expect(screen.getByText('原生 title (对照)')).toBeInTheDocument();
  });
});
