/**
 * useSmoothWheel — 滚轮 delta 归一化
 *
 * 滚动本身完全交给浏览器原生：
 * - 不用 `preventDefault`，监听器保持 `passive: true`
 * - 不做 JS 缓动循环（历史实现会用 rAF 把 scrollTop 逼近目标）
 * - 不区分鼠标滚轮 / 触控板，原生 momentum 与系统层同步最好
 *
 * 这么改的原因：自造缓动绕过了原生滚动时间轴，滚动与渲染可能差一帧；
 * `passive: false` 全局接管滚轮会与嵌套滚动容器（代码块、来源面板）和
 * 虚拟化器抢同一事件源；"鼠标 vs 触控板"的判定依赖 deltaY 是否为整数，
 * 在开启系统平滑滚动的 macOS 上会误判成鼠标，反而给触控板惯性二次缓动。
 *
 * 保留的只有 deltaMode 归一化（行/页模式 → 像素），供调用方做与设备无关的
 * 阈值比较。当前调用方 MessageList 暂未消费，属于留作平台出口。
 */

import { useEffect, useRef } from 'react';

export interface SmoothWheelOptions {
  /** 关闭开关。默认 true。 */
  enabled?: boolean;
  /**
   * 归一化后的向上滚回调（像素量，负值向上）。
   *
   * ⚠️ 吸底解除不要挂在这里：跟随解除由 MessageList 的账本分类器在 scroll
   * 事件里判定，任何设备都覆盖；在 wheel 里加设备专属意图监听是该仓库
   * 刻意移除的设计（见 MessageList.scrollToBottom.source.test.ts）。
   */
  onUserScrollUp?: () => void;
  /**
   * 解析真正可滚动元素。OverlayScrollbars 场景下 host !== viewport，
   * 调用方需返回真实 viewport（[data-overlayscrollbars-viewport]）。
   * 不传时退化为 hostElement 自身或其内 viewport。
   */
  getScrollElement?: () => HTMLElement | null;
}

/** 行模式下一行约 16px：用于把 deltaMode=1/2 折算成像素做阈值判断 */
const LINE_HEIGHT_PX = 16;

/** 低于该像素量视为滚动噪声（触控板微抖），不触发回调 */
const INTENT_EPSILON_PX = 0.5;

/**
 * 把任意 deltaMode 的 deltaY 折算成像素，供与设备无关的阈值比较使用。
 * 不修改事件本身——原生滚动照常按浏览器自己的解释进行。
 */
export function normalizeWheelDeltaY(event: {
  deltaMode: number;
  deltaY: number;
  clientHeight?: number;
}): number {
  if (event.deltaMode === 1 /* DOM_DELTA_LINE */) return event.deltaY * LINE_HEIGHT_PX;
  if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) {
    return event.deltaY * (event.clientHeight || LINE_HEIGHT_PX * 20);
  }
  return event.deltaY;
}

export function useSmoothWheel(
  hostElement: HTMLElement | null,
  options: SmoothWheelOptions = {},
): void {
  const { enabled = true, onUserScrollUp, getScrollElement } = options;

  // 通过 ref 把可变选项带进闭包，避免每次值变都重挂监听
  const optsRef = useRef({ onUserScrollUp, getScrollElement });
  optsRef.current = { onUserScrollUp, getScrollElement };

  useEffect(() => {
    if (!enabled || !hostElement) return;

    const resolveScrollEl = (): HTMLElement | null => {
      const custom = optsRef.current.getScrollElement?.();
      if (custom) return custom;
      const inner = hostElement.querySelector<HTMLElement>(
        '[data-overlayscrollbars-viewport]',
      );
      return inner ?? hostElement;
    };

    const onWheel = (e: WheelEvent) => {
      // 横滚不处理
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      const deltaY = normalizeWheelDeltaY({
        deltaMode: e.deltaMode,
        deltaY: e.deltaY,
        // WheelEvent 继承 UIEvent，没有 clientHeight；页模式折算取视口元素高度
        clientHeight: resolveScrollEl()?.clientHeight,
      });
      // 只关心向上滚，向下滚由原生滚动 + 吸底跟随自然处理
      if (deltaY >= -INTENT_EPSILON_PX) return;

      optsRef.current.onUserScrollUp?.();
    };

    // passive: true —— 不 preventDefault，让原生滚动与嵌套滚动容器原生接管
    hostElement.addEventListener('wheel', onWheel, { passive: true });
    return () => hostElement.removeEventListener('wheel', onWheel);
  }, [hostElement, enabled]);
}