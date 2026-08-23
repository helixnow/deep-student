/**
 * 学习活跃度热力图组件
 *
 * 2026-01 新增：时间维度统计与趋势可视化
 * 2026-07 打磨：GitHub 风格色阶 / hover 单元格详情 / 日期与时区 bug 修复
 *
 * 功能特性：
 * - GitHub 风格的日历热力图（主题感知色阶，支持暗色模式）
 * - hover 单元格内联 tooltip 显示当日详情
 * - 点击日期回调
 * - 简洁风格 UI
 */

import React, { useEffect, useMemo, useState } from 'react';
import HeatMap from '@uiw/react-heat-map';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { Fire, CalendarBlank, CaretLeft, CaretRight, ArrowsClockwise, Info } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  useActivityHeatmap,
  useLoadingHeatmap,
  type ActivityHeatmapPoint,
} from '@/stores/questionBankStore';
import { percentOf } from './percent';
import { computeCurrentStreak, normalizeDateKey, toLocalDateStr } from './activityDates';

// ============================================================================
// 类型定义
// ============================================================================

export interface LearningHeatmapChartProps {
  examId?: string;
  className?: string;
  onDateClick?: (date: string, data: ActivityHeatmapPoint | null) => void;
}

// ============================================================================
// 日期工具 — 本地时区换算统一走 ./activityDates
// ============================================================================

/**
 * @uiw/react-heat-map 内部把日期归一化为 "YYYY/M/D"（斜杠、不补零），
 * rectRender 回调拿到的就是这种格式。我们统一用它作为索引 key，
 * 否则用 "YYYY-MM-DD" 对比永远命中不了（修复：hover 详情一直显示"暂无记录"）。
 */
