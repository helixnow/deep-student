/**
 * Chat V2 - VariantActions 变体操作菜单组件
 *
 * 提供变体的操作菜单：
 * - 取消（streaming 状态）
 * - 重试（error/cancelled 状态）
 * - 删除（非最后一个变体）
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  MoreHorizontal,
  Square,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import type { Variant, VariantStatus } from '../../core/types/message';

// ============================================================================
// Props 定义
// ============================================================================

export interface VariantActionsProps {
  /** 变体信息 */
  variant: Variant;
  /** 消息 ID */
  messageId: string;
  /** 是否是最后一个变体 */
  isLastVariant: boolean;
  /** 取消变体回调 */
  onCancel?: (variantId: string) => Promise<void>;
  /** 重试变体回调 */
  onRetry?: (messageId: string, variantId: string) => Promise<void>;
  /** 删除变体回调 */
  onDelete?: (messageId: string, variantId: string) => Promise<void>;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断是否可以取消变体
 */
function canCancelVariant(status: VariantStatus): boolean {
  return status === 'streaming' || status === 'pending';
}

/**
 * 判断是否可以重试变体
 */
function canRetryVariant(status: VariantStatus): boolean {
  return status === 'error' || status === 'cancelled';
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * VariantActions 变体操作菜单
 */
export const VariantActions: React.FC<VariantActionsProps> = ({
  variant,
  messageId,
  isLastVariant,
  onCancel,
  onRetry,
  onDelete,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [isLoading, setIsLoading] = useState(false);

  const showCancel = canCancelVariant(variant.status) && onCancel;
  const showRetry = canRetryVariant(variant.status) && onRetry;
  const showDelete = !isLastVariant && onDelete;

  // 如果没有任何可用操作，不显示菜单
  if (!showCancel && !showRetry && !showDelete) {
    return null;
  }

  // 处理取消
  const handleCancel = useCallback(async () => {
    if (!onCancel || isLoading) return;

    setIsLoading(true);
    try {
      await onCancel(variant.id);
      showGlobalNotification('success', t('variant.cancelled'));
    } catch (error: unknown) {
      console.error('[VariantActions] Cancel failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('variant.cancelFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [onCancel, variant.id, isLoading, t]);

  // 处理重试
  const handleRetry = useCallback(async () => {
    if (!onRetry || isLoading) return;

    setIsLoading(true);
    try {
      await onRetry(messageId, variant.id);
      showGlobalNotification('info', t('variant.retrying'));
    } catch (error: unknown) {
      console.error('[VariantActions] Retry failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('variant.retryFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [onRetry, messageId, variant.id, isLoading, t]);

  // 处理删除
  const handleDelete = useCallback(async () => {
    if (!onDelete || isLoading) return;

    setIsLoading(true);
    try {
      await onDelete(messageId, variant.id);
      showGlobalNotification('success', t('variant.deleted'));
    } catch (error: unknown) {
      console.error('[VariantActions] Delete failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('variant.deleteFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [onDelete, messageId, variant.id, isLoading, t]);

  return (
    <AppMenu>
      <AppMenuTrigger asChild>
        <NotionButton variant="ghost" size="icon" iconOnly disabled={isLoading} className={cn(isLoading && 'opacity-50', className)} aria-label={t('variant.actions')}>
          <MoreHorizontal className="w-4 h-4" />
        </NotionButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" width={160}>
        {/* 取消 */}
        {showCancel && (
          <AppMenuItem
            onClick={handleCancel}
            disabled={isLoading}
            icon={<Square className="w-4 h-4" />}
          >
            {t('variant.cancel')}
          </AppMenuItem>
        )}

        {/* 重试 */}
        {showRetry && (
          <AppMenuItem
            onClick={handleRetry}
            disabled={isLoading}
            icon={<RotateCcw className="w-4 h-4" />}
          >
            {t('variant.retry')}
          </AppMenuItem>
        )}

        {/* 分隔线 */}
        {(showCancel || showRetry) && showDelete && <AppMenuSeparator />}

        {/* 删除 */}
        {showDelete && (
          <AppMenuItem
            onClick={handleDelete}
            disabled={isLoading}
            destructive
            icon={<Trash2 className="w-4 h-4" />}
          >
            {t('variant.delete')}
          </AppMenuItem>
        )}
      </AppMenuContent>
    </AppMenu>
  );
};

export default VariantActions;
