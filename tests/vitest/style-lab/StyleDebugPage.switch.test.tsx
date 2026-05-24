import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage switch lab', () => {
  it('renders a dedicated switch debug tab with token and compact native switch samples', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Switch 调试' }));

    expect(screen.getByRole('button', { name: 'Switch 调试' })).toBeInTheDocument();
    expect(screen.getByText('统一 Switch 调试')).toBeInTheDocument();
    expect(screen.getByText('shad Switch / token path')).toBeInTheDocument();
    expect(screen.getByText('贴近当前截图的原生 switch')).toBeInTheDocument();
    expect(screen.getByText('28px / 16px compact')).toBeInTheDocument();
    expect(screen.getByText('现成库 Switch 方案')).toBeInTheDocument();
    expect(screen.getByText('Radix / shadcn 主路径')).toBeInTheDocument();
    expect(screen.getByText('Radix Themes')).toBeInTheDocument();
    expect(screen.getByText('Base UI')).toBeInTheDocument();
    expect(screen.getByText('React Aria Components')).toBeInTheDocument();
  });
});
