/**
 * visualViewport 纯工具：浮层定位的软键盘感知。
 *
 * 移动端软键盘弹出/收起只反映在 window.visualViewport 上——
 * window.innerHeight 不变，用它做边界钳位会让浮层下半截被键盘遮住。
 * 参考实现：ComposerPanelOverlay.tsx（I-2）。
 *
 * 桌面端（或不支持 visualViewport 的环境）自动回退 innerWidth/innerHeight，
 * 行为与直接读 window.inner* 等价。
 */

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * 当前可视视口尺寸：优先 visualViewport（感知软键盘/捏合缩放），
 * 缺失时回退 window.innerWidth/innerHeight。
 */
export function getVisualViewportSize(): ViewportSize {
  if (typeof window === 'undefined') {
    return { width: 0, height: 0 };
  }
  const vv = window.visualViewport;
  return {
    width: vv?.width ?? window.innerWidth,
    height: vv?.height ?? window.innerHeight,
  };
}

/**
 * 监听 visualViewport 的 resize/scroll（passive），返回清理函数。
 * 不支持 visualViewport 的环境返回 no-op——调用方应继续保留
 * window resize/scroll 监听作为兜底，本工具只做增量补充。
 */
export function addVisualViewportChangeListener(handler: () => void): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  vv.addEventListener('resize', handler, { passive: true });
  vv.addEventListener('scroll', handler, { passive: true });
  return () => {
    vv.removeEventListener('resize', handler);
    vv.removeEventListener('scroll', handler);
  };
}
