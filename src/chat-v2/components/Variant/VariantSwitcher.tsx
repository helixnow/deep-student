/**
 * Chat V2 - VariantSwitcher 变体切换器组件
 *
 * 水平标签页切换变体
 * - 显示所有变体的模型名称和状态
 * - error 状态变体置灰不可点击
 * - 支持键盘导航
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { VariantStatusIcon } from './VariantStatusIcon';
import type { Variant, VariantStatus } from '../../core/types/message';

// ============================================================================
// Props 定义
// ============================================================================

export interface VariantSwitcherProps {
  /** 变体列表 */
  variants: Variant[];
  /** 当前激活的变体 ID */
  activeVariantId?: string;
  /** 切换变体回调 */
  onSwitch: (variantId: string) => void;
  /** 是否禁用切换 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 获取模型显示名称 */
  getModelDisplayName?: (modelId: string) => string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断变体是否可切换
 * 可切换状态: pending, streaming, success, cancelled
 * 不可切换: error
 */
function isVariantSwitchable(status: VariantStatus): boolean {
  return status !== 'error';
}

/**
 * 默认的模型名称显示函数
 */
function defaultGetModelDisplayName(modelId: string): string {
  // 尝试提取可读名称
  // 例如: gpt-4-turbo -> GPT-4 Turbo
  // claude-3-5-sonnet -> Claude 3.5 Sonnet
  return modelId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * VariantSwitcher 变体切换器
 *
 * 功能：
 * 1. 水平标签页显示所有变体
 * 2. 显示变体状态图标
 * 3. error 状态禁用点击
 * 4. 支持键盘导航 (Arrow Left/Right)
 */
export const VariantSwitcher: React.FC<VariantSwitcherProps> = ({
  variants,
  activeVariantId,
  onSwitch,
  disabled = false,
  className,
  getModelDisplayName = defaultGetModelDisplayName,
}) => {
  const { t } = useTranslation('chatV2');

  // 当前激活索引
  const activeIndex = useMemo(() => {
    return variants.findIndex((v) => v.id === activeVariantId);
  }, [variants, activeVariantId]);

  // 处理切换
  const handleSwitch = useCallback(
    (variant: Variant) => {
      if (disabled) return;
      if (!isVariantSwitchable(variant.status)) return;
      if (variant.id === activeVariantId) return;
      onSwitch(variant.id);
    },
    [disabled, activeVariantId, onSwitch]
  );

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (disabled) return;

      let targetIndex = -1;

      if (e.key === 'ArrowLeft') {
        // 向左查找可切换的变体
        for (let i = index - 1; i >= 0; i--) {
          if (isVariantSwitchable(variants[i].status)) {
            targetIndex = i;
            break;
          }
        }
      } else if (e.key === 'ArrowRight') {
        // 向右查找可切换的变体
        for (let i = index + 1; i < variants.length; i++) {
          if (isVariantSwitchable(variants[i].status)) {
            targetIndex = i;
            break;
          }
        }
      }

      if (targetIndex >= 0) {
        e.preventDefault();
        onSwitch(variants[targetIndex].id);
      }
    },
    [disabled, variants, onSwitch]
  );

  // 单变体或无变体时不显示
  if (variants.length <= 1) {
    return null;
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 p-1 rounded-lg',
        'bg-muted/50 dark:bg-muted/30',
        className
      )}
      role="tablist"
      aria-label={t('variant.switcher')}
    >
      {variants.map((variant, index) => {
        const isActive = variant.id === activeVariantId;
        const isSwitchable = isVariantSwitchable(variant.status);
        const isDisabled = disabled || !isSwitchable;

        return (
          <button
            key={variant.id}
            role="tab"
            aria-selected={isActive}
            aria-disabled={isDisabled}
            tabIndex={isActive ? 0 : -1}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md',
              'text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : isDisabled
                ? 'text-muted-foreground/50 cursor-not-allowed'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
            )}
            onClick={() => handleSwitch(variant)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            title={
              !isSwitchable
                ? t('variant.cannotActivateFailed')
                : t('variant.switchTo', {
                    model: getModelDisplayName(variant.modelId),
                  })
            }
          >
            <VariantStatusIcon status={variant.status} size="sm" />
            <span className="truncate max-w-[100px]">
              {getModelDisplayName(variant.modelId)}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default VariantSwitcher;
