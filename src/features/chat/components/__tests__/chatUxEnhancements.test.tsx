import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('../renderers', () => ({
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/features/chat/components/ui/TextShimmer', () => ({
  TextShimmer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

import { computeStreamingScrollRingProgress } from '../MessageList';
import {
  ActivityTimeline,
  shouldAutoCollapseTimelineOnComplete,
} from '../ActivityTimeline/ActivityTimeline';
import {
  REASONING_EFFORT_LEVELS,
  ReasoningEffortSlider,
} from '../ReasoningEffortSlider';

describe('computeStreamingScrollRingProgress', () => {
  it('follows the damped asymptotic curve bounded in [0.08, 0.92] while streaming', () => {
    expect(computeStreamingScrollRingProgress(true, 0)).toBe(0.08);
    expect(computeStreamingScrollRingProgress(true, -120)).toBe(0.08);

    const midProgress = computeStreamingScrollRingProgress(true, 900);
    expect(midProgress).toBeCloseTo(1 - Math.exp(-1), 5);
    expect(midProgress).toBeGreaterThan(0.08);
    expect(midProgress).toBeLessThan(0.92);

    const laterProgress = computeStreamingScrollRingProgress(true, 1800);
    expect(laterProgress).toBeGreaterThan(midProgress);
    expect(laterProgress).toBeCloseTo(1 - Math.exp(-2), 5);

    expect(computeStreamingScrollRingProgress(true, 20_000)).toBe(0.92);
  });

  it('clamps non-streaming scrollRatio into [0, 1]', () => {
    expect(computeStreamingScrollRingProgress(false, 500, -0.3)).toBe(0);
    expect(computeStreamingScrollRingProgress(false, 500, 0)).toBe(0);
    expect(computeStreamingScrollRingProgress(false, 500, 0.45)).toBeCloseTo(0.45, 5);
    expect(computeStreamingScrollRingProgress(false, 500, 1.4)).toBe(1);
    expect(computeStreamingScrollRingProgress(false, 500)).toBe(0);
  });
});

describe('shouldAutoCollapseTimelineOnComplete & ActivityTimeline error retention', () => {
  it('returns true when completed without error and false when hasError is true', () => {
    expect(shouldAutoCollapseTimelineOnComplete(false)).toBe(true);
    expect(shouldAutoCollapseTimelineOnComplete(true)).toBe(false);
    expect(shouldAutoCollapseTimelineOnComplete(false, true)).toBe(false);
    expect(shouldAutoCollapseTimelineOnComplete(true, true)).toBe(false);
  });

  it('auto-collapses thinking and tool groups on completion when all tools succeed', async () => {
    const thinkingRunning: Block = {
      id: 'thinking-ok',
      type: 'thinking',
      status: 'running',
      messageId: 'msg-1',
      content: '推理步骤内容',
      startedAt: 1_000,
    };
    const toolRunning1: Block = {
      id: 'tool-ok-1',
      type: 'mcp_tool',
      status: 'running',
      messageId: 'msg-1',
      toolName: 'builtin-resource_list',
      toolInput: {},
    };
    const toolRunning2: Block = {
      id: 'tool-ok-2',
      type: 'mcp_tool',
      status: 'running',
      messageId: 'msg-1',
      toolName: 'builtin-folder_list',
      toolInput: {},
    };

    const { rerender } = render(
      <ActivityTimeline
        blocks={[thinkingRunning, toolRunning1, toolRunning2]}
        isStreaming
      />,
    );

    expect(screen.getByText('推理步骤内容')).toBeInTheDocument();

    rerender(
      <ActivityTimeline
        blocks={[
          { ...thinkingRunning, status: 'success', endedAt: 3_000 },
          { ...toolRunning1, status: 'success', toolOutput: { items: [] } },
          { ...toolRunning2, status: 'success', toolOutput: { items: [] } },
        ]}
        isStreaming={false}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('推理步骤内容')).not.toBeInTheDocument();
    });
  });

  it('keeps thinking and tool groups expanded on completion when any tool fails', async () => {
    const thinkingRunning: Block = {
      id: 'thinking-err',
      type: 'thinking',
      status: 'running',
      messageId: 'msg-2',
      content: '失败前推理上下文',
      startedAt: 1_000,
    };
    const toolRunning1: Block = {
      id: 'tool-err-1',
      type: 'mcp_tool',
      status: 'running',
      messageId: 'msg-2',
      toolName: 'builtin-resource_list',
      toolInput: {},
    };
    const toolRunning2: Block = {
      id: 'tool-err-2',
      type: 'mcp_tool',
      status: 'running',
      messageId: 'msg-2',
      toolName: 'builtin-folder_list',
      toolInput: {},
    };

    const { rerender } = render(
      <ActivityTimeline
        blocks={[thinkingRunning, toolRunning1, toolRunning2]}
        isStreaming
      />,
    );

    rerender(
      <ActivityTimeline
        blocks={[
          { ...thinkingRunning, status: 'success', endedAt: 3_000 },
          { ...toolRunning1, status: 'error', error: 'ENOENT: target missing' },
          { ...toolRunning2, status: 'success', toolOutput: { items: [] } },
        ]}
        isStreaming={false}
      />,
    );

    expect(screen.getByText('失败前推理上下文')).toBeInTheDocument();
    const groupTrigger = screen.getByRole('button', { name: /timeline\.tool\.groupSummary/i });
    expect(groupTrigger).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('ReasoningEffortSlider', () => {
  it('renders all 6 effort levels with 6px track and 6px/8px nodes', () => {
    const handleChange = vi.fn();
    render(<ReasoningEffortSlider value="medium" onChange={handleChange} />);

    expect(REASONING_EFFORT_LEVELS).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);

    const track = screen.getByTestId('reasoning-effort-track');
    expect(track.className).toContain('h-[6px]');

    for (const level of REASONING_EFFORT_LEVELS) {
      const stepButton = screen.getByTestId(`reasoning-effort-step-${level}`);
      const dot = screen.getByTestId(`reasoning-effort-dot-${level}`);
      expect(stepButton).toBeInTheDocument();
      if (level === 'medium') {
        expect(stepButton).toHaveAttribute('data-active', 'true');
        expect(dot.className).toContain('h-[8px]');
        expect(dot.className).toContain('w-[8px]');
      } else {
        expect(stepButton).toHaveAttribute('data-active', 'false');
        expect(dot.className).toContain('h-[6px]');
        expect(dot.className).toContain('w-[6px]');
      }
    }
  });

  it('disables unsupported levels and blocks click events on them', () => {
    const handleChange = vi.fn();
    render(
      <ReasoningEffortSlider
        value="low"
        supportedLevels={['none', 'low', 'high', 'xhigh']}
        onChange={handleChange}
      />,
    );

    const minimalBtn = screen.getByTestId('reasoning-effort-step-minimal');
    const mediumBtn = screen.getByTestId('reasoning-effort-step-medium');
    const highBtn = screen.getByTestId('reasoning-effort-step-high');

    expect(minimalBtn).toBeDisabled();
    expect(minimalBtn).toHaveAttribute('data-supported', 'false');
    expect(mediumBtn).toBeDisabled();
    expect(highBtn).not.toBeDisabled();

    fireEvent.click(minimalBtn);
    fireEvent.click(mediumBtn);
    expect(handleChange).not.toHaveBeenCalled();

    fireEvent.click(highBtn);
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('high');
  });

  it('supports keyboard ArrowLeft/ArrowRight navigation while skipping unsupported levels', () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <ReasoningEffortSlider
        value="low"
        supportedLevels={['none', 'low', 'high', 'xhigh']}
        onChange={handleChange}
      />,
    );

    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(handleChange).toHaveBeenLastCalledWith('high');

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(handleChange).toHaveBeenLastCalledWith('none');

    rerender(
      <ReasoningEffortSlider
        value="high"
        supportedLevels={['none', 'low', 'high', 'xhigh']}
        onChange={handleChange}
      />,
    );

    fireEvent.keyDown(slider, { key: 'End' });
    expect(handleChange).toHaveBeenLastCalledWith('xhigh');

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(handleChange).toHaveBeenLastCalledWith('none');
  });
});
