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
import { useResourceDragOut } from '../useResourceDragOut';
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

function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { pointerId: number; clientX: number; clientY: number; button?: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  target.dispatchEvent(event);
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
      types: [] as string[],
      effectAllowed: 'none',
      setData(type: string, value: string) {
        this.data[type] = value;
        if (!this.types.includes(type)) this.types.push(type);
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

  it('registered handler wins; false/void fall back to launch', async () => {
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

    clearDesktopResourceDropHandler();
    registerDesktopResourceDropHandler(
      (() => undefined) as unknown as Parameters<
        typeof registerDesktopResourceDropHandler
      >[0],
    );
    await handleDesktopResourceDrop({
      resource: { resourceId: 'essay_1', resourceType: 'essay', title: 'e' },
    });
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(2);
  });

  it('throw/reject handler 均记录异常并可靠回退，不向调用方泄漏 rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerDesktopResourceDropHandler(() => {
      throw new Error('sync handler failure');
    });
    await expect(
      handleDesktopResourceDrop({
        resource: { resourceId: 'note_throw', resourceType: 'note', title: 'throw' },
      }),
    ).resolves.toBe(true);

    clearDesktopResourceDropHandler();
    registerDesktopResourceDropHandler(async () => {
      throw new Error('async handler failure');
    });
    await expect(
      handleDesktopResourceDrop({
        resource: { resourceId: 'note_reject', resourceType: 'note', title: 'reject' },
      }),
    ).resolves.toBe(true);

    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('将 desktop-relative point 传入 handler 与 launch contract', async () => {
    const point = { x: 210, y: 140, clientX: 250, clientY: 180 };
    const handler = vi.fn(() => true);
    registerDesktopResourceDropHandler(handler);
    await handleDesktopResourceDrop({
      resource: { resourceId: ' note_point ', resourceType: ' note ', title: ' Point ' },
      point,
      sourceWindowId: 'win_files',
    });
    expect(handler).toHaveBeenCalledWith({
      resource: { resourceId: 'note_point', resourceType: 'note', title: 'Point' },
      point,
      sourceWindowId: 'win_files',
    });

    clearDesktopResourceDropHandler();
    const launchSpy = vi.spyOn(workbenchBus, 'launch');
    const launchPoint = { x: 700, y: 450, clientX: 740, clientY: 490 };
    await handleDesktopResourceDrop({
      resource: { resourceId: 'note_launch_point', resourceType: 'note', title: 'Point' },
      point: launchPoint,
    });
    expect(launchSpy).toHaveBeenCalledWith({
      typeId: 'note',
      instanceKey: 'note_launch_point',
      dropPoint: { x: 700, y: 450 },
      reason: 'files',
    });

    const opened = Object.values(useWindowStore.getState().windows).find(
      (win) => win.instanceKey === 'note_launch_point',
    );
    expect(opened).toBeDefined();
    expect(opened!.frame.x + opened!.frame.w / 2).toBe(launchPoint.x);
    expect(opened!.frame.y + opened!.frame.h / 2).toBe(launchPoint.y);

    const originalFrame = { ...opened!.frame };
    await handleDesktopResourceDrop({
      resource: { resourceId: 'note_launch_point', resourceType: 'note', title: 'Point' },
      point: { x: 1100, y: 750, clientX: 1140, clientY: 790 },
    });
    expect(useWindowStore.getState().windows[opened!.id].frame).toEqual(originalFrame);
    launchSpy.mockRestore();
  });

  it('invalid runtime resource payload is rejected before handler or launch', async () => {
    const handler = vi.fn(() => true);
    registerDesktopResourceDropHandler(handler);
    const launchSpy = vi.spyOn(workbenchBus, 'launch');
    await expect(
      handleDesktopResourceDrop({
        resource: { resourceId: '', resourceType: 'note', title: 'bad' },
      }),
    ).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    launchSpy.mockRestore();
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

describe('useResourceDragOut pointer landing', () => {
  beforeEach(() => {
    workbenchBus.setEnabled(true);
    resetStore();
    clearDesktopResourceDropHandler();
  });

  afterEach(() => {
    cleanup();
    clearDesktopResourceDropHandler();
    workbenchBus.setEnabled(false);
    resetStore();
    document.querySelectorAll('[data-pointer-drop-fixture]').forEach((node) => node.remove());
  });

  it('仅空白桌面触发；窗口、Dock、桌面外落点均拒绝，并传递转换后的坐标', async () => {
    const desktop = document.createElement('div');
    desktop.setAttribute('data-wb-desktop', '');
    desktop.setAttribute('data-pointer-drop-fixture', '');
    const sourceWindow = document.createElement('div');
    sourceWindow.setAttribute('data-wb-window', '');
    const host = document.createElement('div');
    const item = document.createElement('div');
    item.setAttribute('data-finder-item', '');
    item.setAttribute('data-item-id', 'note_1');
    host.appendChild(item);
    sourceWindow.appendChild(host);

    const otherWindow = document.createElement('div');
    otherWindow.setAttribute('data-wb-window', '');
    const dock = document.createElement('div');
    dock.setAttribute('data-testid', 'wb-dock');
    desktop.append(sourceWindow, otherWindow, dock);
    document.body.appendChild(desktop);

    vi.spyOn(desktop, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      top: 30,
      right: 1020,
      bottom: 730,
      width: 1000,
      height: 700,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    } as DOMRect);

    let hit: Element | null = desktop;
    const originalDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => hit,
    });

    const handler = vi.fn(() => true);
    registerDesktopResourceDropHandler(handler);
    const hook = renderHook(() =>
      useResourceDragOut({ hostRef: { current: host }, windowId: 'win_files' }),
    );

    const runDrag = async (pointerId: number, landing: Element | null) => {
      hit = landing;
      act(() => {
        dispatchPointer(item, 'pointerdown', {
          pointerId,
          clientX: 100,
          clientY: 100,
        });
        dispatchPointer(window, 'pointermove', {
          pointerId,
          clientX: 420,
          clientY: 260,
        });
        dispatchPointer(window, 'pointerup', {
          pointerId,
          clientX: 420,
          clientY: 260,
        });
      });
      await Promise.resolve();
    };

    try {
      await runDrag(1, desktop);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(handler).toHaveBeenLastCalledWith({
        resource: { resourceId: 'note_1', resourceType: 'note', title: '测试笔记' },
        point: { x: 400, y: 230, clientX: 420, clientY: 260 },
        sourceWindowId: 'win_files',
      });

      await runDrag(2, otherWindow);
      await runDrag(3, dock);
      await runDrag(4, null);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
      if (originalDescriptor) {
        Object.defineProperty(document, 'elementFromPoint', originalDescriptor);
      } else {
        delete (document as Document & { elementFromPoint?: unknown }).elementFromPoint;
      }
    }
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
