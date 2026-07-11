/**
 * 内容应用工厂测试（P8）
 *
 * - AppWindowProps → UnifiedAppPanel props 映射正确（复用同一组件，零复制）
 * - instanceKey 缺失时渲染占位而不是崩溃
 * - canClose 未保存拦截：干净放行 / 脏 + 确认 / 脏 + 取消
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const panelProps: Array<Record<string, unknown>> = [];

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    panelProps.push(props);
    return <div data-testid="unified-app-panel" />;
  },
}));

import { createContentWindowComponent } from '../ContentAppWindow';
import { createContentApp } from '../createContentApp';
import {
  __resetContentDirtyRegistry,
  isContentDirty,
  registerContentDirtyChecker,
} from '../contentDirtyRegistry';
import type { AppWindowProps } from '../../../core/types';
import { useWindowStore } from '../../../core/windowStore';

function makeWindowProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'win_1',
    instanceKey: 'note_123',
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('createContentWindowComponent', () => {
  beforeEach(() => {
    panelProps.length = 0;
    const store = useWindowStore.getState();
    for (const id of Object.keys(store.windows)) store.closeWindow(id);
  });

  afterEach(() => {
    cleanup();
    const store = useWindowStore.getState();
    for (const id of Object.keys(store.windows)) store.closeWindow(id);
  });

  it('把 AppWindowProps 映射为 UnifiedAppPanel props', () => {
    const NoteWindow = createContentWindowComponent('note');
    const props = makeWindowProps();
    render(<NoteWindow {...props} />);

    expect(panelProps).toHaveLength(1);
    const mapped = panelProps[0];
    expect(mapped.type).toBe('note');
    expect(mapped.resourceId).toBe('note_123');
    expect(mapped.dstuPath).toBe('/note_123');
    expect(mapped.strictType).toBe(true);
    expect(mapped.isActive).toBe(true);
    // O17 wraps onTitleChange（首调 markReady）；仍须转发到壳回调
    expect(mapped.onTitleChange).toBeTypeOf('function');
    expect(mapped.onTitleChange).not.toBe(props.onTitleChange);
    (mapped.onTitleChange as (title: string) => void)('标题');
    expect(props.onTitleChange).toHaveBeenCalledWith('标题');
    expect(mapped.onClose).toBe(props.requestClose);
    expect(screen.getByTestId('unified-app-panel')).toBeTruthy();
  });

  it('把完整 DSTU 路径规范化为叶资源 ID', () => {
    const NoteWindow = createContentWindowComponent('note');
    render(<NoteWindow {...makeWindowProps({ instanceKey: '/folder/sub/note_123' })} />);

    expect(panelProps[0].resourceId).toBe('note_123');
    expect(panelProps[0].dstuPath).toBe('/note_123');
  });

  it('同类型路径别名窗口只保留最早实例', () => {
    const store = useWindowStore.getState();
    const keeper = store.openWindow({ typeId: 'note', instanceKey: '/folder/note_123' });
    const duplicate = store.openWindow({ typeId: 'note', instanceKey: 'note_123' });
    const NoteWindow = createContentWindowComponent('note');

    render(<NoteWindow {...makeWindowProps({ windowId: duplicate, instanceKey: 'note_123' })} />);

    expect(useWindowStore.getState().windows[keeper]).toBeDefined();
    expect(useWindowStore.getState().windows[duplicate]).toBeUndefined();
  });

  it('isActive=false 透传（visible 非焦点窗口不冒充活跃标签页）', () => {
    const ExamWindow = createContentWindowComponent('exam');
    render(<ExamWindow {...makeWindowProps({ isActive: false, instanceKey: 'exam_9' })} />);
    expect(panelProps[0].type).toBe('exam');
    expect(panelProps[0].isActive).toBe(false);
  });

  it('renderThrottleMs>0 时挂 data-wb-render-paused，且不翻转 isActive', () => {
    const PdfWindow = createContentWindowComponent('pdf');
    render(
      <PdfWindow
        {...makeWindowProps({
          isActive: true,
          instanceKey: 'pdf_1',
          renderThrottleMs: 500,
        })}
      />,
    );
    // 内容窗失活会停秒表/卸键盘；拖拽只冻动画
    expect(panelProps[0].isActive).toBe(true);
    expect(document.querySelector('[data-wb-render-paused]')).not.toBeNull();
  });

  it('instanceKey 缺失渲染 ContentEmptyState，不渲染面板', () => {
    const NoteWindow = createContentWindowComponent('note');
    const { container } = render(<NoteWindow {...makeWindowProps({ instanceKey: null })} />);
    expect(panelProps).toHaveLength(0);
    expect(container.querySelector('.wb-content-empty')).not.toBeNull();
    expect(container.textContent).toContain('缺少资源标识');
  });

  it('有资源时挂载骨架宿主与 UnifiedAppPanel', () => {
    const NoteWindow = createContentWindowComponent('note');
    render(<NoteWindow {...makeWindowProps()} />);
    expect(document.querySelector('[data-wb-content-host]')).not.toBeNull();
    expect(document.querySelector('[data-wb-content-skeleton]')).not.toBeNull();
    expect(screen.getByTestId('unified-app-panel')).toBeTruthy();
  });
});

describe('createContentApp', () => {
  beforeEach(() => {
    __resetContentDirtyRegistry();
  });

  const baseOptions = {
    typeId: 'essay' as const,
    nameKey: 'workbench:apps.essay',
    icon: null,
    memoryWeight: 2 as const,
    defaultFrame: { w: 800, h: 600 },
  };

  it('默认 multi + 缺省 minSize', () => {
    const def = createContentApp(baseOptions);
    expect(def.instanceMode).toBe('multi');
    expect(def.memoryWeight).toBe(2);
    expect(def.minSize).toEqual({ w: 360, h: 280 });
    expect(def.canClose).toBeUndefined();
  });

  it('canClose：无脏状态直接放行', () => {
    const def = createContentApp({ ...baseOptions, confirmUnsavedOnClose: true });
    expect(def.canClose?.('essay_1')).toBe(true);
  });

  it('canClose：脏状态弹确认，确认放行 / 取消阻止', () => {
    const def = createContentApp({ ...baseOptions, confirmUnsavedOnClose: true });
    const unregister = registerContentDirtyChecker('essay', 'essay_1', () => true);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(def.canClose?.('essay_1')).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    confirmSpy.mockReturnValue(false);
    expect(def.canClose?.('essay_1')).toBe(false);

    // 其他实例不受影响
    expect(def.canClose?.('essay_other')).toBe(true);

    unregister();
    expect(def.canClose?.('essay_1')).toBe(true);
    confirmSpy.mockRestore();
  });

  it('同一资源的多个 checker 聚合，且路径别名共享 dirty 状态', () => {
    const unregisterBody = registerContentDirtyChecker('note', 'note_multi', () => false);
    const unregisterTitle = registerContentDirtyChecker('note', '/folder/note_multi', () => true);

    expect(isContentDirty('note', '/note_multi')).toBe(true);
    unregisterTitle();
    expect(isContentDirty('note', 'note_multi')).toBe(false);
    unregisterBody();
  });
});
