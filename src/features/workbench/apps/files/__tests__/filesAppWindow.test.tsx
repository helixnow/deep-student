/**
 * FilesAppWindow 测试（P8）
 *
 * - 双击/回车资源（LearningHubSidebar onOpenApp 回调）→ workbenchBus.launch
 *   （reason='files'，typeId 按映射表，instanceKey=resourceId）
 * - 不可开窗类型（'all'）不 launch
 * - 挂载时设置窗口标题
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceListItem } from '@/features/learning-hub/types';

const sidebarProps: Array<Record<string, unknown>> = [];
const requestWorkspaceResource = vi.hoisted(() => vi.fn(async () => 'win_notes'));

vi.mock('../../notes/workspaceRegistry', () => ({ requestWorkspaceResource }));

// LearningHubSidebar 引用链很重（Tauri 插件/DSTU 适配器），单测只验证接线
vi.mock('@/features/learning-hub', () => ({
  LearningHubSidebar: (props: Record<string, unknown>) => {
    sidebarProps.push(props);
    return <div data-testid="learning-hub-sidebar" />;
  },
}));

import FilesAppWindow, { launchResourceItem } from '../FilesAppWindow';
import '../../notes/register';
import { workbenchBus } from '../../../core/workbenchBus';
import { useWindowStore } from '../../../core/windowStore';
import type { AppWindowProps } from '../../../core/types';

function makeItem(overrides: Partial<ResourceListItem> = {}): ResourceListItem {
  return {
    id: 'note_1',
    title: '测试笔记',
    type: 'note',
    previewType: 'markdown',
    updatedAt: Date.now(),
    ...overrides,
  };
}

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

describe('FilesAppWindow', () => {
  beforeEach(() => {
    sidebarProps.length = 0;
    workbenchBus.setEnabled(true);
    requestWorkspaceResource.mockClear();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    workbenchBus.setEnabled(false);
    resetStore();
  });

  it('复用 LearningHubSidebar（fullscreen 模式）并设置标题', () => {
    const props = makeWindowProps();
    render(<FilesAppWindow {...props} />);

    expect(sidebarProps).toHaveLength(1);
    expect(sidebarProps[0].mode).toBe('fullscreen');
    expect(sidebarProps[0].onOpenApp).toBeTypeOf('function');
    expect(props.onTitleChange).toHaveBeenCalledWith(expect.any(String));
  });

  it('onOpenApp 回调（双击资源）→ 按类型映射 launch 新窗', () => {
    render(<FilesAppWindow {...makeWindowProps()} />);
    const onOpenApp = sidebarProps[0].onOpenApp as (item: ResourceListItem) => void;

    onOpenApp(makeItem({ id: 'tb_1', type: 'textbook' }));
    onOpenApp(makeItem({ id: 'mm_1', type: 'mindmap' }));

    const windows = Object.values(useWindowStore.getState().windows);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => `${w.typeId}:${w.instanceKey}`).sort()).toEqual([
      'notes:null',
      'textbook:tb_1',
    ]);
    expect(requestWorkspaceResource).toHaveBeenCalledWith({ type: 'mindmap', id: 'mm_1' });
  });

  it('连续打开不同知识资源复用单例并请求对应内部标签', () => {
    expect(launchResourceItem({ id: 'note_1', type: 'note' })).toBeTruthy();
    const first = Object.keys(useWindowStore.getState().windows);
    expect(launchResourceItem({ id: 'map_2', type: 'mindmap' })).toBe(first[0]);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(1);
    expect(requestWorkspaceResource).toHaveBeenNthCalledWith(1, { type: 'note', id: 'note_1' });
    expect(requestWorkspaceResource).toHaveBeenNthCalledWith(2, {
      type: 'mindmap',
      id: 'map_2',
    });
  });

  it('不可开窗类型不 launch', () => {
    expect(launchResourceItem({ id: 'x', type: 'all' })).toBeNull();
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
  });
});
