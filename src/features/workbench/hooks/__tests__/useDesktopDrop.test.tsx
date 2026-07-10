/**
 * O19 拖放 hook 测试：落点态直写 DOM / enter-leave 计数 / accept 谓词 /
 * 三类负载解析 / 拖源辅助往返
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import {
  useDesktopDrop,
  setWorkbenchDragData,
  parseWorkbenchDragData,
  WB_RESOURCE_MIME,
  type WorkbenchDropPayload,
  type WorkbenchDropState,
} from '../useDesktopDrop';

interface FakeDataTransferInit {
  data?: Record<string, string>;
  files?: File[];
}

function makeDataTransfer(init: FakeDataTransferInit = {}): DataTransfer {
  const data: Record<string, string> = { ...(init.data ?? {}) };
  const files = init.files ?? [];
  const types = [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])];
  return {
    types,
    files,
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: (type: string) => data[type] ?? '',
    setData: (type: string, value: string) => {
      data[type] = value;
      if (!types.includes(type)) types.push(type);
    },
  } as unknown as DataTransfer;
}

const resourceJson = JSON.stringify({ resourceId: 'note_1', resourceType: 'note' });

/** jsdom 无 DragEvent 构造器，fireEvent.drop 会丢 clientX/Y；手工派发带坐标的 drop */
function dispatchDrop(
  el: HTMLElement,
  dataTransfer: DataTransfer,
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  el.dispatchEvent(event);
}

