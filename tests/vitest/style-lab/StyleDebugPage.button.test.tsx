import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage button lab', () => {
  it('renders a dedicated button debug tab for comparing unified button paths', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Button 调试' }));

    expect(screen.getByRole('button', { name: 'Button 调试' })).toBeInTheDocument();
    expect(screen.getByText('统一 Button 调试')).toBeInTheDocument();
    expect(screen.getByText('NotionButton / 推荐主入口')).toBeInTheDocument();
    expect(screen.getByText('shad Button / token 包装')).toBeInTheDocument();
    expect(screen.getByText('原生 button / 旧写法')).toBeInTheDocument();
    expect(screen.getByText('buttonPrimitiveContract')).toBeInTheDocument();
  });
});
