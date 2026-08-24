import { useEffect, useRef } from 'react';

export interface UseFocusTrapOptions {
  /**
   * 激活时把焦点移入容器（默认 true）。
   * 若激活瞬间焦点已在容器内（如子组件 autoFocus / 自行聚焦），不会抢焦点。
   */
  initialFocus?: boolean;
  /**
   * 关闭 / 卸载时把焦点归还给激活前的元素（默认 true）。
   * 仅当原元素仍在文档中，且当前焦点仍位于容器内（或已丢到 body）时归还，
   * 避免抢走用户主动点到别处的焦点。
   */
  restoreFocus?: boolean;
}

/**
 * 实现焦点陷阱的Hook，确保Tab键在指定容器内循环。
 * 模态对话框（aria-modal="true"）必须配套使用，否则 Tab 会穿透到遮罩后的页面
 * （参见 docs/dev/workbench-a11y-checklist.md §G1/G6）。
 * @param isActive 是否激活焦点陷阱
 * @param options 初始聚焦 / 焦点归还开关
 * @returns 需要绑定到容器元素的ref
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  isActive: boolean,
  options?: UseFocusTrapOptions,
) {
  const containerRef = useRef<T>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    const initialFocus = optionsRef.current?.initialFocus !== false;
    const restoreFocus = optionsRef.current?.restoreFocus !== false;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 获取容器内所有可聚焦的元素
    const getFocusableElements = (): HTMLElement[] => {
      const focusableSelectors = [
        'button:not([disabled])',
        'input:not([disabled])',
        'textarea:not([disabled])', 
        'select:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(', ');
      
      return Array.from(container.querySelectorAll(focusableSelectors))
        .filter(el => {
          const element = el as HTMLElement;
          // 确保元素可见且可交互
          return element.offsetParent !== null && 
                 !element.hasAttribute('disabled') &&
                 getComputedStyle(element).visibility !== 'hidden';
        }) as HTMLElement[];
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        // 容器内无可聚焦元素：焦点留在容器本身，不让 Tab 穿透
        e.preventDefault();
        container.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement as HTMLElement;

      if (e.shiftKey) {
        // Shift+Tab: 向前循环
        if (activeElement === firstElement || !focusableElements.includes(activeElement)) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: 向后循环
        if (activeElement === lastElement || !focusableElements.includes(activeElement)) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    // 初始聚焦到第一个可聚焦元素（焦点已在容器内时不抢，保住 autoFocus）
    if (initialFocus && !container.contains(document.activeElement)) {
      const focusableElements = getFocusableElements();
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      } else {
        container.focus();
      }
    }

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      if (!restoreFocus || !previousFocus || !previousFocus.isConnected) return;
      // 焦点仍在（正被卸载的）容器内或已丢到 body 时才归还
      const active = document.activeElement;
      if (!active || active === document.body || container.contains(active)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [isActive]);

  return containerRef;
}
