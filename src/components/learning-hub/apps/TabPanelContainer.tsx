/**
 * TabPanelContainer - 标签页面板保活容器
 *
 * 为每个已打开的标签页渲染一个 UnifiedAppPanel 实例，
 * 通过 display:none 隐藏非活跃标签页，保持其组件状态不丢失。
 */

import React, { lazy, Suspense, useCallback } from 'react';
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

  // ★ UnifiedAppPanel 已使用 ref 持有 onTitleChange，因此回调引用变化不会导致重新加载
  //   这里直接用内联闭包即可，无需复杂的 memoization
  const handleClose = useCallback((tabId: string) => onClose(tabId), [onClose]);
  const handleTitleChange = useCallback((tabId: string, title: string) => onTitleChange(tabId, title), [onTitleChange]);

  return (
    <div className={cn('relative h-full', className)}>
      {tabs.map(tab => {
        const isActive = tab.tabId === activeTabId;
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
                onClose={() => handleClose(tab.tabId)}
                onTitleChange={(title) => handleTitleChange(tab.tabId, title)}
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
