/**
 * useDragRenderPause — 拖拽降频属性挂载
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useDragRenderPause, WB_RENDER_PAUSED_ATTR } from '../useDragRenderPause';

describe('useDragRenderPause', () => {
  it('throttleMs>0 时挂 data-wb-render-paused；归零时移除', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const { rerender, unmount } = renderHook(
      ({ ms }: { ms: number }) => {
        const ref = useRef(host);
        useDragRenderPause(ref, ms);
      },
      { initialProps: { ms: 0 } },
    );

    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);

    rerender({ ms: 500 });
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);

    rerender({ ms: 0 });
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);

    rerender({ ms: 250 });
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);
    unmount();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);

    host.remove();
  });

  it('html data-wb-dragging 变化时同步暂停，不依赖 throttleMs', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const { unmount } = renderHook(() => {
      const ref = useRef(host);
      useDragRenderPause(ref, 0);
    });

    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
    document.documentElement.setAttribute('data-wb-dragging', '');
    await vi.waitFor(() => {
      expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);
    });

    document.documentElement.removeAttribute('data-wb-dragging');
    await vi.waitFor(() => {
      expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
    });

    unmount();
    host.remove();
  });
});
