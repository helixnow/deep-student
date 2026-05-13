/**
 * Learning Hub 操作栏组件
 *
 * 文档 20 Prompt 4: 访达侧栏容器
 *
 * 功能：
 * - 显示选中资源信息
 * - 引用到对话按钮
 * - 预览按钮
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquarePlus, Eye, FileQuestion } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import type { LearningHubActionBarProps } from './types';

/**
 * 操作栏组件
 */
export const LearningHubActionBar: React.FC<LearningHubActionBarProps> = ({
  selectedItem,
  referenceNode,
  itemCount,
  canReferenceToChat,
  onReferenceToChat,
  onPreview,
  isLoading = false,
  className,
}) => {
  const { t } = useTranslation('learningHub');

  // 是否有选中项
  const hasSelection = !!selectedItem;

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-4 min-h-[52px] border-t border-border bg-muted/30',
        className
      )}
    >
      {/* 左侧：资源数量 + 选中项信息 */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        {/* 资源数量 */}
        {typeof itemCount === 'number' && (
          <span className="text-xs text-muted-foreground shrink-0">
            {t('actionBar.itemCount', { count: itemCount })}
          </span>
        )}
        
        {/* 选中项信息 */}
        {hasSelection ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-muted-foreground/60">|</span>
            <span className="text-sm font-medium truncate text-foreground">
              {selectedItem.title || t('gridItem.untitled')}
            </span>
            {selectedItem.type && (
               <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wider shrink-0">
                 {selectedItem.type}
               </span>
            )}
          </div>
        ) : !itemCount ? (
          <div className="flex items-center gap-2 text-muted-foreground/70">
            <FileQuestion className="h-4 w-4 shrink-0" />
            <span className="text-sm">{t('actionBar.noSelection')}</span>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {/* 预览按钮 */}
        {onPreview && hasSelection && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onPreview}
            disabled={isLoading}
            className="shrink-0 h-8 text-xs"
          >
            <Eye className="h-3.5 w-3.5 mr-1.5" />
            {t('actionBar.preview')}
          </NotionButton>
        )}

        {/* 引用到对话按钮 */}
        <NotionButton
          variant="default"
          size="sm"
          onClick={onReferenceToChat}
          disabled={!canReferenceToChat || isLoading || !hasSelection}
          className="shrink-0 h-8 text-xs shadow-sm"
        >
          <MessageSquarePlus className="h-3.5 w-3.5 mr-1.5" />
          {t('actionBar.referenceToChat')}
        </NotionButton>
      </div>
    </div>
  );
};

LearningHubActionBar.displayName = 'LearningHubActionBar';

export default LearningHubActionBar;
