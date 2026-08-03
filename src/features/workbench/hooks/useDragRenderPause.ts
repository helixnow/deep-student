/**
 * useDragRenderPause — 拖/缩/settle 期间暂停重内容动画
 * ---------------------------------------------------------------------------
 * 主路径：shellGestureFlags.flushHeavyContentPause 在 pointerdown 同步挂
 * data-wb-render-paused。本 hook 作挂载对齐 + MutationObserver 兜底
 * （宿主晚挂载 / throttleMs 路径）。
 *
 * ANTI-REGRESSION：只改 dataset，禁止拖拽热路径 setState；禁止 host * 通配。
 */
import { useEffect } from 'react';
import {
  shouldPauseHeavyContent,
  WB_RENDER_PAUSED_ATTR,
} from '../core/shellGestureFlags';

export { WB_RENDER_PAUSED_ATTR };

const WB_DRAGGING_ATTR = 'data-wb-dragging';
const WB_SETTLING_ATTR = 'data-wb-settling';

export function useDragRenderPause(
  hostRef: { readonly current: HTMLElement | null },
  renderThrottleMs = 0,
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof document === 'undefined') return;

    const sync = () => {
      const paused = renderThrottleMs > 0 || shouldPauseHeavyContent();
      if (paused) host.setAttribute(WB_RENDER_PAUSED_ATTR, '');
      else host.removeAttribute(WB_RENDER_PAUSED_ATTR);
    };

    sync();

    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [WB_DRAGGING_ATTR, WB_SETTLING_ATTR],
    });

    return () => {
      mo.disconnect();
      // 本宿主卸载 / effect 重跑时清自己的 attr；手势仍活跃时新 effect 的 sync
      // 或下一次 flushHeavyContentPause 会再挂上。
      host.removeAttribute(WB_RENDER_PAUSED_ATTR);
    };
  }, [hostRef, renderThrottleMs]);
}