describe('useDesktopDrop', () => {
  let target: HTMLElement;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    target.remove();
  });

  it('资源拖入 → over 态直写 DOM（类 + data 属性），离开复位', () => {
    const states: WorkbenchDropState[] = [];
    renderHook(() =>
      useDesktopDrop({
        target,
        onDrop: () => {},
        onDragStateChange: (s) => states.push(s),
      }),
    );

    const dataTransfer = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });
    fireEvent.dragEnter(target, { dataTransfer });
    expect(target.getAttribute('data-wb-drop-state')).toBe('over');
    expect(target.classList.contains('wb-cursor-drop-over')).toBe(true);

    fireEvent.dragLeave(target, { dataTransfer });
    expect(target.hasAttribute('data-wb-drop-state')).toBe(false);
    expect(target.classList.contains('wb-cursor-drop-over')).toBe(false);
    expect(states).toEqual(['over', 'idle']);
  });

  it('子元素间 enter/leave 抖动不闪烁（计数）', () => {
    renderHook(() => useDesktopDrop({ target, onDrop: () => {} }));
    const dataTransfer = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });

    fireEvent.dragEnter(target, { dataTransfer }); // 进入容器
    fireEvent.dragEnter(target, { dataTransfer }); // 进入子元素（冒泡）
    fireEvent.dragLeave(target, { dataTransfer }); // 离开子元素
    expect(target.getAttribute('data-wb-drop-state')).toBe('over');

    fireEvent.dragLeave(target, { dataTransfer }); // 真正离开
    expect(target.hasAttribute('data-wb-drop-state')).toBe(false);
  });

  it('dragover 声明 dropEffect，accept 拒绝时 denied + none', () => {
    renderHook(() =>
      useDesktopDrop({
        target,
        onDrop: () => {},
        dropEffect: 'move',
        accept: (info) => info.hasResource,
      }),
    );

    const ok = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });
    fireEvent.dragOver(target, { dataTransfer: ok });
    expect(ok.dropEffect).toBe('move');
    expect(target.getAttribute('data-wb-drop-state')).toBe('over');

    const denied = makeDataTransfer({ data: { 'text/plain': 'hi' } });
    fireEvent.dragOver(target, { dataTransfer: denied });
    expect(denied.dropEffect).toBe('none');
    expect(target.getAttribute('data-wb-drop-state')).toBe('denied');
    expect(target.classList.contains('wb-cursor-drop-denied')).toBe(true);
  });

  it('drop 解析内部资源负载并给出相对落点', () => {
    const drops: Array<{ payload: WorkbenchDropPayload; x: number; y: number }> = [];
    renderHook(() =>
      useDesktopDrop({
        target,
        onDrop: (payload, point) => drops.push({ payload, x: point.x, y: point.y }),
      }),
    );
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      right: 500,
      bottom: 400,
      width: 400,
      height: 350,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);

    const dataTransfer = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });
    dispatchDrop(target, dataTransfer, 220, 130);

    expect(drops).toHaveLength(1);
    expect(drops[0].payload).toEqual({
      kind: 'resource',
      resource: { resourceId: 'note_1', resourceType: 'note' },
    });
    expect(drops[0].x).toBe(120);
    expect(drops[0].y).toBe(80);
    // drop 后视觉态复位
    expect(target.hasAttribute('data-wb-drop-state')).toBe(false);
  });

  it('drop 解析 OS 文件负载', () => {
    const drops: WorkbenchDropPayload[] = [];
    renderHook(() => useDesktopDrop({ target, onDrop: (p) => drops.push(p) }));

    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const dataTransfer = makeDataTransfer({ files: [file] });
    fireEvent.drop(target, { dataTransfer, clientX: 0, clientY: 0 });

    expect(drops).toHaveLength(1);
    expect(drops[0].kind).toBe('os-files');
    if (drops[0].kind === 'os-files') {
      expect(drops[0].files[0].name).toBe('a.pdf');
    }
  });

  it('accept 拒绝的拖拽 drop 不触发 onDrop', () => {
    const onDrop = vi.fn();
    renderHook(() =>
      useDesktopDrop({ target, onDrop, accept: () => false }),
    );
    const dataTransfer = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });
    fireEvent.drop(target, { dataTransfer, clientX: 0, clientY: 0 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('window dragend 兜底复位残留高亮', () => {
    renderHook(() => useDesktopDrop({ target, onDrop: () => {} }));
    const dataTransfer = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });
    fireEvent.dragEnter(target, { dataTransfer });
    expect(target.getAttribute('data-wb-drop-state')).toBe('over');

    fireEvent.dragEnd(window, {});
    expect(target.hasAttribute('data-wb-drop-state')).toBe(false);
  });

  it('卸载时移除监听并复位视觉态', () => {
    const onDrop = vi.fn();
    const { unmount } = renderHook(() => useDesktopDrop({ target, onDrop }));
    const dataTransfer = makeDataTransfer({ data: { [WB_RESOURCE_MIME]: resourceJson } });
    fireEvent.dragEnter(target, { dataTransfer });
    unmount();
    expect(target.hasAttribute('data-wb-drop-state')).toBe(false);
    fireEvent.drop(target, { dataTransfer, clientX: 0, clientY: 0 });
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('拖源辅助', () => {
  it('setWorkbenchDragData / parseWorkbenchDragData 往返无损 + text/plain 兜底', () => {
    const dataTransfer = makeDataTransfer();
    setWorkbenchDragData(dataTransfer, {
      resourceId: 'pdf_9',
      resourceType: 'pdf',
      title: '线性代数讲义',
    });

    expect(parseWorkbenchDragData(dataTransfer)).toEqual({
      resourceId: 'pdf_9',
      resourceType: 'pdf',
      title: '线性代数讲义',
    });
    expect(dataTransfer.getData('text/plain')).toBe('线性代数讲义');
  });

  it('非法 JSON / 非资源拖源返回 null', () => {
    expect(
      parseWorkbenchDragData(makeDataTransfer({ data: { [WB_RESOURCE_MIME]: '{bad' } })),
    ).toBeNull();
    expect(
      parseWorkbenchDragData(makeDataTransfer({ data: { 'text/plain': 'x' } })),
    ).toBeNull();
    expect(
      parseWorkbenchDragData(
        makeDataTransfer({ data: { [WB_RESOURCE_MIME]: '{"noId":true}' } }),
      ),
    ).toBeNull();
  });
});
