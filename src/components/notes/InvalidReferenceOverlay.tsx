/**
 * 失效引用覆盖层组件
 *
 * 用于在失效的引用节点上显示警告提示和操作按钮
 *
 * 根据文档18第八章"引用有效性校验"实现：
 * - 失效引用显示"已失效"样式（灰色 + 删除线 + 警告图标）
 * - 不可预览、不可"引用到对话"
 * - 提供"清理失效引用"和"刷新标题"功能
 */

import React, { memo } from 'react';
import { AlertTriangle, Trash2, RefreshCw, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { NotionButton } from '@/components/ui/NotionButton';

// ============================================================================
// 类型定义
// ============================================================================

export interface InvalidReferenceOverlayProps {
  /** 是否显示覆盖层 */
  show: boolean;
  /** 是否正在校验中 */
  isValidating?: boolean;
  /** 是否正在刷新标题 */
  isRefreshing?: boolean;
  /** 删除按钮点击回调 */
  onRemove?: () => void;
  /** 刷新标题按钮点击回调 */
  onRefreshTitle?: () => void;
  /** 额外的类名 */
  className?: string;
  /** 是否只显示图标（紧凑模式，用于树节点） */
  compact?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 失效引用覆盖层
 *
 * 可在两种模式下使用：
 * 1. 完整模式（compact=false）：显示完整的警告信息和操作按钮
 * 2. 紧凑模式（compact=true）：仅显示警告图标，悬停显示提示
 */
export const InvalidReferenceOverlay: React.FC<InvalidReferenceOverlayProps> = memo(
  function InvalidReferenceOverlay({
    show,
    isValidating = false,
    isRefreshing = false,
    onRemove,
    onRefreshTitle,
    className,
    compact = false,
  }) {
    const { t } = useTranslation(['notes']);

    // 不显示时返回 null
    if (!show && !isValidating) {
      return null;
    }

    // 校验中状态
    if (isValidating) {
      return (
        <div
          className={cn(
            'inline-flex items-center justify-center',
            compact ? 'ml-1' : 'ml-2',
            className
          )}
          title={t('notes:reference.validating')}
        >
          <Loader2 
            className={cn(
              'animate-spin text-muted-foreground',
              compact ? 'w-3 h-3' : 'w-4 h-4'
            )} 
          />
        </div>
      );
    }

    // 紧凑模式：仅显示警告图标
    if (compact) {
      return (
        <CommonTooltip 
          content={<p className="text-xs">{t('notes:reference.invalid')}</p>}
          position="top"
        >
          <span
            className={cn(
              'inline-flex items-center justify-center ml-1 cursor-help',
              className
            )}
          >
            <AlertTriangle className="w-3 h-3 text-warning" />
          </span>
        </CommonTooltip>
      );
    }

    // 完整模式：显示警告信息和操作按钮
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1',
          'bg-warning/10 dark:bg-warning/20',
          'border border-warning/30 dark:border-warning/40',
          'rounded-md',
          className
        )}
      >
        {/* 警告图标和文字 */}
        <div className="flex items-center gap-1.5 text-warning">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span className="text-xs font-medium">
            {t('notes:reference.invalid')}
          </span>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 ml-auto">
          {/* 刷新标题按钮 */}
          {onRefreshTitle && (
            <CommonTooltip 
              content={<p className="text-xs">{t('notes:reference.refreshTitle')}</p>}
              position="top"
            >
              <NotionButton
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefreshTitle();
                }}
                disabled={isRefreshing}
              >
                {isRefreshing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
              </NotionButton>
            </CommonTooltip>
          )}

          {/* 删除按钮 */}
          {onRemove && (
            <CommonTooltip 
              content={<p className="text-xs">{t('notes:reference.remove')}</p>}
              position="top"
            >
              <NotionButton
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
              >
                <Trash2 className="w-3 h-3" />
              </NotionButton>
            </CommonTooltip>
          )}
        </div>
      </div>
    );
  }
);

// ============================================================================
// 失效引用警告图标（用于树节点标题后面）
// ============================================================================

export interface InvalidReferenceIconProps {
  /** 是否显示（引用失效时为 true） */
  isInvalid: boolean;
  /** 是否正在校验中 */
  isValidating?: boolean;
  /** 额外的类名 */
  className?: string;
}

/**
 * 失效引用警告图标
 *
 * 用于在树节点标题后显示警告图标
 */
export const InvalidReferenceIcon: React.FC<InvalidReferenceIconProps> = memo(
  function InvalidReferenceIcon({
    isInvalid,
    isValidating = false,
    className,
  }) {
    const { t } = useTranslation(['notes']);

    if (isValidating) {
      return (
        <span
          className={cn('inline-flex items-center ml-1', className)}
          title={t('notes:reference.validating')}
        >
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        </span>
      );
    }

    if (!isInvalid) {
      return null;
    }

    return (
      <CommonTooltip 
        content={<p className="text-xs">{t('notes:reference.invalid')}</p>}
        position="top"
      >
        <span
          className={cn('inline-flex items-center ml-1 cursor-help', className)}
        >
          <AlertTriangle className="w-3 h-3 text-warning" />
        </span>
      </CommonTooltip>
    );
  }
);

export default InvalidReferenceOverlay;
