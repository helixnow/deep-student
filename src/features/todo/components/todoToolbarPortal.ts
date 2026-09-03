import { useDesktopShellHeaderPortal } from '@/app/shell/DesktopShellHeaderPortal';

/**
 * 待办工具栏 portal 目标解析（TodoMainPanel / TodoTrashWorkspace /
 * TodoAutomationWorkspace 共用）：
 * - workbench 窗口标题栏槽位（TodoAppWindow 经 prop 透传）优先；
 * - 其次 legacy 壳标题栏（currentView==='todo' 时由 App 壳提供）；
 * - 两者互斥（壳模式二选一）；移动端均为 null，工具栏保持页内内联。
 */
export function useTodoToolbarPortalTarget(
  windowTitlebarSlot?: HTMLElement | null,
): HTMLElement | null {
  const shellTarget = useDesktopShellHeaderPortal('todo');
  return windowTitlebarSlot ?? shellTarget;
}
