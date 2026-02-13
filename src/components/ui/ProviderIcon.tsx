/**
 * 供应商图标组件
 * Provider Icon Component
 * 
 * 用于在UI中显示AI模型供应商的品牌图标
 */

import React from 'react';
import { getProviderInfo, type ProviderBrand } from '../../utils/providerIconEngine';

export interface ProviderIconProps {
  /**
   * 模型ID或名称，如 "deepseek-ai/DeepSeek-V3.1" 或 "SiliconFlow - Qwen/Qwen3-8B"
   */
  modelId: string;
  
  /**
   * 图标尺寸（像素）
   * @default 24
   */
  size?: number;
  
  /**
   * 是否显示供应商名称
   * @default false
   */
  showName?: boolean;
  
  /**
   * 名称显示位置
   * @default 'right'
   */
  namePosition?: 'right' | 'bottom';
  
  /**
   * 自定义类名
   */
  className?: string;
  
  /**
   * 自定义样式
   */
  style?: React.CSSProperties;
  
  /**
   * 当无法识别供应商时的后备图标
   * 如果不提供，则显示一个通用的圆形图标
   */
  fallbackIcon?: React.ReactNode;
  
  /**
   * 图标点击事件
   */
  onClick?: () => void;
  
  /**
   * 是否显示工具提示（悬停时显示供应商名称）
   * @default true
   */
  showTooltip?: boolean;
}

/**
 * 通用后备图标（当供应商未识别时显示）
 * 使用项目 logo.svg 作为默认 AI 头像
 */
const GenericFallbackIcon: React.FC<{ size: number }> = ({ size }) => (
  <img
    src="/logo.svg"
    alt="AI"
    style={{
      width: size * 0.7,
      height: size * 0.7,
      objectFit: 'contain',
      flexShrink: 0,
    }}
  />
);

export const ProviderIcon: React.FC<ProviderIconProps> = ({
  modelId,
  size = 24,
  showName = false,
  namePosition = 'right',
  className = '',
  style = {},
  fallbackIcon,
  onClick,
  showTooltip = true,
}) => {
  const providerInfo = getProviderInfo(modelId);
  const hasIcon = !!providerInfo.iconPath;
  
  // 容器样式
  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: namePosition === 'right' ? 'center' : 'flex-start',
    flexDirection: namePosition === 'right' ? 'row' : 'column',
    gap: namePosition === 'right' ? '8px' : '4px',
    cursor: onClick ? 'pointer' : 'default',
    ...style,
  };
  
  // 图标元素
  const iconElement = hasIcon ? (
    <img
      src={providerInfo.iconPath}
      alt={providerInfo.displayName}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
      }}
      onError={(e) => {
        // 图片加载失败时的处理
        console.warn(`Failed to load provider icon: ${providerInfo.iconPath}`);
        e.currentTarget.style.display = 'none';
      }}
    />
  ) : (
    fallbackIcon || <GenericFallbackIcon size={size} />
  );
  
  return (
    <div
      className={className}
      style={containerStyle}
      onClick={onClick}
      title={showTooltip ? providerInfo.displayName : undefined}
    >
      {iconElement}
      {showName && (
        <span
          style={{
            fontSize: size * 0.6,
            color: 'hsl(var(--foreground))',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {providerInfo.displayName}
        </span>
      )}
    </div>
  );
};

/**
 * 供应商图标徽章组件（带背景圆形）
 */
export interface ProviderIconBadgeProps extends Omit<ProviderIconProps, 'showName' | 'namePosition'> {
  /**
   * 徽章背景颜色
   * @default 'transparent'
   */
  backgroundColor?: string;
  
  /**
   * 徽章边框颜色
   * @default 'hsl(var(--border))'
   */
  borderColor?: string;
}

export const ProviderIconBadge: React.FC<ProviderIconBadgeProps> = ({
  modelId,
  size = 32,
  className = '',
  style = {},
  backgroundColor = 'transparent',
  borderColor = 'hsl(var(--border))',
  onClick,
  showTooltip = true,
  fallbackIcon,
}) => {
  const providerInfo = getProviderInfo(modelId);
  
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor,
        border: `1px solid ${borderColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: size * 0.15,
        boxSizing: 'border-box',
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        ...style,
      }}
      onClick={onClick}
      title={showTooltip ? providerInfo.displayName : undefined}
    >
      <ProviderIcon
        modelId={modelId}
        size={size * 0.7}
        showTooltip={false}
        fallbackIcon={fallbackIcon}
      />
    </div>
  );
};

/**
 * 供应商图标列表组件（用于显示多个供应商）
 */
export interface ProviderIconListProps {
  /**
   * 模型ID列表
   */
  modelIds: string[];
  
  /**
   * 图标尺寸
   * @default 24
   */
  size?: number;
  
  /**
   * 最大显示数量，超出部分显示"+N"
   */
  maxDisplay?: number;
  
  /**
   * 图标之间的间距
   * @default 4
   */
  gap?: number;
  
  /**
   * 是否重叠显示（头像堆叠效果）
   * @default false
   */
  overlap?: boolean;
  
  /**
   * 自定义类名
   */
  className?: string;
}

export const ProviderIconList: React.FC<ProviderIconListProps> = ({
  modelIds,
  size = 24,
  maxDisplay,
  gap = 4,
  overlap = false,
  className = '',
}) => {
  const displayIds = maxDisplay ? modelIds.slice(0, maxDisplay) : modelIds;
  const remainingCount = maxDisplay && modelIds.length > maxDisplay ? modelIds.length - maxDisplay : 0;
  
  // 去重（基于供应商品牌）
  const uniqueProviders = new Map<string, string>();
  for (const id of displayIds) {
    const info = getProviderInfo(id);
    if (!uniqueProviders.has(info.brand)) {
      uniqueProviders.set(info.brand, id);
    }
  }
  
  const overlapOffset = overlap ? -size * 0.3 : gap;
  
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: overlap ? 0 : gap,
      }}
    >
      {Array.from(uniqueProviders.values()).map((modelId, index) => (
        <div
          key={modelId}
          style={{
            marginLeft: index > 0 && overlap ? overlapOffset : 0,
            zIndex: displayIds.length - index,
          }}
        >
          <ProviderIconBadge
            modelId={modelId}
            size={size}
            backgroundColor="hsl(var(--background))"
          />
        </div>
      ))}
      {remainingCount > 0 && (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            backgroundColor: 'hsl(var(--muted))',
            border: '1px solid hsl(var(--border))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size * 0.4,
            color: 'hsl(var(--muted-foreground))',
            fontWeight: 'bold',
            marginLeft: overlap ? overlapOffset : 0,
          }}
        >
          +{remainingCount}
        </div>
      )}
    </div>
  );
};





