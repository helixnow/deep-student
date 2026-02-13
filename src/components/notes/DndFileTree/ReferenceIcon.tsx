/**
 * ReferenceIcon - 引用节点图标组件
 *
 * 根据文档18《统一学习资源管理器架构设计》第七章"图标映射"实现
 *
 * 功能：
 * 1. 根据 sourceDb 显示不同图标和颜色
 * 2. 支持引用标记叠加（小箭头）
 * 3. 支持失效状态显示
 * 4. 支持亮色/暗色模式
 */

import React, { memo } from 'react';
import {
  BookOpen,
  Image as ImageIcon,
  File,
  Paperclip,
  AlertTriangle,
  ExternalLink,
  FileSpreadsheet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SourceDatabase, PreviewType } from './types';

// ============================================================================
// 类型定义
// ============================================================================

export interface ReferenceIconProps {
  /** 来源数据库 */
  sourceDb: SourceDatabase;
  /** 预览类型（可选，用于 chat_v2 的细分） */
  previewType?: PreviewType;
  /** 自定义图标名（覆盖默认） */
  customIcon?: string;
  /** 是否失效 */
  isInvalid?: boolean;
  /** 是否显示引用标记 */
  showLinkBadge?: boolean;
  /** 图标大小 */
  size?: 'sm' | 'md' | 'lg';
  /** 额外的 className */
  className?: string;
}

// ============================================================================
// 图标配置
// ============================================================================

/**
 * sourceDb 对应的图标配置
 *
 * | sourceDb       | 图标 (Lucide)     | 颜色                          |
 * |----------------|------------------|-------------------------------|
 * | textbooks      | BookOpen         | 紫色 (text-purple-500)        |
 * | chat_v2        | 根据 previewType  | 绿色(image)/灰色(file)        |
 * | exam_sessions  | FileSpreadsheet  | 绿色 (text-green-500) ★       |
 */
const ICON_CONFIG: Record<
  SourceDatabase,
  {
    icon: React.FC<{ className?: string }>;
    colorClass: string;
    darkColorClass: string;
  }
> = {
  textbooks: {
    icon: BookOpen,
    colorClass: 'text-purple-500',
    darkColorClass: 'dark:text-purple-400',
  },
  chat_v2: {
    icon: Paperclip,
    colorClass: 'text-gray-500',
    darkColorClass: 'dark:text-gray-400',
  },
  exam_sessions: {
    icon: FileSpreadsheet,
    colorClass: 'text-green-500',
    darkColorClass: 'dark:text-green-400',
  },
};

/**
 * chat_v2 的细分图标（根据 previewType）
 */
const CHAT_V2_SUBTYPE_CONFIG: Partial<
  Record<
    PreviewType,
    {
      icon: React.FC<{ className?: string }>;
      colorClass: string;
      darkColorClass: string;
    }
  >
> = {
  image: {
    icon: ImageIcon,
    colorClass: 'text-green-500',
    darkColorClass: 'dark:text-green-400',
  },
  none: {
    icon: File,
    colorClass: 'text-gray-500',
    darkColorClass: 'dark:text-gray-400',
  },
};

/**
 * 图标大小配置
 */
const SIZE_CONFIG: Record<string, { icon: string; badge: string }> = {
  sm: { icon: 'w-3.5 h-3.5', badge: 'w-2 h-2' },
  md: { icon: 'w-4 h-4', badge: 'w-2.5 h-2.5' },
  lg: { icon: 'w-5 h-5', badge: 'w-3 h-3' },
};

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 获取图标配置
 */
function getIconConfig(sourceDb: SourceDatabase, previewType?: PreviewType) {
  // chat_v2 需要根据 previewType 细分
  if (sourceDb === 'chat_v2' && previewType) {
    const subtypeConfig = CHAT_V2_SUBTYPE_CONFIG[previewType];
    if (subtypeConfig) {
      return subtypeConfig;
    }
  }
  return ICON_CONFIG[sourceDb] || ICON_CONFIG.chat_v2;
}

/**
 * ReferenceIcon 组件
 *
 * 显示引用节点的图标，根据来源数据库类型显示不同图标和颜色
 */
export const ReferenceIcon = memo(function ReferenceIcon({
  sourceDb,
  previewType,
  customIcon,
  isInvalid = false,
  showLinkBadge = true,
  size = 'md',
  className,
}: ReferenceIconProps) {
  const config = getIconConfig(sourceDb, previewType);
  const IconComponent = config.icon;
  const sizeConfig = SIZE_CONFIG[size] || SIZE_CONFIG.md;

  // 失效状态使用警告样式
  const colorClass = isInvalid
    ? 'text-yellow-500 dark:text-yellow-400'
    : cn(config.colorClass, config.darkColorClass);

  return (
    <span
      className={cn(
        'relative inline-flex items-center justify-center flex-shrink-0',
        className
      )}
      data-testid="reference-icon"
      data-source-db={sourceDb}
      data-preview-type={previewType}
      data-invalid={isInvalid}
    >
      {/* 主图标 */}
      {isInvalid ? (
        <AlertTriangle
          className={cn(sizeConfig.icon, colorClass)}
          aria-hidden="true"
        />
      ) : (
        <IconComponent
          className={cn(sizeConfig.icon, colorClass)}
          aria-hidden="true"
        />
      )}

      {/* 引用标记（右下角小箭头） */}
      {showLinkBadge && !isInvalid && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5',
            'flex items-center justify-center',
            'rounded-full',
            'bg-white dark:bg-gray-800',
            'ring-1 ring-white dark:ring-gray-800'
          )}
        >
          <ExternalLink
            className={cn(
              sizeConfig.badge,
              'text-gray-400 dark:text-gray-500'
            )}
            aria-hidden="true"
          />
        </span>
      )}
    </span>
  );
});

// ============================================================================
// 辅助组件
// ============================================================================

/**
 * 获取 sourceDb 对应的颜色类名（供外部使用）
 */
export function getReferenceColorClass(
  sourceDb: SourceDatabase,
  previewType?: PreviewType,
  isDark = false
): string {
  const config = getIconConfig(sourceDb, previewType);
  return isDark ? config.darkColorClass : config.colorClass;
}

/**
 * 获取 sourceDb 对应的图标组件（供外部使用）
 */
export function getReferenceIconComponent(
  sourceDb: SourceDatabase,
  previewType?: PreviewType
): React.FC<{ className?: string }> {
  const config = getIconConfig(sourceDb, previewType);
  return config.icon;
}

export default ReferenceIcon;
