import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ArrowDownRight, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/shad/Card';
import { DESIGN } from './design';

export type StatVariant = 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'danger';

// 格式化数字
function formatNumber(num: number) {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

export interface StatCardProps {
  title: string;
  value: string | number;
  subtitle: string;
  icon: PhosphorIcon;
  variant: StatVariant;
  trend?: number;
  isEstimated?: boolean;
}

/** 总览统计卡片（`dashboard.stats` 的官方卡片都用它） */
export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  isEstimated = false,
}) => {
  const { t } = useTranslation('data');
  const trendColor =
    trend !== undefined && trend !== 0
      ? trend > 0
        ? DESIGN.colors.success
        : DESIGN.colors.danger
      : undefined;
  const displayValue = typeof value === 'number' ? formatNumber(value) : value;
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base">
              {title}
              {isEstimated && (
                <span
                  className="ml-2 text-xs font-normal"
                  style={{ color: DESIGN.colors.textMuted }}
                >
                  {t('stats_cards.estimated_label')}
                </span>
              )}
            </CardTitle>
          </div>
          {trend !== undefined && trend !== 0 && (
            <span className="text-xs flex items-center gap-1" style={{ color: trendColor }}>
              {trend > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
              {Math.abs(trend)}%
            </span>
          )}
        </div>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold" style={{ color: DESIGN.colors.textPrimary }}>
          {displayValue}
        </div>
      </CardContent>
    </Card>
  );
};
