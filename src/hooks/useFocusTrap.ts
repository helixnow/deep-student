import { useEffect, useRef } from 'react';

/**
 * 实现焦点陷阱的Hook，确保Tab键在指定容器内循环
 * @param isActive 是否激活焦点陷阱
 * @returns 需要绑定到容器元素的ref
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(isActive: boolean) {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    
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
      if (focusableElements.length === 0) return;

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

    // 初始聚焦到第一个可聚焦元素
    const focusableElements = getFocusableElements();
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [isActive]);

  return containerRef;
}
