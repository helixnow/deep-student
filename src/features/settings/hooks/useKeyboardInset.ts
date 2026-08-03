import { useEffect, useState } from 'react';

/**
 * 键盘避让（P2-15）：返回软键盘当前遮挡视口底部的高度（CSS px）。
 *
 * 依据 window.visualViewport 与布局视口的差值做简单估算：
 * 键盘弹出时 visualViewport.height 收缩，差值即被遮挡区域。
 * 不支持 visualViewport 的环境恒返回 0（渐进增强）。
 */
export function useKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setInset(0);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      const next = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
      );
      // 小于 80px 视为浏览器 UI 抖动而非键盘，避免底栏跟着轻微跳动
      setInset(next >= 80 ? next : 0);
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return enabled ? inset : 0;
}

export default useKeyboardInset;
