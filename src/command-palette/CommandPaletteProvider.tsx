/**
 * 命令面板 Context Provider
 * 管理命令面板的全局状态和依赖注入
 *
 * 快捷键架构说明：
 * - 本组件是全局快捷键的 **最终处理层**，注册在 window 上
 * - 组件级快捷键应注册在 document 上并调用 e.stopPropagation()
 * - 自定义快捷键通过 shortcutManager 管理，resolveEffectiveShortcut 统一查询
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { CurrentView } from '@/types/navigation';
import type { DependencyResolver, Command } from './registry/types';
import { commandRegistry } from './registry/commandRegistry';
import { shortcutManager } from './registry/shortcutManager';
import { normalizeShortcut, buildShortcutString } from './registry/shortcutUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// ==================== Context 类型 ====================

interface CommandPaletteContextValue {
  /** 是否打开 */
  isOpen: boolean;
  /** 打开命令面板 */
  open: () => void;
  /** 关闭命令面板 */
  close: () => void;
  /** 切换命令面板 */
  toggle: () => void;
  /** 执行命令 */
  executeCommand: (id: string) => Promise<void>;
  /** 搜索命令 */
  searchCommands: (query: string) => Command[];
  /** 依赖解析器 */
  deps: DependencyResolver;
  /** 当前视图（快照值，可能滞后于最新切换；优先使用 getCurrentView()） */
  currentView: CurrentView;
  /** 获取最新视图（ref-based，始终返回最新值） */
  getCurrentView: () => CurrentView;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

// ==================== Provider Props ====================

interface CommandPaletteProviderProps {
  children: ReactNode;
  /** 当前视图 */
  currentView: CurrentView;
  /** 导航函数 */
  navigate: (view: CurrentView, params?: Record<string, unknown>) => void;
  /** 切换主题 */
  toggleTheme: () => void;
  /** 是否暗色模式 */
  isDarkMode: boolean;
  /** 切换语言 */
  switchLanguage: (lang: 'zh-CN' | 'en-US') => void;
}

// ==================== Provider 组件 ====================

