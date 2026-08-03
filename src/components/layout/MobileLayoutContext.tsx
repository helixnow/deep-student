/**
 * MobileLayoutContext - 移动端布局状态管理
 *
 * 管理移动端特有的 UI 状态：
 * - 是否处于移动端布局（<768，与 App shell 同源）
 * - 全屏内容 claim（抑制底部 inset，见 isFullscreenContent）
 */

import React, { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';

interface MobileLayoutState {
  /** 是否为移动端布局 */
  isMobile: boolean;

  /**
   * 是否处于「全屏内容」状态。
   *
   * 语义：抑制底部 inset —— 有任意 claim 存在时，消费方（InputBarUI 底部
   * padding 等）应视为内容占满纵向空间、去掉为底部导航/安全区预留的间距。
   * 典型 claim 来源：MobileSlidingLayout 的侧栏/右屏展开或拖拽中。
   */
  isFullscreenContent: boolean;

  /** 登记一个全屏内容 claim（幂等，按 claimId 去重） */
  enterFullscreen: (claimId?: string) => void;

  /** 释放一个全屏内容 claim */
  exitFullscreen: (claimId?: string) => void;
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

  const [fullscreenClaims, setFullscreenClaims] = useState<Set<string>>(() => new Set());

  const enterFullscreen = useCallback((claimId = 'default') => {
    setFullscreenClaims(prev => {
      if (prev.has(claimId)) return prev;
      const next = new Set(prev);
      next.add(claimId);
      return next;
    });
  }, []);

  const exitFullscreen = useCallback((claimId = 'default') => {
    setFullscreenClaims(prev => {
      if (!prev.has(claimId)) return prev;
      const next = new Set(prev);
      next.delete(claimId);
      return next;
    });
  }, []);

  const isFullscreenContent = fullscreenClaims.size > 0;

  const value = useMemo<MobileLayoutState>(() => ({
    isMobile: isSmallScreen,
    isFullscreenContent,
    enterFullscreen,
    exitFullscreen,
  }), [
    isSmallScreen,
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
