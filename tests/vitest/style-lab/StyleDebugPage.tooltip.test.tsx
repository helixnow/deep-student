import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage tooltip lab', () => {
  it('renders the tooltip debug tab content', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Tooltip 调试' }));

    expect(screen.getByRole('button', { name: 'Tooltip 调试' })).toBeInTheDocument();
    expect(screen.getByText('CommonTooltip')).toBeInTheDocument();
    expect(screen.getByText('shadcn Tooltip')).toBeInTheDocument();
    expect(screen.getByText('promptkit Tooltip')).toBeInTheDocument();
    expect(screen.getByText('原生 title')).toBeInTheDocument();
  });
});
