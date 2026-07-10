/**
 * useResizeScrollAnchor — 窗口缩放时消息流的稳定滚动锚点（O16）
 *
 * 问题：WindowShell 缩放窗口时内容区宽高逐帧变化，消息文本重排 +
 * scroller 高度变化会让浏览器保持 scrollTop 不变，视觉上消息流
 * 「爬走 / 抖动」，吸底状态也会被顶离底部。
 *
 * 策略（chat 是自底向上阅读的界面，距底距离是最稳的感知锚点）：
 * - 平时用 passive scroll 监听记录 viewport 的 distanceToBottom；
 * - ResizeObserver 观察窗口内容根节点，几何变化时（缩放/平铺落位）
 *   在布局后、绘制前把 scrollTop 校正回「保持距底距离不变」的位置——
 *   吸底(距底≈0)时始终钉在底部，向上翻阅时保持读到的内容不动；
 * - 校正直写 DOM scrollTop，不进 React state（§1.5 高频交互纪律）。
 *
 * viewport 解析：MessageList 的滚动容器是 OverlayScrollbars viewport
 * （[data-overlayscrollbars-viewport]，iOS native 档为 .scroll-area--native），
 * 从 [role="log"]（消息流语义节点）向上 closest 定位，避免误中窗口内
 * 其他滚动区（技能面板/审批栏等）。空态（无消息）时无 log 节点，静默跳过。
 *
 * 不改 legacy MessageList：其内部的流式吸底 rAF、prepend 补偿等逻辑
 * 只在内容变化时写 scrollTop，与本 hook（只在几何变化时写）正交。
 */
import { useEffect, type RefObject } from 'react';

const VIEWPORT_SELECTOR = '[data-overlayscrollbars-viewport], .scroll-area--native';

/** 纯函数便于单测：给定几何与目标距底距离，算校正后的 scrollTop */
export function computeAnchoredScrollTop(
  metrics: { scrollHeight: number; clientHeight: number },
  distanceToBottom: number,
): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - distanceToBottom);
}

/** 从窗口内容根节点解析消息流滚动 viewport（可能尚未挂载 → null） */
export function findMessageViewport(root: HTMLElement): HTMLElement | null {
  const log = root.querySelector('[role="log"]');
  return log?.closest<HTMLElement>(VIEWPORT_SELECTOR) ?? null;
}

export function useResizeScrollAnchor(
  rootRef: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled || typeof ResizeObserver === 'undefined') return;

    let viewport: HTMLElement | null = null;
    let distanceToBottom = 0;

    const readDistance = () => {
      if (!viewport) return;
      distanceToBottom = Math.max(
        0,
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      );
    };

    // 用户/流式吸底等一切滚动都会刷新基准；我们的校正本身恢复的就是
    // 该距离，其触发的 scroll 事件读回同值，无需防重入标记
    const onScroll = () => readDistance();

    const attach = (next: HTMLElement | null) => {
      if (next === viewport) return;
      viewport?.removeEventListener('scroll', onScroll);
      viewport = next;
      if (viewport) {
        viewport.addEventListener('scroll', onScroll, { passive: true });
        readDistance();
      }
    };

    // ResizeObserver 回调运行在布局之后、绘制之前：此处校正无可见抖动
    const observer = new ResizeObserver(() => {
      attach(findMessageViewport(root));
      if (!viewport) return;
      if (viewport.scrollHeight <= viewport.clientHeight) return; // 无溢出无需锚定
      const target = computeAnchoredScrollTop(viewport, distanceToBottom);
      if (Math.abs(viewport.scrollTop - target) > 1) {
        viewport.scrollTop = target;
      }
    });

    observer.observe(root);
    // 初始解析一次，让 scroll 基准从挂载起就开始跟踪
    attach(findMessageViewport(root));

    return () => {
      observer.disconnect();
      viewport?.removeEventListener('scroll', onScroll);
      viewport = null;
    };
  }, [rootRef, enabled]);
}
