/**
 * 供应商图标组件
 * 基于 Lobe Icons SVG 数据 + 本地 SVG 降级
 */

import React, { useEffect, useState, useMemo } from 'react';
import { getProviderInfo, type ProviderBrand } from '../../utils/providerIconEngine';
import { lobeIconData } from '../../utils/lobeIconData';

export interface ProviderIconProps {
  modelId: string;
  size?: number;
  showName?: boolean;
  namePosition?: 'right' | 'bottom';
  className?: string;
  style?: React.CSSProperties;
  fallbackIcon?: React.ReactNode;
  onClick?: () => void;
  showTooltip?: boolean;
}

const GenericFallbackIcon: React.FC<{ size: number }> = ({ size }) => (
  <img
    src="/icons/providers/generic.svg"
    alt="AI"
    style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
  />
);

const LobeSvgIcon: React.FC<{ brand: ProviderBrand; size: number }> = ({ brand, size }) => {
  const data = lobeIconData[brand];
  if (!data) return null;

  return (
    <svg
      height={size}
      width={size}
      viewBox={data.v}
      xmlns="http://www.w3.org/2000/svg"
      style={{ flex: 'none', lineHeight: 1 }}
    >
      {data.p.map((d, i) => (
        <path key={i} d={d} fill={data.f[i] || data.f[0] || 'currentColor'} />
      ))}
    </svg>
  );
};

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
  const hasLobeIcon = !!lobeIconData[providerInfo.brand];
  const [iconLoadFailed, setIconLoadFailed] = useState(false);

  useEffect(() => {
    setIconLoadFailed(false);
  }, [providerInfo.iconPath]);

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: namePosition === 'right' ? 'center' : 'flex-start',
    flexDirection: namePosition === 'right' ? 'row' : 'column',
    gap: namePosition === 'right' ? '8px' : '4px',
    cursor: onClick ? 'pointer' : 'default',
    ...style,
  };

  const iconElement = useMemo(() => {
    // 优先使用 Lobe Icons SVG 数据
    if (hasLobeIcon) {
      return <LobeSvgIcon brand={providerInfo.brand} size={size} />;
    }

    // 降级到本地 SVG 图标
    if (hasIcon && !iconLoadFailed) {
      return (
        <img
          src={providerInfo.iconPath}
          alt={providerInfo.displayName}
          style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
          onError={() => {
            console.warn(`Failed to load provider icon: ${providerInfo.iconPath}`);
            setIconLoadFailed(true);
          }}
        />
      );
    }

    return fallbackIcon || <GenericFallbackIcon size={size} />;
  }, [hasLobeIcon, providerInfo.brand, hasIcon, iconLoadFailed, providerInfo.iconPath, providerInfo.displayName, size, fallbackIcon]);

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

export interface ProviderIconBadgeProps extends Omit<ProviderIconProps, 'showName' | 'namePosition'> {
  backgroundColor?: string;
  borderColor?: string;
}

export const ProviderIconBadge: React.FC<ProviderIconBadgeProps> = ({
  modelId, size = 32, className = '', style = {},
  backgroundColor = 'transparent', borderColor = 'hsl(var(--border))',
  onClick, showTooltip = true, fallbackIcon,
}) => {
  const providerInfo = getProviderInfo(modelId);
  return (
    <div
      className={className}
      style={{
        width: size, height: size, borderRadius: '50%',
        backgroundColor, border: `1px solid ${borderColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: size * 0.15, boxSizing: 'border-box',
        cursor: onClick ? 'pointer' : 'default', flexShrink: 0, ...style,
      }}
      onClick={onClick}
      title={showTooltip ? providerInfo.displayName : undefined}
    >
      <ProviderIcon modelId={modelId} size={size * 0.7} showTooltip={false} fallbackIcon={fallbackIcon} />
    </div>
  );
};

export interface ProviderIconListProps {
  modelIds: string[];
  size?: number;
  maxDisplay?: number;
  gap?: number;
  overlap?: boolean;
  className?: string;
}

export const ProviderIconList: React.FC<ProviderIconListProps> = ({
  modelIds, size = 24, maxDisplay, gap = 4, overlap = false, className = '',
}) => {
  const displayIds = maxDisplay ? modelIds.slice(0, maxDisplay) : modelIds;
  const remainingCount = maxDisplay && modelIds.length > maxDisplay ? modelIds.length - maxDisplay : 0;

  const uniqueProviders = new Map<string, string>();
  for (const id of displayIds) {
    const info = getProviderInfo(id);
    if (!uniqueProviders.has(info.brand)) {
      uniqueProviders.set(info.brand, id);
    }
  }

  const overlapOffset = overlap ? -size * 0.3 : gap;

  return (
    <div className={className} style={{ display: 'flex', alignItems: 'center', gap: overlap ? 0 : gap }}>
      {Array.from(uniqueProviders.values()).map((modelId, index) => (
        <div key={modelId} style={{ marginLeft: index > 0 && overlap ? overlapOffset : 0, zIndex: displayIds.length - index }}>
          <ProviderIconBadge modelId={modelId} size={size} backgroundColor="hsl(var(--background))" />
        </div>
      ))}
      {remainingCount > 0 && (
        <div style={{
          width: size, height: size, borderRadius: '50%',
          backgroundColor: 'hsl(var(--muted))', border: '1px solid hsl(var(--border))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size * 0.4, color: 'hsl(var(--muted-foreground))', fontWeight: 'bold',
          marginLeft: overlap ? overlapOffset : 0,
        }}>
          +{remainingCount}
        </div>
      )}
    </div>
  );
};
