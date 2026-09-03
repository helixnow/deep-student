/**
 * MobileHeaderContext - 移动端顶部栏状态管理
 *
 * 提供统一的移动端顶栏配置管理：
 * - 各页面通过 useMobileHeader hook 设置自己的 header 配置
 * - MobileSlidingLayout 主栏里的 MobileInFlowHeader（或无抽屉页的 MobilePageScaffold）读取并渲染
 * - 顶栏属于原页面，跟着主栏一起滑，不 fixed 盖住侧栏
 * - ★ 支持视图级别的配置隔离，只有活跃视图的配置才会生效
 */

import React, { createContext, useContext, useState, useCallback, useMemo, useLayoutEffect, useRef, type ReactNode } from 'react';

/** 移动端顶栏配置 */
export interface MobileHeaderConfig {
  /**
   * 是否暂时隐藏整个移动端顶栏。
   *
   * App 壳层会根据 `[data-mobile-shell="header"]` 是否存在同步移除
   * workspace 的顶栏预留高度，适用于需要全屏接管移动层级的页面内面板。
   */
  hidden?: boolean;
  /** 标题（字符串形式） */
  title?: string;
  /** 自定义标题节点（优先级高于 title，用于面包屑等复杂渲染） */
  titleNode?: ReactNode;
  /** 副标题 */
  subtitle?: string;
  /**
   * 右侧操作区域。
   * 约定：≤2 个动作（每个 ≥44px 触控目标）。顶栏无溢出收纳机制，
   * 超过 2 个会挤压标题区并在窄屏溢出；更多动作请收进页面内「更多」菜单。
   */
  rightActions?: ReactNode;
  /** 是否显示菜单按钮（用于打开次级侧边栏） */
  showMenu?: boolean;
  /** 只显示浮动左右入口（侧栏 / 新对话），不渲染占位顶栏（用于聊天新对话空态） */
  floatingMenuButton?: boolean;
  /** 点击菜单按钮的回调 */
  onMenuClick?: () => void;
  /** 是否显示返回箭头（替代菜单图标） */
  showBackArrow?: boolean;
  /** 隐藏全局回退按钮（仅当页面不希望显示任何左侧导航按钮时使用） */
  suppressGlobalBackButton?: boolean;
}

/** Context 值类型 */
interface MobileHeaderContextValue {
  /** 当前配置 */
  config: MobileHeaderConfig;
  /**
   * 活跃视图的左抽屉是否展开。仅作状态同步；顶栏不再根据它卸载或改成 fixed。
   */
  drawerOpen: boolean;
  /** 设置配置（带视图 ID） */
  setConfig: (viewId: string, config: MobileHeaderConfig) => void;
  /** 由调用方汇报左抽屉开合（当前滑动布局不再消费） */
  setDrawerOpen: (open: boolean) => void;
  /** 清除某视图缓存的配置（视图卸载时调用，释放 rightActions 等引用） */
  clearConfig: (viewId: string) => void;
  /** 重置配置 */
  resetConfig: () => void;
  /** 设置活跃视图（由 App.tsx 调用） */
  setActiveView: (viewId: string) => void;
}

const defaultConfig: MobileHeaderConfig = {
  hidden: false,
  title: '',
  subtitle: undefined,
  rightActions: undefined,
  showMenu: false,
  floatingMenuButton: false,
  onMenuClick: undefined,
};

const MobileHeaderContext = createContext<MobileHeaderContextValue | null>(null);

/** 仅包含写操作的 context：引用永久稳定，供 useMobileHeader 等“只写不读”的
 * 消费者使用，避免 config 每次变化都重渲染所有页面组件（曾导致
 * “页面渲染 → 效果重跑 → setConfig → config 变化 → 页面再渲染”的无限循环）。 */
type MobileHeaderActions = Omit<MobileHeaderContextValue, 'config' | 'drawerOpen'>;
const MobileHeaderActionsContext = createContext<MobileHeaderActions | null>(null);