function toHeatmapKey(dateStr: string): string {
  const parts = dateStr.split(/[-/]/).map(Number);
  if (parts.length < 3 || parts.some(p => !Number.isFinite(p) || p <= 0)) return dateStr;
  const [y, m, d] = parts;
  return `${y}/${m}/${d}`;
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

/** 根据当前主题生成热力图颜色（GitHub 风格 5 级色阶；变量缺失时回退 currentColor 系灰阶） */
function computeHeatmapColors() {
  const empty = resolveHsl('--secondary') || 'hsl(0, 0%, 92%)';
  return {
    panelColors: [
      empty,
      resolveHsla('--primary', 0.25) || empty,
      resolveHsla('--primary', 0.5) || empty,
      resolveHsla('--primary', 0.75) || empty,
      resolveHsl('--primary') || empty,
    ],
    textColor: resolveHsl('--muted-foreground') || 'hsl(0, 0%, 45%)',
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

const STAT_ICON_COLORS: Record<StatsCardProps['variant'], string> = {
  total: 'text-primary',
  active: 'text-success',
  streak: 'text-warning',
};

const StatsCard: React.FC<StatsCardProps> = ({ icon, label, value, variant }) => (
  <div className="flex items-center gap-2.5 rounded-md border border-border/40 bg-background/40 p-2.5 transition-colors hover:border-border/80">
    <span className={cn('flex-shrink-0', STAT_ICON_COLORS[variant])}>{icon}</span>
    <div className="min-w-0">
      <div className="truncate text-base font-semibold tabular-nums text-foreground">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  </div>
);

// ============================================================================
// 自定义 Tooltip 内容
// ============================================================================

interface TooltipContentProps {
  data: ActivityHeatmapPoint | null;
  /** ISO 格式 YYYY-MM-DD */
  date: string;
}

const TooltipContent: React.FC<TooltipContentProps> = ({ data, date }) => {
  const { t } = useTranslation('stats');

  const formatDate = (dateStr: string) => {
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
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
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{t('heatmapChart.questionCount')}</span>
            <span className="font-medium text-success tabular-nums">{t('heatmapChart.questionUnit', { count: data.count })}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{t('heatmapChart.correctCount')}</span>
            <span className="font-medium text-info tabular-nums">{t('heatmapChart.questionUnit', { count: data.correct_count })}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{t('heatmapChart.correctRate')}</span>
            <span className="font-medium text-warning tabular-nums">
              {percentOf(data.correct_count, data.count)}%
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
  const { loadActivityHeatmap } = useQuestionBankStore(
    useShallow((state) => ({
      loadActivityHeatmap: state.loadActivityHeatmap,
    }))
  );

  // 本地状态
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  // Theme-aware colors computed from CSS custom properties.
  // 首帧即从主题变量取色（惰性初始化），避免暗色主题下闪一帧预制的 GitHub 绿。
  const [initialColors] = useState(() => computeHeatmapColors());
  const [panelColors, setPanelColors] = useState<string[]>(initialColors.panelColors);
  const [themeTextColor, setThemeTextColor] = useState(initialColors.textColor);
  const [themeEmptyColor, setThemeEmptyColor] = useState(initialColors.emptyColor);

  // 监听主题变化 & 计算主题颜色
  useEffect(() => {
    const updateThemeColors = () => {
      const colors = computeHeatmapColors();
      setPanelColors(colors.panelColors);
      setThemeTextColor(colors.textColor);
      setThemeEmptyColor(colors.emptyColor);
    };

    updateThemeColors();

    // useTheme 除了切 class 还会写 data-theme / data-theme-palette（换配色主题），
    // 三者任一变化都要重算色阶，否则切换调色板后热力图颜色滞留旧主题
    const observer = new MutationObserver(() => updateThemeColors());

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-theme-palette'],
    });

    return () => observer.disconnect();
  }, []);

  // 加载数据
  useEffect(() => {
    loadActivityHeatmap(examId, selectedYear).catch(console.error);
  }, [examId, selectedYear, loadActivityHeatmap]);

  // 转换为热力图库需要的格式。
  // 库内部会 new Date(item.date)："YYYY-MM-DD" 会按 UTC 解析（跨时区偏一天），
  // 预先归一化为 "YYYY/M/D"（本地解析）避免日期漂移。
  const formattedData = useMemo(() => {
    return heatmapData.map(item => ({
      date: toHeatmapKey(item.date),
      count: item.count,
    }));
  }, [heatmapData]);

  // 日期 → 数据点索引（heatmap key 格式；避免每个单元格 O(n) find）
  const dataByKey = useMemo(() => {
    const map = new Map<string, ActivityHeatmapPoint>();
    for (const item of heatmapData) {
      map.set(toHeatmapKey(item.date), item);
    }
    return map;
  }, [heatmapData]);

  // 计算统计数据
  const stats = useMemo(() => {
    if (!heatmapData || heatmapData.length === 0) {
      return { totalCount: 0, activeDays: 0, currentStreak: 0 };
    }

    const totalCount = heatmapData.reduce((sum, d) => sum + d.count, 0);
    const activeDays = heatmapData.filter(d => d.count > 0).length;

    // 连续学习天数（本地时区；今天还没做题时从昨天起算，避免凌晨"断签"清零）
    const currentStreak = computeCurrentStreak(heatmapData);

    return { totalCount, activeDays, currentStreak };
  }, [heatmapData]);

  const todayKey = toHeatmapKey(toLocalDateStr(new Date()));

  // 计算开始/结束日期（本地时区构造，避免 "YYYY-MM-DD" 字符串被解析成 UTC 午夜）
  const startDate = useMemo(() => new Date(selectedYear, 0, 1), [selectedYear]);
  const endDate = useMemo(() => new Date(selectedYear, 11, 31), [selectedYear]);

  // 计算热力图实际像素宽度，避免 width="100%" 导致 SVG 裁剪
  const heatmapWidth = useMemo(() => {
    const rectW = 11;
    const spaceW = 3;
    const weekLabelWidth = 35;
    const numWeeks = 54; // 一年最多 54 周
    return weekLabelWidth + numWeeks * (rectW + spaceW);
  }, []);

  // 年份切换
  const handlePrevYear = () => setSelectedYear(y => y - 1);
  const handleNextYear = () => setSelectedYear(y => Math.min(y + 1, new Date().getFullYear()));

  // 刷新数据
  const handleRefresh = () => {
    loadActivityHeatmap(examId, selectedYear).catch(console.error);
  };

  if (isLoading) {
    return (
      <div className={cn('rounded-lg border border-border/50 bg-muted/20 p-4', className)}>
        <HeatmapSkeleton />
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-border/50 bg-muted/20 p-4', className)}>
      {/* 标题栏 */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Fire size={16} className="text-muted-foreground" />
          <span className="font-medium text-foreground">{t('heatmapChart.title')}</span>
        </div>

        <div className="flex items-center gap-2">
          {/* 年份选择器 */}
          <div className="flex items-center gap-1">
            <DsButton
              variant="ghost"
              size="icon"
              className="h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
              onClick={handlePrevYear}
              aria-label={String(selectedYear - 1)}
            >
              <CaretLeft size={16} />
            </DsButton>
            <span className="text-sm font-medium min-w-[50px] text-center tabular-nums">
              {selectedYear}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              className="h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
              onClick={handleNextYear}
              disabled={selectedYear >= new Date().getFullYear()}
              aria-label={String(selectedYear + 1)}
            >
              <CaretRight size={16} />
            </DsButton>
          </div>

          {/* 刷新按钮 */}
          <DsButton
            variant="ghost"
            size="icon"
            className="h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-foreground"
            onClick={handleRefresh}
            aria-label={t('heatmapChart.title')}
          >
            <ArrowsClockwise size={14} />
          </DsButton>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <StatsCard
          icon={<Fire size={16} />}
          label={t('heatmapChart.totalQuestions')}
          value={stats.totalCount}
          variant="total"
        />
        <StatsCard
          icon={<CalendarBlank size={16} />}
          label={t('heatmapChart.activeDays')}
          value={stats.activeDays}
          variant="active"
        />
        <StatsCard
          icon={<Fire size={16} />}
          label={t('heatmapChart.streak')}
          value={t('heatmapChart.streakDays', { count: stats.currentStreak })}
          variant="streak"
        />
      </div>

      {/* 全年无数据：空态引导提示条（不影响热力图本身渲染） */}
      {stats.totalCount === 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0 opacity-60" />
          <span>{t('heatmapChart.emptyHint')}</span>
        </div>
      )}

      {/* 热力图 — overflow-x-auto + direction:rtl：初始停在最新日期，
          窄容器（移动端）可横向滚动查看更早月份，不再直接裁掉 */}
      <div className="overflow-x-auto overflow-y-hidden pb-2" style={{ direction: 'rtl' }}>
        <div style={{ minWidth: heatmapWidth, direction: 'ltr' }}>
        <HeatMap
          value={formattedData}
          width={heatmapWidth}
          startDate={startDate}
          endDate={endDate}
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
            const key = data.date;
            const isoDate = normalizeDateKey(key);
            const activityData = dataByKey.get(key) ?? null;
            const isToday = key === todayKey;

            return (
              <CommonTooltip
                content={<TooltipContent data={activityData} date={isoDate} />}
                position="top"
                showArrow={false}
                offset={10}
                delay={100}
                maxWidth={280}
              >
                <rect
                  {...props}
                  className={cn(
                    'cursor-pointer transition-all duration-150',
                    'hover:stroke-foreground/60 hover:stroke-[1.5px]',
                    isToday && 'stroke-success stroke-2'
                  )}
                  // 无 onDateClick 时不挂 onClick：让 CommonTooltip 判定为纯提示元素，
                  // 触屏 tap 切换 tooltip 查看每日数据（否则被 childHasOwnClick 直接关掉）
                  onClick={onDateClick ? () => onDateClick(isoDate, activityData) : undefined}
                />
              </CommonTooltip>
            );
          }}
        />
        </div>
      </div>

      {/* 图例 */}
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/40 pt-3">
        <span className="text-xs text-muted-foreground/70">{t('heatmapChart.legendLess')}</span>
        <div className="flex gap-1">
          {panelColors.map((color, index) => (
            <div
              key={index}
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <span className="text-xs text-muted-foreground/70">{t('heatmapChart.legendMore')}</span>
      </div>

    </div>
  );
};

export default LearningHeatmapChart;
