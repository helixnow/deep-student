/**
 * O17 — files 侧桌面拖放桥 / 视图过渡 / 窗口接线测试
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceListItem } from '@/features/learning-hub/types';

const sidebarProps: Array<Record<string, unknown>> = [];

vi.mock('@/features/learning-hub', () => ({
  LearningHubSidebar: (props: Record<string, unknown>) => {
    sidebarProps.push(props);
    return (
      <div data-testid="learning-hub-sidebar">
        <div data-finder-item data-item-id="note_1" />
      </div>
    );
  },
}));

vi.mock('@/features/learning-hub/stores/finderStore', () => {
  const state = {
    viewMode: 'grid' as 'grid' | 'list',
    items: [
      { id: 'note_1', name: '测试笔记', type: 'note', path: '/note_1' },
      { id: 'folder_1', name: '文件夹', type: 'folder', path: '/folder_1' },
    ],
    setViewMode(mode: 'grid' | 'list') {
      state.viewMode = mode;
      listeners.forEach((l) => l());
    },
  };
  const listeners = new Set<() => void>();
  const useFinderStore = (selector: (s: typeof state) => unknown) => {
    const [, force] = React.useState(0);
    React.useEffect(() => {
      const l = () => force((n) => n + 1);
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }, []);
    return selector(state);
  };
  useFinderStore.getState = () => state;
  return { useFinderStore, ViewMode: undefined };
});

import FilesAppWindow, { launchResourceItem } from '../FilesAppWindow';
import {
  clearDesktopResourceDropHandler,
  handleDesktopResourceDrop,
  launchResourceFromDragData,
  registerDesktopResourceDropHandler,
  setWorkbenchDragData,
  parseWorkbenchDragData,
  WB_RESOURCE_MIME,
} from '../desktopDragBridge';
import { useFilesViewTransition } from '../useFilesViewTransition';
import { workbenchBus } from '../../../core/workbenchBus';
import { useWindowStore } from '../../../core/windowStore';
import type { AppWindowProps } from '../../../core/types';
import { useFinderStore } from '@/features/learning-hub/stores/finderStore';

function makeWindowProps(): AppWindowProps {
  return {
    windowId: 'win_files',
    instanceKey: null,
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
  };
}

function resetStore(): void {
  const state = useWindowStore.getState();
  for (const id of Object.keys(state.windows)) {
    state.closeWindow(id);
  }
}

describe('desktopDragBridge', () => {
  beforeEach(() => {
    workbenchBus.setEnabled(true);
    resetStore();
    clearDesktopResourceDropHandler();
  });

  afterEach(() => {
    clearDesktopResourceDropHandler();
    workbenchBus.setEnabled(false);
    resetStore();
  });

  it('re-exports O19 MIME helpers with round-trip', () => {
    const dt = {
      data: {} as Record<string, string>,
      effectAllowed: 'none',
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    } as unknown as DataTransfer;

    setWorkbenchDragData(dt, {
      resourceId: 'note_1',
      resourceType: 'note',
      title: '笔记',
    });
    expect(dt.getData(WB_RESOURCE_MIME)).toContain('note_1');
    expect(parseWorkbenchDragData(dt)?.resourceId).toBe('note_1');
  });

  it('launchResourceFromDragData opens mapped app; folder returns null', () => {
    expect(
      launchResourceFromDragData({
        resourceId: 'note_1',
        resourceType: 'note',
        title: 'n',
      }),
    ).toBeTruthy();
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(1);

    expect(
      launchResourceFromDragData({
        resourceId: 'folder_1',
        resourceType: 'folder',
        title: 'f',
      }),
    ).toBeNull();
  });

  it('registered handler wins; false falls back to launch', async () => {
    const handled: string[] = [];
    registerDesktopResourceDropHandler((ctx) => {
      handled.push(ctx.resource.resourceId);
      return true;
    });
    await handleDesktopResourceDrop({
      resource: { resourceId: 'note_9', resourceType: 'note', title: 'x' },
    });
    expect(handled).toEqual(['note_9']);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);

    clearDesktopResourceDropHandler();
    registerDesktopResourceDropHandler(() => false);
    await handleDesktopResourceDrop({
      resource: { resourceId: 'tb_1', resourceType: 'textbook', title: 't' },
    });
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(1);
  });

  it('unregistered handler falls back to launch', async () => {
    await handleDesktopResourceDrop({
      resource: { resourceId: 'mm_1', resourceType: 'mindmap', title: 'm' },
    });
    const windows = Object.values(useWindowStore.getState().windows);
    expect(windows).toHaveLength(1);
    expect(windows[0].typeId).toBe('mindmap');
  });
});

describe('useFilesViewTransition', () => {
  afterEach(() => cleanup());

  it('sets transition attribute when viewMode changes', () => {
    vi.useFakeTimers();
    const viewport = document.createElement('div');
    document.body.appendChild(viewport);
    const viewportRef = { current: viewport };

    renderHook(() => useFilesViewTransition(viewportRef, true));

    act(() => {
      (useFinderStore.getState() as { setViewMode: (m: 'grid' | 'list') => void }).setViewMode(
        'list',
      );
    });

    expect(viewport.getAttribute('data-wb-files-view-transition')).toBe('flip');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(viewport.getAttribute('data-wb-files-view-transition')).toBeNull();

    viewport.remove();
    vi.useRealTimers();
  });
});

describe('FilesAppWindow O17 shell', () => {
  beforeEach(() => {
    sidebarProps.length = 0;
    workbenchBus.setEnabled(true);
    resetStore();
  });

  afterEach(() => {
    cleanup();
    workbenchBus.setEnabled(false);
    resetStore();
  });

  it('wraps sidebar in wb-files host/viewport', () => {
    render(<FilesAppWindow {...makeWindowProps()} />);
    expect(document.querySelector('[data-wb-files-host]')).not.toBeNull();
    expect(document.querySelector('[data-wb-files-viewport]')).not.toBeNull();
    expect(sidebarProps[0].mode).toBe('fullscreen');
  });

  it('keeps launchResourceItem behavior', () => {
    expect(launchResourceItem({ id: 'note_1', type: 'note' } as ResourceListItem)).toBeTruthy();
    expect(launchResourceItem({ id: 'x', type: 'all' } as ResourceListItem)).toBeNull();
  });
});
