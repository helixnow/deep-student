/**
 * TabPanelContainer - 标签页面板保活容器
 *
 * 为每个已打开的标签页渲染一个 UnifiedAppPanel 实例，
 * 通过 display:none 隐藏非活跃标签页，保持其组件状态不丢失。
 */

import React, { lazy, Suspense, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OpenTab } from '../types/tabs';
import { useTranslation } from 'react-i18next';

// 懒加载统一应用面板
const UnifiedAppPanel = lazy(() => import('./UnifiedAppPanel'));

// ============================================================================
// 类型定义
// ============================================================================

export interface TabPanelContainerProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  onClose: (tabId: string) => void;
  onTitleChange: (tabId: string, title: string) => void;
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

export const TabPanelContainer: React.FC<TabPanelContainerProps> = ({
  tabs, activeTabId, onClose, onTitleChange, className,
}) => {
  const { t } = useTranslation('common');

  // ★ 为每个 tab 创建稳定的回调引用，避免 onTitleChange 闭包导致
  //   UnifiedAppPanel 内部 useEffect 重新触发 dstu.get()
  //   （见批判性检查 C-1）
  const stableCallbacks = useMemo(() => {
    const map = new Map<string, {
      onClose: () => void;
      onTitleChange: (title: string) => void;
    }>();
    for (const tab of tabs) {
      map.set(tab.tabId, {
        onClose: () => onClose(tab.tabId),
        onTitleChange: (title: string) => onTitleChange(tab.tabId, title),
      });
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map(t => t.tabId).join(','), onClose, onTitleChange]);

  return (
    <div className={cn('relative h-full', className)}>
      {tabs.map(tab => {
        const isActive = tab.tabId === activeTabId;
        const callbacks = stableCallbacks.get(tab.tabId);
        return (
          <div
            key={tab.tabId}
            className="absolute inset-0"
            style={{ display: isActive ? 'flex' : 'none' }}
          >
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full w-full">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-muted-foreground">
                    {t('loading', '加载中...')}
                  </span>
                </div>
              }
            >
              <UnifiedAppPanel
                type={tab.type}
                resourceId={tab.resourceId}
                dstuPath={tab.dstuPath}
                onClose={callbacks?.onClose}
                onTitleChange={callbacks?.onTitleChange}
                isActive={isActive}
                className="h-full w-full"
              />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
};