/** Provider 组件 */
export const MobileHeaderProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // 当前显示的配置
  const [config, setConfigState] = useState<MobileHeaderConfig>(defaultConfig);
  const [drawerOpen, setDrawerOpenState] = useState(false);
  // 当前活跃视图
  const activeViewRef = useRef<string>('');
  // 各视图的配置缓存
  const configCacheRef = useRef<Map<string, MobileHeaderConfig>>(new Map());

  // 设置配置（带视图 ID）
  const setConfig = useCallback((viewId: string, newConfig: MobileHeaderConfig) => {
    // 缓存该视图的配置
    configCacheRef.current.set(viewId, newConfig);
    // 只有当前活跃视图才立即应用配置
    if (activeViewRef.current === viewId) {
      setConfigState(newConfig);
    }
  }, []);

  // 清除某视图的缓存配置：视图被 LRU 驱逐/切壳卸载后，缓存里的 rightActions
  // ReactNode 及其闭包会一直滞留内存；且回到该视图时会先应用指向已卸载组件
  // 的陈旧回调（重挂载完成前的窗口期内可被点击）。由 useMobileHeader 卸载时调用。
  const clearConfig = useCallback((viewId: string) => {
    configCacheRef.current.delete(viewId);
  }, []);

  // 设置活跃视图
  const setActiveView = useCallback((viewId: string) => {
    // 视图未变化时跳过，避免 Provider 重渲染 → effect 重跑 → setState 的无限循环
    if (activeViewRef.current === viewId) {
      return;
    }
    activeViewRef.current = viewId;
    // 应用该视图缓存的配置；没有缓存（懒加载组件还没加载）时先显示空配置，页面加载后会更新
    const cachedConfig = configCacheRef.current.get(viewId) ?? defaultConfig;
    setConfigState((prev) => (prev === cachedConfig ? prev : cachedConfig));
  }, []);

  const resetConfig = useCallback(() => {
    setConfigState(defaultConfig);
  }, []);

  const setDrawerOpen = useCallback((open: boolean) => {
    setDrawerOpenState((prev) => (prev === open ? prev : open));
  }, []);

  // 稳定 context 引用：只有 config / drawerOpen 变化时才产生新值，防止依赖 ctx 的 effect 每次提交都重跑
  const contextValue = useMemo(
    () => ({ config, drawerOpen, setConfig, setDrawerOpen, clearConfig, resetConfig, setActiveView }),
    [config, drawerOpen, setConfig, setDrawerOpen, clearConfig, resetConfig, setActiveView],
  );

  // 所有回调都是 [] 依赖的 useCallback，此对象在 Provider 生命周期内引用不变
  const actionsValue = useMemo(
    () => ({ setConfig, setDrawerOpen, clearConfig, resetConfig, setActiveView }),
    [setConfig, setDrawerOpen, clearConfig, resetConfig, setActiveView],
  );

  return (
    <MobileHeaderActionsContext.Provider value={actionsValue}>
      <MobileHeaderContext.Provider value={contextValue}>
        {children}
      </MobileHeaderContext.Provider>
    </MobileHeaderActionsContext.Provider>
  );
};

/** 获取 Context（内部使用） */
export const useMobileHeaderContext = (): MobileHeaderContextValue => {
  const ctx = useContext(MobileHeaderContext);
  if (!ctx) {
    throw new Error('useMobileHeaderContext must be used within MobileHeaderProvider');
  }
  return ctx;
};

/** 安全版本，在非 Provider 内返回 null */
export const useMobileHeaderContextSafe = (): MobileHeaderContextValue | null => {
  return useContext(MobileHeaderContext);
};

/** 仅写抽屉开合，引用稳定，供 MobileSlidingLayout 汇报而不订阅 config */
export function useSetMobileDrawerOpen(): (open: boolean) => void {
  const ctx = useContext(MobileHeaderActionsContext);
  return useCallback((open: boolean) => {
    ctx?.setDrawerOpen(open);
  }, [ctx]);
}

