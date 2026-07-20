import { useEffect, useState } from 'react';

const readIsDark = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

/**
 * 订阅 html.dark class 变化的响应式暗色状态。
 *
 * 选色板 / 主题解析等依赖暗色变体的 UI 用它替代一次性的
 * `document.documentElement.classList.contains('dark')` 读取，
 * 运行时切换亮暗不再需要重新挂载组件。
 */
export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(readIsDark);

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'));
    });
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    // 挂载与观察之间可能已有变化，补读一次
    setIsDark(el.classList.contains('dark'));
    return () => observer.disconnect();
  }, []);

  return isDark;
}
