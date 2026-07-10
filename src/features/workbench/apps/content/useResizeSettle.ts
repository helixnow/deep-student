/**
 * useResizeSettle — 窗口缩放/平铺时的内容重排节流 + 滚动位置保持（O17）
 *
 * 问题：拖拽缩放时窗口壳（O2 pointerEngine）逐帧改写宿主尺寸，重内容
 * （PDF.js 页面、Crepe 编辑器）每帧全量重排，掉帧且滚动位置漂移。
 *
 * 策略（对标 macOS live-resize 的"内容保持"）：
 * - 首个尺寸变化直接放行（maximize / 平铺落位等单跳不受影响）；
 * - 短窗口内（≤200ms）出现第二次变化 → 判定为连续手势，锁定内容层为手势前
 *   的像素尺寸（内容零重排，宿主背景补白），并记录滚动位置；
 * - 手势中每 ~140ms 把锁定尺寸对齐一次当前宿主（低频重排，视觉跟得上）；
 * - 尺寸停止变化 ~170ms 后 settle：解除锁定（单次回流），下一帧恢复滚动位置。
 *
 * 纪律（§1.5）：全程直写 DOM（class + inline size），0 React 重渲染；
 * 不做任何 width/height 过渡动画（尺寸变化是布局操作，非动效）。
 */
import { useEffect } from 'react';
import { isShellDraggingAttr } from '../../core/shellGestureFlags';

/** 连续手势判定窗口：两次尺寸变化间隔 ≤ 该值才进入锁定 */
const GESTURE_DETECT_MS = 200;
/** 手势中锁定尺寸的低频对齐间隔 */
const INTERIM_APPLY_MS = 140;
/** 尺寸停稳判定：该时长内无新变化则 settle */
const SETTLE_MS = 170;
/** 手势中挂在宿主上的状态类（ContentAppWindow.css 消费） */
export const RESIZE_HOLD_CLASS = 'wb-content-resize-holding';

interface ScrollSnapshot {
  el: Element;
  top: number;
  left: number;
}

/**
 * 广度优先找首个可滚动后代（legacy 视图的滚动容器不可知，用启发式探测）。
 * 只在手势开始时调用一次，maxNodes 上限防止大 DOM 上开销失控。
 */
export function findScrollableDescendant(root: Element, maxNodes = 240): Element | null {
  const queue: Element[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < maxNodes) {
    const el = queue.shift() as Element;
    visited += 1;
    if (el !== root && el.scrollHeight > el.clientHeight + 4) {
      try {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
          return el;
        }
      } catch {
        // getComputedStyle 在分离节点上可能抛错，跳过该节点即可
      }
    }
    for (let i = 0; i < el.children.length; i += 1) {
      queue.push(el.children[i]);
    }
  }
  return null;
}

export function useResizeSettle(
  hostRef: { readonly current: HTMLElement | null },
  contentRef: { readonly current: HTMLElement | null },
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    const content = contentRef.current;
    if (!host || !content || typeof ResizeObserver === 'undefined') return;

    let lastW = 0;
    let lastH = 0;
    let lastTs = 0;
    let lastApplyTs = 0;
    let sawFirstObservation = false;
    let holding = false;
    let settleTimer: number | null = null;
    let savedScroll: ScrollSnapshot | null = null;

    const raf: (cb: () => void) => void =
      typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(() => cb())
        : (cb) => void window.setTimeout(cb, 0);

    const lockContentSize = (w: number, h: number) => {
      content.style.width = `${w}px`;
      content.style.height = `${h}px`;
      lastApplyTs = Date.now();
    };

    const engageHold = () => {
      holding = true;
      const scrollable = findScrollableDescendant(content);
      savedScroll = scrollable
        ? { el: scrollable, top: scrollable.scrollTop, left: scrollable.scrollLeft }
        : null;
      host.classList.add(RESIZE_HOLD_CLASS);
      // 锁在手势前（上一次观察到）的尺寸：内容零重排
      lockContentSize(lastW, lastH);
    };

    const releaseHold = () => {
      holding = false;
      content.style.width = '';
      content.style.height = '';
      host.classList.remove(RESIZE_HOLD_CLASS);
      const snapshot = savedScroll;
      savedScroll = null;
      if (snapshot) {
        // settle 回流后的下一帧恢复滚动位置（编辑器不丢阅读点）
        raf(() => {
          snapshot.el.scrollTop = snapshot.top;
          snapshot.el.scrollLeft = snapshot.left;
        });
      }
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      const now = Date.now();

      if (!sawFirstObservation) {
        // observe() 挂载时的初始回调，只记录基线
        sawFirstObservation = true;
        lastW = w;
        lastH = h;
        lastTs = now;
        return;
      }
      if (w === lastW && h === lastH) return;

      if (!holding) {
        // 壳层缩放已挂 data-wb-dragging：首帧尺寸变化即 hold，不必等第二次
        if (isShellDraggingAttr() || now - lastTs <= GESTURE_DETECT_MS) {
          engageHold();
        }
        // 单跳（maximize / 平铺，无拖拽旗）不锁定，内容立即自然回流
      } else if (now - lastApplyTs >= INTERIM_APPLY_MS) {
        lockContentSize(w, h);
      }

      lastW = w;
      lastH = h;
      lastTs = now;

      if (holding) {
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          releaseHold();
        }, SETTLE_MS);
      }
    });

    observer.observe(host);

    return () => {
      observer.disconnect();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (holding) releaseHold();
    };
  }, [enabled, hostRef, contentRef]);
}
