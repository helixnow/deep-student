import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: { get: () => undefined, subscribe: () => vi.fn() },
}));
vi.mock('../ChatSessionSurface', () => ({
  ChatSessionSurface: ({ isSuspended = false }: { isSuspended?: boolean }) => (
    <div data-testid="session-surface" data-suspended={String(isSuspended)} />
  ),
}));

import { ChatSessionWindow } from '../ChatSessionWindow';

describe('ChatSessionWindow suspension', () => {
  it('forwards background suspension and its recovery to the session surface', () => {
    const props = {
      windowId: 'window-1', instanceKey: 'session-1', isActive: false,
      isVisible: false, onTitleChange: vi.fn(), requestClose: vi.fn(),
    };
    const { rerender } = render(<ChatSessionWindow {...props} isSuspended />);
    expect(screen.getByTestId('session-surface').getAttribute('data-suspended')).toBe('true');
    rerender(<ChatSessionWindow {...props} isVisible isSuspended={false} />);
    expect(screen.getByTestId('session-surface').getAttribute('data-suspended')).toBe('false');
  });
});
