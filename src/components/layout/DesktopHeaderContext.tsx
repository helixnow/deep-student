/**
 * DesktopHeaderContext - 桌面端（经典壳）右侧顶栏统一状态管理
 *
 * 对齐移动端 MobileHeaderContext 的视图隔离模式：
 * - 各页面通过 useDesktopHeader(viewId, config, deps, enabled) 声明面包屑、附注与右侧操作；
 * - AppShellChrome 统一渲染 `[>_ 命令面板] + [面包屑] + [可拖拽空白区] + [右侧操作] + [窗口三键]`；
 * - 多视图保活时只呈现当前活跃视图注册的配置，避免跨页串味或陈旧闭包滞留。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** 桌面顶栏单级面包屑项 */
export interface DesktopBreadcrumbItem {
  /** 稳定键；缺省时回退 label 与索引 */
  id?: string;
  /** 展示文本（须经 i18n） */
  label: string;
  /** 点击回调：提供时该级可点击导航（通常用于父级返回上级） */
  onClick?: () => void;
  /** 自定义末级节点（如对话页内联重命名编辑器） */
  render?: ReactNode;
  /** 完整悬浮提示；缺省时回退 label */
  title?: string;
}

/** 桌面顶栏配置 */
export interface DesktopHeaderConfig {
  /**
   * 面包屑链路：一级页面 / 二级分类 / 当前项。
   * 未提供或为空时，壳层自动回退为当前视图的默认标题。
   */
  breadcrumbs?: DesktopBreadcrumbItem[];
  /**
   * 末级面包屑右侧的轻量状态附注（如计数「66 个」「1 待完成」或状态 chip）。
   * 空间不足时优先收敛，保证面包屑主体可读。
   */
  meta?: ReactNode;
  /**
   * 右侧操作区（折叠搜索 + 动作按钮 + 溢出菜单）。
   * 统一使用 28px 高度与透明 ghost 变体，主 CTA 最多 1 个。
   */
  actions?: ReactNode;
}

interface DesktopHeaderContextValue {
  config: DesktopHeaderConfig | null;
  activeView: string;
  setConfig: (viewId: string, config: DesktopHeaderConfig) => void;
  clearConfig: (viewId: string) => void;
  setActiveView: (viewId: string) => void;
}

type DesktopHeaderActions = Pick<
  DesktopHeaderContextValue,
  'setConfig' | 'clearConfig' | 'setActiveView'
>;

const DesktopHeaderContext = createContext<DesktopHeaderContextValue | null>(null);
const DesktopHeaderActionsContext = createContext<DesktopHeaderActions | null>(null);

export const DesktopHeaderProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [config, setConfigState] = useState<DesktopHeaderConfig | null>(null);
  const [activeView, setActiveViewState] = useState<string>('');
  const activeViewRef = useRef<string>('');
  const configCacheRef = useRef<Map<string, DesktopHeaderConfig>>(new Map());

  const setConfig = useCallback((viewId: string, nextConfig: DesktopHeaderConfig) => {
    configCacheRef.current.set(viewId, nextConfig);
    if (activeViewRef.current === viewId) {
      setConfigState(nextConfig);
    }
  }, []);

  const clearConfig = useCallback((viewId: string) => {
    configCacheRef.current.delete(viewId);
    if (activeViewRef.current === viewId) {
      setConfigState(null);
    }
  }, []);

  const setActiveView = useCallback((viewId: string) => {
    if (activeViewRef.current === viewId) {
      return;
    }
    activeViewRef.current = viewId;
    setActiveViewState(viewId);
    const cached = configCacheRef.current.get(viewId) ?? null;
    setConfigState((prev) => (prev === cached ? prev : cached));
  }, []);

  const contextValue = useMemo(
    () => ({ config, activeView, setConfig, clearConfig, setActiveView }),
    [config, activeView, setConfig, clearConfig, setActiveView],
  );

  const actionsValue = useMemo(
    () => ({ setConfig, clearConfig, setActiveView }),
    [setConfig, clearConfig, setActiveView],
  );

  return (
    <DesktopHeaderActionsContext.Provider value={actionsValue}>
      <DesktopHeaderContext.Provider value={contextValue}>
        {children}
      </DesktopHeaderContext.Provider>
    </DesktopHeaderActionsContext.Provider>
  );
};

export function useDesktopHeaderContextSafe(): DesktopHeaderContextValue | null {
  return useContext(DesktopHeaderContext);
}

/** 当前子树是否位于经典壳 DesktopHeaderProvider 内（孤立单测或非经典壳宿主机理下返回 false） */
export function useHasDesktopHeaderHost(): boolean {
  return useContext(DesktopHeaderActionsContext) !== null;
}

/**
 * useDesktopHeader - 页面声明式注册桌面端（经典壳）右侧顶栏内容
 *
 * @param viewId - 视图 ID（与 shell.views 一致，用于多视图保活隔离）
 * @param config - 面包屑、状态附注与右侧动作配置
 * @param deps - 触发同步更新的依赖数组
 * @param enabled - 是否启用；嵌入 Workbench 窗口或处于小屏时应传 false，
 *                  避免覆盖或清理经典壳同名视图的配置
 */
export function useDesktopHeader(
  viewId: string,
  config: DesktopHeaderConfig,
  deps: React.DependencyList = [],
  enabled: boolean = true,
): void {
  const ctx = useContext(DesktopHeaderActionsContext);
  const configRef = useRef(config);
  configRef.current = config;
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const hasWrittenRef = useRef(false);

  useLayoutEffect(() => {
    if (!ctx) return;
    if (enabled) {
      ctx.setConfig(viewId, configRef.current);
      hasWrittenRef.current = true;
    } else if (hasWrittenRef.current) {
      ctx.clearConfig(viewId);
      hasWrittenRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, viewId, enabled, ...deps]);

  useLayoutEffect(() => {
    const registeredViewId = viewId;
    return () => {
      if (hasWrittenRef.current) {
        ctx?.clearConfig(registeredViewId);
        hasWrittenRef.current = false;
      }
    };
  }, [ctx, viewId]);
}

/** 在 DesktopHeaderProvider 内部同步当前活跃视图 */
export const DesktopHeaderActiveViewSync: React.FC<{ activeView: string }> = ({ activeView }) => {
  const ctx = useContext(DesktopHeaderActionsContext);

  useLayoutEffect(() => {
    ctx?.setActiveView(activeView);
  }, [activeView, ctx]);

  return null;
};
