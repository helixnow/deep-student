import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types/navigation';

/**
 * 检测当前视图是否处于活跃状态。
 *
 * 用法示例：
 * ```ts
 * const { isActive } = useViewVisibility('dashboard');
 *
 * useEffect(() => {
 *   if (!isActive) return;           // 视图不可见时跳过
 *   const timer = setInterval(poll, 5000);
 *   return () => clearInterval(timer);
 * }, [isActive]);
 * ```
 *
 * @param view - 要检测的视图名称
 * @returns `{ isActive }` — 该视图是否正在显示
 */
export function useViewVisibility(view: CurrentView): { isActive: boolean } {
  const isActive = useViewStore((s) => s.currentView === view);
  return { isActive };
}
