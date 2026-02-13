/**
 * 学习活跃度热力图组件
 * 
 * 2026-01 新增：时间维度统计与趋势可视化
 * 
 * 功能特性：
 * - GitHub 风格的日历热力图
 * - 颜色深浅表示活跃度
 * - 点击日期显示详情
 * - Notion 风格 UI
 */

import React, { useEffect, useMemo, useState } from 'react';
import HeatMap from '@uiw/react-heat-map';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { Flame, Calendar, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import {
  useQuestionBankStore,
  useActivityHeatmap,
  useLoadingHeatmap,
  type ActivityHeatmapPoint,
} from '@/stores/questionBankStore';

// ============================================================================
// 类型定义
// ============================================================================

export interface LearningHeatmapChartProps {
  examId?: string;
  className?: string;
  onDateClick?: (date: string, data: ActivityHeatmapPoint | null) => void;
}

// ============================================================================
// 颜色工具 - 从 CSS 变量计算主题感知颜色
// ============================================================================

/** 读取 CSS 自定义属性并转换为 hsl() 字符串（逗号格式，兼容 SVG） */
function resolveHsl(varName: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return '';
  const [h, s, l] = raw.split(/\s+/);
  return `hsl(${h}, ${s}, ${l})`;
}

function resolveHsla(varName: string, alpha: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return '';
  const [h, s, l] = raw.split(/\s+/);
  return `hsla(${h}, ${s}, ${l}, ${alpha})`;
}

/** 根据当前主题生成热力图颜色 */
function computeHeatmapColors() {
  const empty = resolveHsl('--secondary');
  return {
    panelColors: [
      empty,
      resolveHsla('--primary', 0.25),
      resolveHsla('--primary', 0.5),
      resolveHsla('--primary', 0.75),
      resolveHsl('--primary'),
    ],
    textColor: resolveHsl('--muted-foreground'),
    emptyColor: empty,
  };
}

// ============================================================================
// 统计卡片
// ============================================================================

interface StatsCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  variant: 'total' | 'active' | 'streak';
}

const STAT_STYLES = {
  total: {
    bg: 'bg-blue-500/10',
    iconBg: 'bg-blue-500/20',
    iconColor: 'text-blue-500',
    valueColor: 'text-blue-600',
  },
  active: {
    bg: 'bg-emerald-500/10',
    iconBg: 'bg-emerald-500/20',
    iconColor: 'text-emerald-500',
    valueColor: 'text-emerald-600',
  },
  streak: {
    bg: 'bg-amber-500/10',
    iconBg: 'bg-amber-500/20',
    iconColor: 'text-amber-500',
    valueColor: 'text-amber-600',
  },
};

const StatsCard: React.FC<StatsCardProps> = ({ icon, label, value, variant }) => {
  const styles = STAT_STYLES[variant];
  
  return (
    <div className={cn('rounded-lg p-3 flex items-center gap-3', styles.bg)}>
      <div className={cn('p-2 rounded-lg', styles.iconBg)}>
        <span className={styles.iconColor}>{icon}</span>
      </div>
      <div>
        <div className={cn('text-lg font-bold', styles.valueColor)}>{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
};

// ============================================================================
// 自定义 Tooltip 内容
// ============================================================================

interface TooltipContentProps {
  data: ActivityHeatmapPoint | null;
  date: string;
}

const TooltipContent: React.FC<TooltipContentProps> = ({ data, date }) => {
  const { t } = useTranslation('stats');

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    });
  };

  return (
    <div className="min-w-[160px]">
      <div className="font-medium text-foreground mb-2 pb-2 border-b border-border/50">
        {formatDate(date)}
      </div>
      {data && data.count > 0 ? (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('heatmapChart.questionCount')}</span>
            <span className="font-medium text-emerald-600">{t('heatmapChart.questionUnit', { count: data.count })}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('heatmapChart.correctCount')}</span>
            <span className="font-medium text-blue-600">{t('heatmapChart.questionUnit', { count: data.correct_count })}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('heatmapChart.correctRate')}</span>
            <span className="font-medium text-amber-600">
              {data.count > 0 ? Math.round((data.correct_count / data.count) * 100) : 0}%
            </span>
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{t('heatmapChart.noRecord')}</div>
      )}
    </div>
  );
};

// ============================================================================
// 骨架屏组件
// ============================================================================

