import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlockingApprovalBar } from '../BlockingApprovalBar';
import type { ToolApprovalBlockingInteraction } from '../../../core/types/store';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

function createInteraction(timeoutSeconds = 15): ToolApprovalBlockingInteraction {
  return {
    kind: 'tool_approval',
    toolCallId: 'call-countdown-1',
    toolName: 'note_set',
    arguments: { noteId: 'n1' },
    sensitivity: 'high',
    description: 'Will replace note n1',
    timeoutSeconds,
  };
}

describe('BlockingApprovalBar manual countdown pause/resume toggle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders approval-countdown-toggle as a sibling of role="timer" and freezes countdown when paused', () => {
    render(<BlockingApprovalBar interaction={createInteraction(15)} sessionId="sess-1" />);

    const timer = screen.getByRole('timer');
    const toggle = screen.getByTestId('approval-countdown-toggle');

    // Must be a sibling, NOT nested inside role="timer"
    expect(timer.contains(toggle)).toBe(false);
    expect(timer).toHaveTextContent('15s');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer).toHaveTextContent('13s');

    // Click pause manually
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(timer).toHaveTextContent('13s');
    expect(timer).toHaveTextContent('已暂停');

    // Countdown stays frozen across multiple 1s ticks even when mouse is not hovering
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(timer).toHaveTextContent('13s');
  });

  it('clears manualPaused, hoverPaused, and interactPaused together when clicking Resume', () => {
    const { container } = render(
      <BlockingApprovalBar interaction={createInteraction(12)} sessionId="sess-1" />,
    );

    const root = container.firstElementChild as HTMLElement;
    const timer = screen.getByRole('timer');
    const toggle = screen.getByTestId('approval-countdown-toggle');

    // Trigger both hoverPaused and interactPaused
    fireEvent.mouseEnter(root);
    fireEvent.keyDown(root, { key: 'Tab' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    for (let i = 0; i < 3; i += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(timer).toHaveTextContent('12s');

    // Clicking Resume clears all pause flags at once so countdown resumes immediately
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer).toHaveTextContent('10s');
  });
});
