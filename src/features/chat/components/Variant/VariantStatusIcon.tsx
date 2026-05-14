/**
 * Chat V2 - VariantStatusIcon 变体状态图标组件
 *
 * 根据变体状态显示对应的图标
 * - pending: 时钟/等待
 * - streaming: 加载动画
 * - success: 勾选
 * - error: 错误
 * - cancelled: 取消
 */

import React from 'react';
import { cn } from '@/utils/cn';
import {
  Clock,
  CircleNotch,
  CheckCircle,
  XCircle,
  Prohibit,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { VariantStatus } from '../../core/types/message';

// ============================================================================
// Props 定义
// ============================================================================

export interface VariantStatusIconProps {
  /** 变体状态 */
  status: VariantStatus;
  /** 图标大小 */
  size?: 'sm' | 'md' | 'lg';
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 常量
// ============================================================================

const SIZE_MAP = {
  sm: 12,
  md: 16,
  lg: 20,
} as const;

const STATUS_CONFIG: Record<
  VariantStatus,
  {
    Icon: Icon;
    colorClass: string;
    animate?: boolean;
  }
> = {
  pending: {
    Icon: Clock,
    colorClass: 'text-muted-foreground',
  },
  streaming: {
    Icon: CircleNotch,
    colorClass: 'text-primary',
    animate: true,
  },
  success: {
    Icon: CheckCircle,
    colorClass: 'text-green-500 dark:text-green-400',
  },
  error: {
    Icon: XCircle,
    colorClass: 'text-destructive',
  },
  cancelled: {
    Icon: Prohibit,
    colorClass: 'text-yellow-500 dark:text-yellow-400',
  },
  interrupted: {
    Icon: Prohibit,
    colorClass: 'text-amber-500 dark:text-amber-400',
  },
};

// ============================================================================
// 组件实现
// ============================================================================

/**
 * VariantStatusIcon 变体状态图标
 */
export const VariantStatusIcon: React.FC<VariantStatusIconProps> = ({
  status,
  size = 'md',
  className,
}) => {
  const config = STATUS_CONFIG[status];
  const { Icon, colorClass, animate } = config;
  const iconSize = SIZE_MAP[size];

  return (
    <Icon
      size={iconSize}
      className={cn(
        colorClass,
        animate && 'animate-spin',
        className
      )}
    />
  );
};

export default VariantStatusIcon;
