import { useEffect } from 'react';

interface UseNavigationShortcutsOptions {
  /** 后退回调 */
  onBack: () => void;
  /** 前进回调 */
  onForward: () => void;
  /** 是否可以后退 */
  canGoBack: boolean;
  /** 是否可以前进 */
  canGoForward: boolean;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/**
 * 导航快捷键 Hook
 * 支持：
 * - 键盘：Alt+Left / Alt+Right（通用）
 * - 鼠标：侧键 3/4（后退/前进）
 *
 * 注：Cmd+[ / Cmd+] 已迁移到命令系统 (nav.back / nav.forward)，
 * 此处不再重复注册。
 */
export function useNavigationShortcuts(options: UseNavigationShortcutsOptions) {
  const { onBack, onForward, canGoBack, canGoForward, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    /**
     * 键盘事件处理
     * 注：Cmd+[ / Cmd+] 已迁移到命令系统 (nav.back / nav.forward)，
     * 此处仅保留 Alt+Arrow（与命令系统不冲突的补充快捷键）。
     */
    const handleKeyDown = (e: KeyboardEvent) => {
      // 在输入框中禁用快捷键
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (isInput) return;

      // 通用: Alt+Left / Alt+Right
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (e.key === 'ArrowLeft' && canGoBack) {
          e.preventDefault();
          onBack();
        } else if (e.key === 'ArrowRight' && canGoForward) {
          e.preventDefault();
          onForward();
        }
      }
    };

    /**
     * 鼠标事件处理（侧键）
     */
    const handleMouseDown = (e: MouseEvent) => {
      // 鼠标侧键：button 3 = 后退，button 4 = 前进
      if (e.button === 3 && canGoBack) {
        e.preventDefault();
        onBack();
      } else if (e.button === 4 && canGoForward) {
        e.preventDefault();
        onForward();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [enabled, onBack, onForward, canGoBack, canGoForward]);
}

/**
 * 获取当前平台的导航快捷键提示文本
 * 包含本 Hook 提供的 Alt+Arrow 和命令系统提供的 Cmd+[/]
 */
export function getNavigationShortcutText(): { back: string; forward: string } {
  // 始终显示 Alt+Arrow，因为这是本 Hook 在所有平台都支持的
  // Cmd+[/] 由命令系统提供，用户可在快捷键设置中查看/修改
  return {
    back: 'Alt+←',
    forward: 'Alt+→',
  };
}



