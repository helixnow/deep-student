/**
 * 主题解析 hook
 *
 * 通过 useSyncExternalStore 订阅 StyleRegistry（契约见 registry/StyleRegistry.ts）：
 * - html.dark class 切换（暗色变体 `${id}-dark` 自动解析）
 * - 主题注册 / 注销 / 清空
 *
 * 修复原先节点组件用 useMemo([styleId]) 缓存 StyleRegistry.get 结果、
 * 应用切换暗色模式时不重算、节点卡在旧主题的问题。
 */

import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { StyleRegistry } from '../registry/StyleRegistry';
import type { INodeLevelStyle, IStyleTheme } from '../registry/types';

export interface MindMapThemeContextValue {
  readonly styleId: string;
  readonly theme: IStyleTheme;
  readonly isDark: boolean;
  readonly usesCanvasCssVars?: boolean;
  readonly isLargeGraph?: boolean;
}

export const MindMapThemeContext = createContext<MindMapThemeContextValue | null>(null);

const noopSubscribe = () => () => {};
const subscribe = (listener: () => void) => StyleRegistry.subscribe(listener);

// SSR / 测试环境下 document 不可用时的保守快照
const getServerDarkSnapshot = () => false;

export interface UseMindMapThemeOptions {
  bypassContext?: boolean;
  enabled?: boolean;
}

/**
 * 解析当前应显示的主题（含暗色变体自动映射），
 * styleId 或暗色模式变化时自动返回新引用触发重渲染。
 * 画布内节点通过 MindMapThemeContext 共享单一订阅，避免 250+ 节点各自挂 useSyncExternalStore。
 */
export function useMindMapTheme(
  styleId: string,
  options?: UseMindMapThemeOptions | boolean,
): IStyleTheme {
  const bypassContext = typeof options === 'boolean' ? options : Boolean(options?.bypassContext);
  const enabled = typeof options === 'boolean' ? true : (options?.enabled ?? true);
  const ctx = useContext(MindMapThemeContext);
  const matchesCtx = Boolean(!bypassContext && ctx && (!styleId || styleId === ctx.styleId));
  const getSnapshot = useCallback(
    () => (matchesCtx && ctx ? ctx.theme : StyleRegistry.get(styleId) ?? StyleRegistry.getDefault()),
    [matchesCtx, ctx, styleId],
  );
  return useSyncExternalStore(
    !enabled || matchesCtx ? noopSubscribe : subscribe,
    getSnapshot,
    getSnapshot,
  );
}

/** 当前是否处于暗色模式（html.dark），随 StyleRegistry 通知更新 */
export function useMindMapDarkMode(bypassContext = false): boolean {
  const ctx = useContext(MindMapThemeContext);
  const useCtx = Boolean(!bypassContext && ctx);
  return useSyncExternalStore(
    useCtx ? noopSubscribe : subscribe,
    () => (useCtx && ctx ? ctx.isDark : StyleRegistry.isDarkMode()),
    getServerDarkSnapshot,
  );
}

function sameNodeLevelStructure(
  a: INodeLevelStyle | undefined,
  b: INodeLevelStyle | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fontSize === b.fontSize &&
    a.padding === b.padding &&
    a.borderRadius === b.borderRadius &&
    a.fontWeight === b.fontWeight &&
    Boolean(a.shadow) === Boolean(b.shadow)
  );
}

function sameThemeNonColorStructure(a: IStyleTheme, b: IStyleTheme): boolean {
  if (a === b) return true;
  return (
    Boolean(a.useBranchPalette) === Boolean(b.useBranchPalette) &&
    sameNodeLevelStructure(a.node?.root, b.node?.root) &&
    sameNodeLevelStructure(a.node?.branch, b.node?.branch) &&
    sameNodeLevelStructure(a.node?.leaf, b.node?.leaf)
  );
}

/**
 * 稳定画布 MindMapThemeContext：
 * 非彩虹分支主题（!useBranchPalette）颜色已通过容器 CSS 变量注入，
 * 切换 .dark 时保持 Context 对象引用不变，实现 250+ 节点 0 次 React 重渲染。
 */
export function useStableCanvasThemeContext(
  styleId: string,
  theme: IStyleTheme,
  isDark: boolean,
  isLargeGraph = false,
): MindMapThemeContextValue {
  const usesCanvasCssVars = Boolean(theme && !theme.useBranchPalette);
  const stableRef = useRef<MindMapThemeContextValue | null>(null);
  return useMemo<MindMapThemeContextValue>(() => {
    const prev = stableRef.current;
    if (
      usesCanvasCssVars &&
      prev &&
      prev.usesCanvasCssVars &&
      prev.styleId === styleId &&
      Boolean(prev.isLargeGraph) === isLargeGraph &&
      sameThemeNonColorStructure(prev.theme, theme)
    ) {
      return prev;
    }
    const next: MindMapThemeContextValue = {
      styleId,
      theme,
      isDark,
      usesCanvasCssVars,
      isLargeGraph,
    };
    stableRef.current = next;
    return next;
  }, [styleId, theme, isDark, usesCanvasCssVars, isLargeGraph]);
}