/**
 * useMobileHeader - 页面级别设置移动端顶栏配置
 *
 * @param viewId - 视图 ID（如 'learning-hub', 'chat-v2'），用于配置隔离
 * @param config - 顶栏配置
 * @param deps - 依赖数组，当依赖变化时更新配置
 * @param enabled - 是否启用（默认 true）。false 时既不写入配置，卸载时也不清除
 *   该 viewId 的缓存 —— 用于组件以嵌入形态复用时，避免覆盖/清掉真正
 *   活跃视图实例在同名 viewId 下的配置
 *
 * @example
 * ```tsx
 * // 基础用法
 * useMobileHeader('settings', { title: '设置' });
 *
 * // 带右侧操作
 * useMobileHeader('learning-hub', {
 *   title: '学习资源',
 *   rightActions: <Button>刷新</Button>
 * }, []);
 *
 * // 动态标题
 * useMobileHeader('chat-v2', {
 *   title: currentSession?.title || '聊天',
 * }, [currentSession?.title]);
 *
 * // 嵌入形态时禁用（不接管顶栏）
 * useMobileHeader('data-management', { title: '数据管理' }, [embedded], !embedded);
 * ```
 */
export function useMobileHeader(
  viewId: string,
  config: MobileHeaderConfig,
  deps: React.DependencyList = [],
  enabled: boolean = true,
): void {
  // 只订阅写操作 context：引用稳定，config 更新不会触发调用方重渲染
  const ctx = useContext(MobileHeaderActionsContext);
  const configRef = useRef(config);
  configRef.current = config;
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // 使用 useLayoutEffect 同步更新配置
  useLayoutEffect(() => {
    if (ctx && enabledRef.current) {
      ctx.setConfig(viewIdRef.current, configRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 首次挂载时立即设置配置；卸载时清除缓存（防止 LRU 驱逐后配置滞留，见 clearConfig 注释）
  useLayoutEffect(() => {
    if (ctx && enabledRef.current) {
      ctx.setConfig(viewIdRef.current, configRef.current);
    }
    return () => {
      // enabled=false 的实例从未写入配置，不能清同名 viewId 的缓存，
      // 否则会误删真正活跃视图实例的配置
      if (enabledRef.current) {
        ctx?.clearConfig(viewIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅首次挂载/卸载时执行
}

/**
 * useSetMobileHeaderActiveView - 供 App.tsx 调用，设置当前活跃视图
 */
export function useSetMobileHeaderActiveView(): (viewId: string) => void {
  const ctx = useContext(MobileHeaderActionsContext);
  return useCallback((viewId: string) => {
    ctx?.setActiveView(viewId);
  }, [ctx]);
}

/**
 * MobileHeaderActiveViewSync - 在 MobileHeaderProvider 内部同步 activeView
 *
 * 必须放在 MobileHeaderProvider 内部使用，因为需要访问 Context
 */
export const MobileHeaderActiveViewSync: React.FC<{ activeView: string }> = ({ activeView }) => {
  const ctx = useContext(MobileHeaderActionsContext);

  useLayoutEffect(() => {
    if (ctx) {
      ctx.setActiveView(activeView);
    }
  }, [activeView, ctx]);

  return null;
};

/** 顶栏返回/前进（App 注入，供页内顶栏而不是壳层 fixed 顶栏消费） */
export interface MobileHeaderNav {
  canGoBack?: boolean;
  onBack?: () => void;
  canGoForward?: boolean;
  onForward?: () => void;
  fallbackTitle?: string;
}

const MobileHeaderNavContext = createContext<MobileHeaderNav | null>(null);

export const MobileHeaderNavProvider: React.FC<{ value: MobileHeaderNav; children: ReactNode }> = ({
  value,
  children,
}) => (
  <MobileHeaderNavContext.Provider value={value}>{children}</MobileHeaderNavContext.Provider>
);

export function useMobileHeaderNav(): MobileHeaderNav | null {
  return useContext(MobileHeaderNavContext);
}

export default MobileHeaderProvider;
