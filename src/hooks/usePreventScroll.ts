import { useEffect, RefObject } from 'react';

/**
 * 防止元素被编程方式滚动
 * 通过 CSS overflow: hidden 阻止用户交互滚动，
 * 并通过 scroll 事件监听器捕获任何编程方式的 scrollTop/scrollLeft 修改。
 * 组件卸载时自动恢复原始 overflow 样式。
 */
export function usePreventScroll(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // 保存原始 overflow 样式，以便卸载时恢复
    const originalOverflow = element.style.overflow;

    // 设置 overflow: hidden 阻止用户交互滚动
    element.style.overflow = 'hidden';

    const preventScroll = () => {
      if (element.scrollTop !== 0) {
        element.scrollTop = 0;
      }
      if (element.scrollLeft !== 0) {
        element.scrollLeft = 0;
      }
    };

    // 立即重置
    preventScroll();

    // 监听滚动事件，捕获编程方式的 scrollTop 修改
    element.addEventListener('scroll', preventScroll, { passive: true });

    return () => {
      element.removeEventListener('scroll', preventScroll);
      // 恢复原始 overflow 样式
      element.style.overflow = originalOverflow;
    };
  }, [ref]);
}



