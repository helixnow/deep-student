/**
 * MobileLayoutContext - 移动端布局状态管理
 *
 * 管理移动端特有的UI状态：
 * - 当前打开的侧边栏/Sheet
 * - 全屏模式
 * - 手势状态
 */

import React, { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';

/** 可打开的侧边栏类型 */
export type SidebarType =
  | 'sessions'      // 会话列表
  | 'learning-hub'  // 学习资源
  | 'navigation'    // 主导航
  | null;

interface MobileLayoutState {
  /** 是否为移动端布局 */
  isMobile: boolean;

  /** 当前打开的侧边栏 */
  openSidebar: SidebarType;

  /** 打开指定侧边栏 */
  openSidebarPanel: (type: Exclude<SidebarType, null>) => void;

  /** 关闭侧边栏 */
  closeSidebar: () => void;

  /** 切换侧边栏 */
  toggleSidebar: (type: Exclude<SidebarType, null>) => void;

  /** 是否处于全屏内容模式（隐藏底部导航） */
  isFullscreenContent: boolean;

  /** 进入全屏内容模式 */
  enterFullscreen: () => void;

  /** 退出全屏内容模式 */
  exitFullscreen: () => void;
}

const MobileLayoutContext = createContext<MobileLayoutState | null>(null);

export const useMobileLayout = (): MobileLayoutState => {
  const ctx = useContext(MobileLayoutContext);
  if (!ctx) {
    throw new Error('useMobileLayout must be used within MobileLayoutProvider');
  }
  return ctx;
};

/** 安全版本，在非移动端返回默认值 */
export const useMobileLayoutSafe = (): MobileLayoutState | null => {
  return useContext(MobileLayoutContext);
};

interface MobileLayoutProviderProps {
  children: ReactNode;
}

export const MobileLayoutProvider: React.FC<MobileLayoutProviderProps> = ({ children }) => {
  const { isSmallScreen } = useBreakpoint();

  const [openSidebar, setOpenSidebar] = useState<SidebarType>(null);
  const [isFullscreenContent, setIsFullscreenContent] = useState(false);

  const openSidebarPanel = useCallback((type: Exclude<SidebarType, null>) => {
    setOpenSidebar(type);
  }, []);

  const closeSidebar = useCallback(() => {
    setOpenSidebar(null);
  }, []);

  const toggleSidebar = useCallback((type: Exclude<SidebarType, null>) => {
    setOpenSidebar(prev => prev === type ? null : type);
  }, []);

  const enterFullscreen = useCallback(() => {
    setIsFullscreenContent(true);
  }, []);

  const exitFullscreen = useCallback(() => {
    setIsFullscreenContent(false);
  }, []);

  const value = useMemo<MobileLayoutState>(() => ({
    isMobile: isSmallScreen,
    openSidebar,
    openSidebarPanel,
    closeSidebar,
    toggleSidebar,
    isFullscreenContent,
    enterFullscreen,
    exitFullscreen,
  }), [
    isSmallScreen,
    openSidebar,
    openSidebarPanel,
    closeSidebar,
    toggleSidebar,
    isFullscreenContent,
    enterFullscreen,
    exitFullscreen,
  ]);

  return (
    <MobileLayoutContext.Provider value={value}>
      {children}
    </MobileLayoutContext.Provider>
  );
};

export default MobileLayoutProvider;
