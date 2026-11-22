/**
 * 节点实测高度回写（RootNode / BranchNode 共用）
 *
 * - 模块级单一共享 ResizeObserver + WeakMap<Element, (height: number) => void>：
 *   大图数百上千节点不再各自实例化 ResizeObserver，卸载时精确 unobserve + 清理回调；
 *   所有节点均卸载后自动 disconnect 释放观察器（同时兼容测试中替换全局 ResizeObserver）。
 * - 同值不回写：ResizeObserver 亚像素抖动 / 布局回流触发的同高度回调不再打进 store，
 *   避免「测量 → 布局重算 → 再测量」的反馈抖动。
 * - store 侧仍有 16ms 批量 flush（setMeasuredNodeHeight），此处是第一道闸门。
 */

import { useEffect, useRef, type RefObject } from 'react';

type HeightCallback = (height: number) => void;

const elementCallbacks = new WeakMap<Element, HeightCallback>();
let sharedObserver: ResizeObserver | null = null;
let sharedObserverCtor: typeof ResizeObserver | null = null;
let observedCount = 0;

function readObservedHeight(entry: ResizeObserverEntry): number {
  // 优先读取浏览器 ResizeObserver 自带的 borderBoxSize（零同步回流，且在 CSS 缩放下保持未缩放盒子高度）
  const blockSize = entry.borderBoxSize?.[0]?.blockSize;
  if (typeof blockSize === 'number' && Number.isFinite(blockSize) && blockSize > 0) {
    return Math.round(blockSize);
  }
  const target = entry.target as HTMLElement | null;
  if (target && target.offsetHeight > 0) {
    return target.offsetHeight;
  }
  const rectHeight = entry.contentRect?.height;
  if (typeof rectHeight === 'number' && Number.isFinite(rectHeight) && rectHeight > 0) {
    return Math.round(rectHeight);
  }
  return 0;
}

function getSharedResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') {
    return null;
  }
  if (!sharedObserver || sharedObserverCtor !== ResizeObserver) {
    if (sharedObserver) {
      sharedObserver.disconnect();
    }
    sharedObserverCtor = ResizeObserver;
    sharedObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!entry?.target) continue;
        const callback = elementCallbacks.get(entry.target);
        if (!callback) continue;
        callback(readObservedHeight(entry));
      }
    });
  }
  return sharedObserver;
}

export function useNodeHeightObserver(
  nodeRef: RefObject<HTMLElement>,
  nodeId: string,
  setMeasuredNodeHeight: (nodeId: string, height: number) => void,
  enabled: boolean,
): void {
  const lastHeightRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const element = nodeRef.current;
    if (!element || !nodeId) {
      return;
    }
    // nodeId / enabled 变化后重新上报一次基准值
    lastHeightRef.current = 0;
    const reportHeight: HeightCallback = (height) => {
      if (height > 0 && height !== lastHeightRef.current) {
        lastHeightRef.current = height;
        setMeasuredNodeHeight(nodeId, height);
      }
    };

    const observer = getSharedResizeObserver();
    if (!observer) {
      reportHeight(element.offsetHeight);
      return;
    }
    // 交给共享 ResizeObserver 初始批量回调读取 entry.borderBoxSize，避免挂载期逐节点 offsetHeight 同步回流
    elementCallbacks.set(element, reportHeight);
    observer.observe(element);
    observedCount += 1;

    return () => {
      elementCallbacks.delete(element);
      observer.unobserve(element);
      observedCount = Math.max(0, observedCount - 1);
      if (observedCount === 0 && sharedObserver === observer) {
        observer.disconnect();
        sharedObserver = null;
        sharedObserverCtor = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeRef 为稳定 ref 容器
  }, [nodeId, setMeasuredNodeHeight, enabled]);
}
