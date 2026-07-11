/**
 * O17 — MindmapAppWindow 骨架 / 空态集成测试
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mindmapProps: Array<Record<string, unknown>> = [];

vi.mock('@/features/mindmap/MindMapContentView', () => ({
  MindMapContentView: (props: Record<string, unknown>) => {
    mindmapProps.push(props);
    return <div data-testid="mindmap-content-view" />;
  },
}));

import MindmapAppWindow from '../MindmapAppWindow';
import type { AppWindowProps } from '../../../core/types';

function makeWindowProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'win_mm',
    instanceKey: 'mm_1',
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('MindmapAppWindow O17', () => {
  beforeEach(() => {
    mindmapProps.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders ContentEmptyState when instanceKey is missing', () => {
    render(<MindmapAppWindow {...makeWindowProps({ instanceKey: null })} />);
    expect(mindmapProps).toHaveLength(0);
    expect(document.querySelector('.wb-content-empty')).not.toBeNull();
    expect(screen.getByText(/缺少资源标识/)).toBeTruthy();
  });

  it('renderThrottleMs>0 pauses host animations without flipping MindMap isActive', () => {
    render(
      <MindmapAppWindow
        {...makeWindowProps({ isActive: true, renderThrottleMs: 500 })}
      />,
    );
    // 导图失活会同步 saveDraftSync；拖拽只挂 data-wb-render-paused
    expect(mindmapProps[0].isActive).toBe(true);
    expect(document.querySelector('[data-wb-render-paused]')).not.toBeNull();
  });

  it('shows mindmap skeleton until content reports ready', () => {
    vi.useFakeTimers();
    const onTitleChange = vi.fn();
    render(<MindmapAppWindow {...makeWindowProps({ onTitleChange })} />);

    const skeleton = document.querySelector('[data-wb-content-skeleton]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute('data-variant')).toBe('mindmap');
    expect(screen.getByTestId('mindmap-content-view')).toBeTruthy();

    const mapped = mindmapProps[0].onTitleChange as (title: string) => void;
    act(() => {
      mapped('导图标题');
    });
    expect(onTitleChange).toHaveBeenCalledWith('导图标题');
    expect(skeleton?.getAttribute('data-phase')).toBe('loading');

    const onReady = mindmapProps[0].onReady as () => void;
    act(() => {
      onReady();
    });
    expect(skeleton?.getAttribute('data-phase')).toBe('fading');

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(document.querySelector('[data-wb-content-skeleton]')).toBeNull();
    vi.useRealTimers();
  });

  it('non-active content and load errors both dismiss the skeleton', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <MindmapAppWindow {...makeWindowProps({ isActive: false })} />,
    );
    act(() => {
      (mindmapProps[0].onReady as () => void)();
      vi.advanceTimersByTime(320);
    });
    expect(document.querySelector('[data-wb-content-skeleton]')).toBeNull();
    unmount();

    mindmapProps.length = 0;
    render(<MindmapAppWindow {...makeWindowProps({ isActive: false })} />);
    act(() => {
      (mindmapProps[0].onLoadError as (message: string) => void)('load failed');
      vi.advanceTimersByTime(320);
    });
    expect(document.querySelector('[data-wb-content-skeleton]')).toBeNull();
    vi.useRealTimers();
  });
});
