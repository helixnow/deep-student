/**
 * 节点实测高度回写（RootNode / BranchNode 共用）
 *
 * 在原始实现（各组件内联 ResizeObserver）基础上：
 * - 同值不回写：ResizeObserver 亚像素抖动 / 布局回流触发的同高度回调不再打进 store，
 *   避免「测量 → 布局重算 → 再测量」的反馈抖动
 * - store 侧仍有 16ms 批量 flush（setMeasuredNodeHeight），此处是第一道闸门
 */

import { useLayoutEffect, useRef, type RefObject } from 'react';

export function useNodeHeightObserver(
  nodeRef: RefObject<HTMLElement>,
  nodeId: string,
  setMeasuredNodeHeight: (nodeId: string, height: number) => void,
  enabled: boolean,
): void {
  const lastHeightRef = useRef(0);

  useLayoutEffect(() => {
    if (!enabled) return;
    const element = nodeRef.current;
    if (!element || !nodeId) {
      return;
    }
    // nodeId / enabled 变化后重新上报一次基准值
    lastHeightRef.current = 0;
    const updateHeight = () => {
      const height = element.offsetHeight;
      if (height > 0 && height !== lastHeightRef.current) {
        lastHeightRef.current = height;
        setMeasuredNodeHeight(nodeId, height);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeRef 为稳定 ref 容器
  }, [nodeId, setMeasuredNodeHeight, enabled]);
}
