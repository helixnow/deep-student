/**
 * Chat V2 - MobileSheetHeader 移动端抽屉统一头部组件
 *
 * 为所有移动端底部抽屉提供一致的头部样式：
 * - 图标 + 标题 + 可选副标题/徽章
 * - 可选操作按钮（刷新等）
 * - 关闭按钮
 */

import React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';

export interface MobileSheetHeaderProps {
  /** 左侧图标 */
  icon: React.ReactNode;
  /** 标题文字 */
  title: string;
  /** 副标题（可选） */
  subtitle?: string;
  /** 徽章内容（数字或文字，可选） */
  badge?: number | string;
  /** 右侧额外操作按钮（可选） */
  actions?: React.ReactNode;
  /** 关闭回调 */
  onClose?: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * MobileSheetHeader - 移动端抽屉统一头部
 *
 * 设计规范：
 * - 固定在抽屉顶部（拖拽手柄下方）
 * - 左侧：图标 + 标题 + 可选徽章
 * - 右侧：操作按钮 + 关闭按钮
 * - 底部有分隔线
 */
export const MobileSheetHeader: React.FC<MobileSheetHeaderProps> = ({
  icon,
  title,
  subtitle,
  badge,
  actions,
  onClose,
  className,
}) => {
  return (
    <div
      className={cn(
        'flex items-center justify-between pb-3 mb-3 border-b border-border flex-shrink-0',
        className
      )}
    >
      {/* 左侧：图标 + 标题 + 副标题/徽章 */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* 图标 */}
        <span className="text-primary shrink-0">{icon}</span>

        {/* 标题区域 */}
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-medium text-sm text-foreground whitespace-nowrap">
            {title}
          </span>

          {/* 徽章 */}
          {badge !== undefined && badge !== null && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary whitespace-nowrap">
              {badge}
            </span>
          )}

          {/* 副标题 */}
          {subtitle && (
            <span className="text-xs text-muted-foreground truncate">
              {subtitle}
            </span>
          )}
        </div>
      </div>

      {/* 右侧：操作按钮 + 关闭按钮 */}
      <div className="flex items-center gap-1 shrink-0 ml-2">
        {actions}

        {onClose && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onClose();
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="-m-1 touch-manipulation"
            aria-label="Close"
            style={{ touchAction: 'manipulation' }}
          >
            <X size={20} />
          </NotionButton>
        )}
      </div>
    </div>
  );
};

export default MobileSheetHeader;
