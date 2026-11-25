/**
 * O17 — MindmapAppWindow 骨架 / 空态集成测试
 */
import React from 'react';
import JSZip from 'jszip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mindmapProps, createEmptyMock, dstuCreateMock, notifyMock } = vi.hoisted(() => ({
  mindmapProps: [] as Array<Record<string, unknown>>,
  createEmptyMock: vi.fn(),
  dstuCreateMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@/features/mindmap/MindMapContentView', () => ({
  MindMapContentView: (props: Record<string, unknown>) => {
    mindmapProps.push(props);
    return <div data-testid="mindmap-content-view" data-resource-id={String(props.resourceId ?? '')} />;
  },
}));

vi.mock('@/dstu', () => ({
  createEmpty: (...args: unknown[]) => createEmptyMock(...args),
  dstu: {
    create: (...args: unknown[]) => dstuCreateMock(...args),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock('@/utils/platform', () => ({
  isAndroidMobileShell: () => false,
  isWebUiShell: () => true,
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
    createEmptyMock.mockReset();
    dstuCreateMock.mockReset();
    notifyMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders ContentEmptyState with New and Import actions when instanceKey is missing', () => {
    render(<MindmapAppWindow {...makeWindowProps({ instanceKey: null })} />);
    expect(mindmapProps).toHaveLength(0);
    expect(document.querySelector('.wb-content-empty')).not.toBeNull();
    expect(screen.getByText(/缺少资源标识/)).toBeTruthy();
    expect(screen.getByTestId('mm-empty-create-btn')).toBeTruthy();
    expect(screen.getByTestId('mm-empty-import-btn')).toBeTruthy();
  });

  it('creates a new mind map from empty state and opens it in-place', async () => {
    createEmptyMock.mockResolvedValueOnce({
      ok: true,
      value: { id: 'mm_created_1', name: '未命名导图' },
    });
    const onTitleChange = vi.fn();
    render(<MindmapAppWindow {...makeWindowProps({ instanceKey: null, onTitleChange })} />);

    fireEvent.click(screen.getByTestId('mm-empty-create-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mindmap-content-view')).toHaveAttribute('data-resource-id', 'mm_created_1');
    });
    expect(createEmptyMock).toHaveBeenCalledWith({ type: 'mindmap' });
    expect(onTitleChange).toHaveBeenCalledWith('未命名导图');
  });

  it('imports a .xmind file directly from empty state and opens the created mind map', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([
      {
        rootTopic: {
          id: 'root_1',
          title: 'Neuroscience',
          children: { attached: [{ id: 'synapse', title: 'Synaptic Plasticity' }] },
        },
      },
    ]));
    const xmindBytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File([xmindBytes as BlobPart], 'neuro.xmind', { type: '' });

    dstuCreateMock.mockResolvedValueOnce({
      ok: true,
      value: { id: 'mm_xmind_1', name: 'Neuroscience' },
    });

    const onTitleChange = vi.fn();
    render(<MindmapAppWindow {...makeWindowProps({ instanceKey: null, onTitleChange })} />);

    const input = screen.getByTestId('mm-empty-import-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('mindmap-content-view')).toHaveAttribute('data-resource-id', 'mm_xmind_1');
    });
    expect(dstuCreateMock).toHaveBeenCalledWith(
      '/',
      expect.objectContaining({
        type: 'mindmap',
        name: 'Neuroscience',
        metadata: { defaultView: 'mindmap' },
      }),
    );
    expect(onTitleChange).toHaveBeenCalledWith('Neuroscience');
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
