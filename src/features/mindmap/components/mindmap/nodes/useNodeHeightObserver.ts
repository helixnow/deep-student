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

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

type SizeCallback = (size: { width: number; height: number }) => void;

const elementCallbacks = new WeakMap<Element, SizeCallback>();
let sharedObserver: ResizeObserver | null = null;
let sharedObserverCtor: typeof ResizeObserver | null = null;
let observedCount = 0;

function readObservedSize(entry: ResizeObserverEntry): { width: number; height: number } {
  // 优先读取浏览器 ResizeObserver 自带的 borderBoxSize（零同步回流，且在 CSS 缩放下保持未缩放盒子尺寸）
  const box = entry.borderBoxSize?.[0];
  const target = entry.target as HTMLElement | null;

  let width = 0;
  if (typeof box?.inlineSize === 'number' && Number.isFinite(box.inlineSize) && box.inlineSize > 0) {
    width = Math.round(box.inlineSize);
  } else if (target && target.offsetWidth > 0) {
    width = target.offsetWidth;
  } else if (typeof entry.contentRect?.width === 'number' && Number.isFinite(entry.contentRect.width) && entry.contentRect.width > 0) {
    width = Math.round(entry.contentRect.width);
  }

  let height = 0;
  if (typeof box?.blockSize === 'number' && Number.isFinite(box.blockSize) && box.blockSize > 0) {
    height = Math.round(box.blockSize);
  } else if (target && target.offsetHeight > 0) {
    height = target.offsetHeight;
  } else if (typeof entry.contentRect?.height === 'number' && Number.isFinite(entry.contentRect.height) && entry.contentRect.height > 0) {
    height = Math.round(entry.contentRect.height);
  }

  return { width, height };
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
        callback(readObservedSize(entry));
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
  isEditing = false,
): void {
  const lastHeightRef = useRef(0);
  const lastDisplayWidthRef = useRef(0);
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;

  // 进入编辑态前锁定当前非编辑展示宽度到 `--mm-edit-min-width`，
  // 退出编辑态立即清除并同步回采展示宽度（避免新节点首次退出编辑且宽度未变时 ResizeObserver 未二次回调）。
  useLayoutEffect(() => {
    const element = nodeRef.current;
    if (!element) return;
    if (!isEditing) {
      element.style.removeProperty('--mm-edit-min-width');
      const measured = Math.round(element.offsetWidth);
      if (measured > 0) {
        lastDisplayWidthRef.current = measured;
      }
      return;
    }
    const lockedWidth = lastDisplayWidthRef.current || Math.round(element.offsetWidth);
    if (lockedWidth > 0) {
      element.style.setProperty('--mm-edit-min-width', `${lockedWidth}px`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeRef 为稳定 ref 容器
  }, [isEditing]);

  useEffect(() => {
    if (!enabled) return;
    const element = nodeRef.current;
    if (!element || !nodeId) {
      return;
    }
    // nodeId / enabled 变化后重新上报一次基准值
    lastHeightRef.current = 0;
    const reportSize: SizeCallback = ({ width, height }) => {
      if (!isEditingRef.current && width > 0) {
        lastDisplayWidthRef.current = width;
      }
      if (height > 0 && height !== lastHeightRef.current) {
        lastHeightRef.current = height;
        setMeasuredNodeHeight(nodeId, height);
      }
    };

    const observer = getSharedResizeObserver();
    if (!observer) {
      reportSize({ width: element.offsetWidth, height: element.offsetHeight });
      return;
    }
    // 交给共享 ResizeObserver 初始批量回调读取 entry.borderBoxSize，避免挂载期逐节点 offsetHeight 同步回流
    elementCallbacks.set(element, reportSize);
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
