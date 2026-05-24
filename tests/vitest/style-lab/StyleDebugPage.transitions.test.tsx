import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage transitions lab', () => {
  it('renders a dedicated transitions.dev demo tab with documented transition hooks', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Transition 动效' }));

    expect(screen.getByRole('button', { name: 'Transition 动效' })).toBeInTheDocument();
    expect(screen.getByText('transitions.dev 动效调试')).toBeInTheDocument();
    expect(screen.getByText('Card resize')).toBeInTheDocument();
    expect(screen.getByText('Menu dropdown')).toBeInTheDocument();
    expect(screen.getByText('Page side-by-side')).toBeInTheDocument();
    expect(screen.getByText('Number pop-in')).toBeInTheDocument();
    expect(screen.getByText('Text states swap')).toBeInTheDocument();
    expect(screen.getByText('Icon swap')).toBeInTheDocument();

    expect(document.querySelector('.t-resize')).toBeInTheDocument();
    expect(document.querySelector('.t-dropdown')).toBeInTheDocument();
    expect(document.querySelector('.t-page-slide')).toBeInTheDocument();
    expect(document.querySelector('.t-digit-group')).toBeInTheDocument();
    expect(document.querySelector('.t-text-swap')).toBeInTheDocument();
    expect(document.querySelector('.t-icon-swap')).toBeInTheDocument();
  });
});