export function CommandPaletteProvider({
  children,
  currentView,
  navigate,
  toggleTheme,
  isDarkMode,
  switchLanguage,
}: CommandPaletteProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { t, i18n } = useTranslation();

  // 🚀 用 ref 持有 currentView，避免 deps/contextValue 在每次视图切换时重建
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;
  
  // 打开/关闭命令面板
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const deps = useMemo<DependencyResolver>(() => ({
    navigate,
    getCurrentView: () => currentViewRef.current,
    t,
    showNotification: showGlobalNotification,
    toggleTheme,
    isDarkMode: () => isDarkMode,
    switchLanguage,
    getCurrentLanguage: () => i18n.language,
    openCommandPalette: open,
    closeCommandPalette: close,
  }), [
    navigate,
    t,
    toggleTheme,
    isDarkMode,
    switchLanguage,
    i18n.language,
    open,
    close,
  ]);
  
  // 执行命令
  const executeCommand = useCallback(async (id: string) => {
    try {
      await commandRegistry.execute(id, deps);
      close(); // 执行后关闭面板
    } catch (error: unknown) {
      console.error('[CommandPalette] 命令执行失败:', error);
      showGlobalNotification(
        'error',
        t('command_palette:error.execute_failed', '命令执行失败'),
        t('common:error', '错误')
      );
    }
  }, [deps, close, t]);
  
  // 搜索命令（使用 ref 读取 currentView，避免每次视图切换重建）
  const searchCommands = useCallback((query: string) => {
    return commandRegistry.search(query, currentViewRef.current, deps);
  }, [deps]);
  
  // ==================== 快捷键缓存索引 ====================

  // 版本号：shortcutManager 或 commandRegistry 变更时递增，触发索引重建
  const indexVersionRef = useRef(0);
  const [indexVersion, setIndexVersion] = useState(0);

  useEffect(() => {
    const bump = () => {
      indexVersionRef.current += 1;
      setIndexVersion(indexVersionRef.current);
    };
    const unsub1 = shortcutManager.subscribe(bump);
    const unsub2 = commandRegistry.subscribe(bump);
    return () => { unsub1(); unsub2(); };
  }, []);

  /**
   * 缓存索引：normalizedShortcut → Command[]
   *
   * 仅在命令注册 / 自定义快捷键变更时重建（约 100 条命令），
   * 每次按键只需 Map.get O(1) + 小数组 filter（通常 1-3 条候选）。
   */
  const effectiveShortcutIndex = useMemo(() => {
    const index = new Map<string, Command[]>();
    const allCommands = commandRegistry.getAll();

    for (const cmd of allCommands) {
      const effective = shortcutManager.getShortcut(cmd.id);
      if (!effective) continue;

      const normalized = normalizeShortcut(effective);
      let list = index.get(normalized);
      if (!list) {
        list = [];
        index.set(normalized, list);
      }
      list.push(cmd);
    }

    return index;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexVersion]);

  /**
   * 从缓存索引中解析有效快捷键 → 命令。
   * 尊重视图范围和 isEnabled，取最高优先级。
   */
  const resolveEffectiveShortcut = useCallback(
    (normalized: string, view: CurrentView, d: DependencyResolver): Command | undefined => {
      const candidates = effectiveShortcutIndex.get(normalized);
      if (!candidates || candidates.length === 0) return undefined;

      let best: Command | undefined;
      let bestPriority = -Infinity;

      for (const cmd of candidates) {
        // 视图检查
        if (cmd.visibleInViews && cmd.visibleInViews.length > 0) {
          if (!cmd.visibleInViews.includes(view)) continue;
        }
        // 启用检查
        if (cmd.isEnabled && !cmd.isEnabled(d)) continue;

        const p = cmd.priority ?? 0;
        if (p > bestPriority) {
          bestPriority = p;
          best = cmd;
        }
      }

      return best;
    },
    [effectiveShortcutIndex],
  );

  // ==================== 全局快捷键监听（window 层，最终处理层）====================

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // 检查是否在富文本编辑器内部
      const isInRichEditor = target.closest(
        '.milkdown, .ProseMirror, .crepe-editor-wrapper, [data-rich-editor]',
      );

      // ── Cmd/Ctrl+K：打开命令面板（富文本编辑器内让编辑器自行处理）──
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        if (isInRichEditor) return;
        e.preventDefault();
        toggle();
        return;
      }

      // 命令面板打开时由 CommandPalette 组件自行处理
      if (isOpen) return;

      // ── 输入框中：仅放行带 Cmd/Ctrl 修饰键的快捷键 ──
      // 纯字符 / 特殊键（F1、Delete 等）在输入框中不应触发命令
      // Cmd+S / Cmd+N 等带修饰键的应正常解析（标准文本编辑快捷键
      // Cmd+A/C/V/X/Z 不在命令系统中注册，会 fall-through 为浏览器默认行为）
      if (isInput) {
        if (!(e.metaKey || e.ctrlKey)) return;
      }

      // ── 解析快捷键并执行 ──
      const shortcut = buildShortcutString(e);
      if (shortcut) {
        const normalized = normalizeShortcut(shortcut);
        const matchedCommand = resolveEffectiveShortcut(normalized, currentView, deps);

        if (matchedCommand) {
          e.preventDefault();
          commandRegistry.execute(matchedCommand.id, deps).catch(console.error);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, toggle, currentView, deps, resolveEffectiveShortcut]);
  
  // 🚀 getCurrentView getter 替代直接暴露 currentView，使 contextValue 不随视图切换重建
  const getCurrentView = useCallback(() => currentViewRef.current, []);

  const contextValue = useMemo<CommandPaletteContextValue>(() => ({
    isOpen,
    open,
    close,
    toggle,
    executeCommand,
    searchCommands,
    deps,
    currentView: currentViewRef.current,
    getCurrentView,
  }), [isOpen, open, close, toggle, executeCommand, searchCommands, deps, getCurrentView]);
  
  return (
    <CommandPaletteContext.Provider value={contextValue}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

// ==================== Hook ====================

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error('useCommandPalette must be used within a CommandPaletteProvider');
  }
  return context;
}

// ==================== 辅助函数 ====================
// buildShortcutString / normalizeShortcut 等已统一到 shortcutUtils.ts