const HeatmapSkeleton: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-8 w-20" />
    </div>
    <div className="grid grid-cols-3 gap-3">
      {[1, 2, 3].map(i => (
        <Skeleton key={i} className="h-16 rounded-lg" />
      ))}
    </div>
    <Skeleton className="h-32 w-full rounded-lg" />
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export const LearningHeatmapChart: React.FC<LearningHeatmapChartProps> = ({
  examId,
  className,
  onDateClick,
}) => {
  const { t } = useTranslation('stats');
  
  // Store hooks
  const heatmapData = useActivityHeatmap();
  const isLoading = useLoadingHeatmap();
  const { loadActivityHeatmap } = useQuestionBankStore();
  
  // 本地状态
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  // Theme-aware colors computed from CSS custom properties
  const [panelColors, setPanelColors] = useState<string[]>(['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']);
  const [themeTextColor, setThemeTextColor] = useState('#52525b');
  const [themeEmptyColor, setThemeEmptyColor] = useState('#ebedf0');

  // 监听主题变化 & 计算主题颜色
  useEffect(() => {
    const updateThemeColors = () => {
      const colors = computeHeatmapColors();
      setPanelColors(colors.panelColors);
      setThemeTextColor(colors.textColor);
      setThemeEmptyColor(colors.emptyColor);
    };
    
    updateThemeColors();
    
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          updateThemeColors();
        }
      });
    });
    
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    
    return () => observer.disconnect();
  }, []);

  // 加载数据
  useEffect(() => {
    loadActivityHeatmap(examId, selectedYear).catch(console.error);
  }, [examId, selectedYear, loadActivityHeatmap]);

  // 转换为热力图库需要的格式
  const formattedData = useMemo(() => {
    return heatmapData.map(item => ({
      date: item.date,
      count: item.count,
    }));
  }, [heatmapData]);

  // 计算统计数据
  const stats = useMemo(() => {
    if (!heatmapData || heatmapData.length === 0) {
      return { totalCount: 0, activeDays: 0, currentStreak: 0 };
    }

    const totalCount = heatmapData.reduce((sum, d) => sum + d.count, 0);
    const activeDays = heatmapData.filter(d => d.count > 0).length;
    
    // 计算连续学习天数
    const sortedDates = heatmapData
      .filter(d => d.count > 0)
      .map(d => d.date)
      .sort()
      .reverse();
    
    let currentStreak = 0;
    const today = new Date().toISOString().split('T')[0];
    let checkDate = today;
    
    for (const date of sortedDates) {
      if (date === checkDate) {
        currentStreak++;
        const nextDate = new Date(checkDate);
        nextDate.setDate(nextDate.getDate() - 1);
        checkDate = nextDate.toISOString().split('T')[0];
      } else if (date < checkDate) {
        break;
      }
    }

    return { totalCount, activeDays, currentStreak };
  }, [heatmapData]);

  // 获取某日期的数据
  const getDataByDate = (date: string): ActivityHeatmapPoint | null => {
    return heatmapData.find(d => d.date === date) || null;
  };

  // 计算开始日期
  const startDate = useMemo(() => {
    return new Date(`${selectedYear}-01-01`);
  }, [selectedYear]);

  // 年份切换
  const handlePrevYear = () => setSelectedYear(y => y - 1);
  const handleNextYear = () => setSelectedYear(y => Math.min(y + 1, new Date().getFullYear()));

  // 刷新数据
  const handleRefresh = () => {
    loadActivityHeatmap(examId, selectedYear).catch(console.error);
  };

  if (isLoading) {
    return (
      <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
        <HeatmapSkeleton />
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Flame className="w-5 h-5 text-orange-500" />
          <h3 className="font-semibold">{t('heatmapChart.title')}</h3>
        </div>
        
        <div className="flex items-center gap-2">
          {/* 年份选择器 */}
          <div className="flex items-center gap-1">
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handlePrevYear}
            >
              <ChevronLeft className="w-4 h-4" />
            </NotionButton>
            <span className="text-sm font-medium min-w-[50px] text-center">
              {selectedYear}
            </span>
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleNextYear}
              disabled={selectedYear >= new Date().getFullYear()}
            >
              <ChevronRight className="w-4 h-4" />
            </NotionButton>
          </div>
          
          {/* 刷新按钮 */}
          <NotionButton
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleRefresh}
          >
            <RefreshCw className="w-4 h-4" />
          </NotionButton>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatsCard
          icon={<Flame className="w-4 h-4" />}
          label={t('heatmapChart.totalQuestions')}
          value={stats.totalCount}
          variant="total"
        />
        <StatsCard
          icon={<Calendar className="w-4 h-4" />}
          label={t('heatmapChart.activeDays')}
          value={stats.activeDays}
          variant="active"
        />
        <StatsCard
          icon={<Flame className="w-4 h-4" />}
          label={t('heatmapChart.streak')}
          value={t('heatmapChart.streakDays', { count: stats.currentStreak })}
          variant="streak"
        />
      </div>

      {/* 热力图 */}
      <div className="overflow-x-auto pb-2">
        <HeatMap
          value={formattedData}
          width="100%"
          startDate={startDate}
          style={{ 
            color: themeTextColor,
            ['--rhm-rect' as string]: themeEmptyColor,
          }}
          panelColors={panelColors}
          rectSize={11}
          space={3}
          rectProps={{
            rx: 2,
          }}
          legendCellSize={0}
          weekLabels={['', t('calendar.weekMon'), '', t('calendar.weekWed'), '', t('calendar.weekFri'), '']}
          monthLabels={Array.from({ length: 12 }, (_, i) => t(`calendar.month${i + 1}`))}
          monthPlacement="top"
          rectRender={(props, data) => {
            const dateStr = data.date;
            const activityData = getDataByDate(dateStr);
            const isToday = dateStr === new Date().toISOString().split('T')[0];
            
            return (
              <CommonTooltip
                content={<TooltipContent data={activityData} date={dateStr} />}
                position="top"
                showArrow={false}
                offset={10}
                maxWidth={280}
              >
                <rect
                  {...props}
                  className={cn(
                    'cursor-pointer transition-all duration-150',
                    'hover:stroke-foreground/60 hover:stroke-[1.5px]',
                    isToday && 'stroke-emerald-500 stroke-2'
                  )}
                  onClick={() => onDateClick?.(dateStr, activityData)}
                />
              </CommonTooltip>
            );
          }}
        />
      </div>

      {/* 图例 */}
      <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border/50">
        <span className="text-xs text-muted-foreground">{t('heatmapChart.legendLess')}</span>
        <div className="flex gap-1">
          {panelColors.map((color, index) => (
            <div
              key={index}
              className="w-3 h-3 rounded-sm transition-transform hover:scale-125"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{t('heatmapChart.legendMore')}</span>
      </div>

    </div>
  );
};

export default LearningHeatmapChart;
