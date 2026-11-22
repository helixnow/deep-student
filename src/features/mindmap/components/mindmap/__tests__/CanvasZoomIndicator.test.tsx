import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { zoomToMock, isMacOSMock } = vi.hoisted(() => ({
  zoomToMock: vi.fn(),
  isMacOSMock: vi.fn(() => true),
}));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ zoomTo: zoomToMock }),
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1.25] }),
}));

vi.mock('@/utils/platform', () => ({
  isMacOS: isMacOSMock,
}));

vi.mock('@/styles/motion-springs', () => ({
  prefersReducedMotion: () => true,
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({
    content,
    shortcut,
    children,
  }: {
    content: React.ReactNode;
    shortcut?: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="zoom-tooltip" data-content={String(content)} data-shortcut={shortcut ?? ''}>
      {children}
    </div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; percent?: number; fitShortcut?: string }) =>
      (opts?.defaultValue ?? _key)
        .replace('{{percent}}', String(opts?.percent ?? ''))
        .replace('{{fitShortcut}}', String(opts?.fitShortcut ?? '')),
  }),
}));

import { CanvasZoomIndicator } from '../CanvasZoomIndicator';

describe('CanvasZoomIndicator', () => {
  afterEach(() => {
    cleanup();
    zoomToMock.mockReset();
  });

  it('shows ⌘1 reset shortcut and ⌘0 fit-canvas hint on macOS and resets zoom on click', () => {
    isMacOSMock.mockReturnValue(true);
    render(<CanvasZoomIndicator />);

    const tooltip = screen.getByTestId('zoom-tooltip');
    expect(tooltip.dataset.shortcut).toBe('⌘1');
    expect(tooltip.dataset.content).toContain('100%');
    expect(tooltip.dataset.content).toContain('⌘0');

    const btn = screen.getByRole('button', { name: /125%/ });
    fireEvent.click(btn);
    expect(zoomToMock).toHaveBeenCalledWith(1, { duration: 0 });
  });

  it('shows Ctrl+1 reset shortcut and Ctrl+0 fit-canvas hint on non-macOS', () => {
    isMacOSMock.mockReturnValue(false);
    render(<CanvasZoomIndicator />);

    const tooltip = screen.getByTestId('zoom-tooltip');
    expect(tooltip.dataset.shortcut).toBe('Ctrl+1');
    expect(tooltip.dataset.content).toContain('100%');
    expect(tooltip.dataset.content).toContain('Ctrl+0');
  });
});
