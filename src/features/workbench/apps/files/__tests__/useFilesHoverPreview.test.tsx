/**
 * useFilesHoverPreview 打磨项测试
 *
 * - 延迟出现：hover 停留 SHOW_DELAY 后玻璃卡可见（aria-hidden 同步翻转）
 * - 按下即收起：pointerdown（点击/起拖/右键）立刻隐藏预览卡
 * - 长路径中段省略：保留首段与尾段文件名
 */
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: 'zh-CN' },
  }),
}));

const LONG_PATH = vi.hoisted(() => `/根目录/${'很长的中间层级/'.repeat(8)}最终笔记名称.md`);

vi.mock('@/features/learning-hub/stores/finderStore', () => {
  const state = {
    items: [
      { id: 'note_1', name: '测试笔记', type: 'note', path: LONG_PATH },
      { id: 'folder_1', name: '文件夹', type: 'folder', path: '/folder_1' },
    ],
  };
  const useFinderStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  useFinderStore.getState = () => state;
  return { useFinderStore };
});

import { useFilesHoverPreview } from '../useFilesHoverPreview';

function makeHost(itemId: string): { host: HTMLElement; item: HTMLElement } {
  const host = document.createElement('div');
  const item = document.createElement('div');
  item.setAttribute('data-finder-item', '');
  item.setAttribute('data-item-id', itemId);
  host.appendChild(item);
  document.body.appendChild(host);
  return { host, item };
}

function pointerMoveOn(target: EventTarget, x = 100, y = 100): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
}

function pointerDownOn(target: EventTarget): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
}

function queryCard(): HTMLElement | null {
  return document.querySelector('[data-wb-files-hover-preview]');
}

describe('useFilesHoverPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('hover 停留后显示玻璃卡，aria-hidden 同步翻转', () => {
    const { host, item } = makeHost('note_1');
    const hook = renderHook(() => useFilesHoverPreview({ hostRef: { current: host } }));

    act(() => {
      pointerMoveOn(item);
    });
    const card = queryCard()!;
    expect(card.getAttribute('data-visible')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(card.getAttribute('data-visible')).toBe('true');
    expect(card.getAttribute('aria-hidden')).toBe('false');
    expect(card.textContent).toContain('测试笔记');

    hook.unmount();
    expect(queryCard()).toBeNull();
  });

  it('pointerdown（点击/起拖/右键）立即收起预览卡', () => {
    const { host, item } = makeHost('note_1');
    const hook = renderHook(() => useFilesHoverPreview({ hostRef: { current: host } }));

    act(() => {
      pointerMoveOn(item);
      vi.advanceTimersByTime(500);
    });
    expect(queryCard()!.getAttribute('data-visible')).toBe('true');

    act(() => {
      pointerDownOn(item);
    });
    expect(queryCard()!.getAttribute('data-visible')).toBe('false');
    expect(queryCard()!.getAttribute('aria-hidden')).toBe('true');

    hook.unmount();
  });

  it('长路径中段省略：保住尾段文件名', () => {
    const { host, item } = makeHost('note_1');
    const hook = renderHook(() => useFilesHoverPreview({ hostRef: { current: host } }));

    act(() => {
      pointerMoveOn(item);
      vi.advanceTimersByTime(500);
    });
    const meta = queryCard()!.querySelector('.wb-files-hover-preview__meta')!;
    expect(meta.textContent).toContain('…');
    expect(meta.textContent).toContain('最终笔记名称.md');
    expect(meta.textContent!.length).toBeLessThan(LONG_PATH.length);

    hook.unmount();
  });

  it('文件夹不出预览卡', () => {
    const { host, item } = makeHost('folder_1');
    const hook = renderHook(() => useFilesHoverPreview({ hostRef: { current: host } }));

    act(() => {
      pointerMoveOn(item);
      vi.advanceTimersByTime(500);
    });
    expect(queryCard()!.getAttribute('data-visible')).toBe('false');

    hook.unmount();
  });
});
