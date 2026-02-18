/**
 * TabBar - 学习资源标签页栏
 *
 * 显示已打开的标签页列表，支持切换、关闭、右键菜单。
 */

import React, { useCallback } from 'react';
import { X, FileText, BookOpen, ClipboardList, Languages, PenTool, Image, File, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OpenTab } from '../types/tabs';
import type { ResourceType } from '../types';
import { useTranslation } from 'react-i18next';

// ============================================================================
// 类型定义
// ============================================================================

export interface TabBarProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  onSwitch: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers?: (tabId: string) => void;
  onCloseRight?: (tabId: string) => void;
}

// ============================================================================
// 辅助函数
// ============================================================================

const getAppIcon = (type: ResourceType) => {
  switch (type) {
    case 'note': return FileText;
    case 'textbook': return BookOpen;
    case 'exam': return ClipboardList;
    case 'translation': return Languages;
    case 'essay': return PenTool;
    case 'image': return Image;
    case 'file': return File;
    case 'mindmap': return Workflow;
    default: return FileText;
  }
};

// ============================================================================
// TabItem 子组件
// ============================================================================

interface TabItemProps {
  tab: OpenTab;
  isActive: boolean;
  onSwitch: () => void;
  onClose: () => void;
}

const TabItem: React.FC<TabItemProps> = ({
  tab, isActive, onSwitch, onClose,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const Icon = getAppIcon(tab.type);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  }, [onClose]);

  return (
    <button
      onClick={onSwitch}
      title={tab.dstuPath}
      className={cn(
        'flex items-center gap-1.5 px-3 h-full text-sm whitespace-nowrap',
        'border-r border-border/30 transition-colors group/tab min-w-0 max-w-48',
        isActive
          ? 'bg-background text-foreground border-b-2 border-b-primary'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
    >
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate flex-1 text-xs">{tab.title || t('common:untitled')}</span>
      <X
        className="w-3 h-3 flex-shrink-0 opacity-0 group-hover/tab:opacity-100 hover:text-destructive transition-opacity"
        onClick={handleCloseClick}
      />
    </button>
  );
};

// ============================================================================
// TabBar 主组件
// ============================================================================

export const TabBar: React.FC<TabBarProps> = ({
  tabs, activeTabId, onSwitch, onClose,
}) => {
  if (tabs.length === 0) return null;

  return (
    <div className="flex-shrink-0 flex items-center h-9 border-b border-border/50 bg-muted/30 overflow-x-auto scrollbar-none">
      {tabs.map(tab => (
        <TabItem
          key={tab.tabId}
          tab={tab}
          isActive={tab.tabId === activeTabId}
          onSwitch={() => onSwitch(tab.tabId)}
          onClose={() => onClose(tab.tabId)}
        />
      ))}
    </div>
  );
};
