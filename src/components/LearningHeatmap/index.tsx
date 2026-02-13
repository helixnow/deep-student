/**
 * 学习热力图组件
 * 
 * 类似 GitHub 贡献图的学习活动可视化组件
 * 
 * 2026-02: Notion 风格 UI/UX 优化
 * - 极简配色
 * - 精致边框
 */

import React, { useMemo, useState, useEffect } from 'react';
import HeatMap from '@uiw/react-heat-map';
import { CommonTooltip } from '../shared/CommonTooltip';
import { useTranslation } from 'react-i18next';
import { useLearningHeatmap, type LearningActivity } from '../../hooks/useLearningHeatmap';
import { Loader2, RefreshCw, TrendingUp, Calendar, Zap, Activity } from 'lucide-react';
import { cn } from '../../lib/utils';
import './LearningHeatmap.css';

// ============================================================================
// 类型定义
// ============================================================================

export interface LearningHeatmapProps {
  months?: number;
  className?: string;
  showLegend?: boolean;
  showStats?: boolean;
}

// ============================================================================
// 颜色工具 - 从 CSS 变量计算主题感知颜色
// HeatMap 组件不支持 hsl(var(...)) 语法，需通过 getComputedStyle 解析
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
function computeHeatmapThemeColors() {
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
  };
}

// ============================================================================
// 工具函数
// ============================================================================

function formatDate(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  const localeMap: Record<string, string> = {
    'zh-CN': 'zh-CN',
    'en-US': 'en-US',
  };
  return date.toLocaleDateString(localeMap[locale] || 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

// ============================================================================
// 子组件
// ============================================================================

interface TooltipContentProps {
  activity: LearningActivity;
}

function TooltipContent({ activity }: TooltipContentProps) {
  const { t, i18n } = useTranslation('stats');
  const { details, date, count } = activity;
  const locale = i18n.language || 'en-US';
  
  return (
    <div className="flex flex-col gap-2 p-1 min-w-[180px]">
      <div className="flex items-center justify-between pb-2 border-b border-border/50 mb-1">
        <span className="text-xs font-semibold opacity-90">{formatDate(date, locale)}</span>
        <span className="text-xs font-mono bg-foreground/10 px-1.5 py-0.5 rounded">{count}</span>
      </div>
      
      {count > 0 ? (
        <div className="flex flex-col gap-1.5 text-xs opacity-90">
          {details.chatSessions > 0 && (
            <div className="flex justify-between"><span>{t('heatmap.details.chatSessions', '会话')}</span> <span className="opacity-70">{details.chatSessions}</span></div>
          )}
          {details.chatMessages > 0 && (
            <div className="flex justify-between"><span>{t('heatmap.details.chatMessages', '消息')}</span> <span className="opacity-70">{details.chatMessages}</span></div>
          )}
          {details.notesEdited > 0 && (
            <div className="flex justify-between"><span>{t('heatmap.details.notesEdited', '笔记')}</span> <span className="opacity-70">{details.notesEdited}</span></div>
          )}
          {details.textbooksOpened > 0 && (
            <div className="flex justify-between"><span>{t('heatmap.details.textbooksOpened', '阅读')}</span> <span className="opacity-70">{details.textbooksOpened}</span></div>
          )}
          {details.examsCreated > 0 && (
            <div className="flex justify-between"><span>{t('heatmap.details.examsCreated', '测验')}</span> <span className="opacity-70">{details.examsCreated}</span></div>
          )}
           {/* 其他详情省略，避免过长 */}
        </div>
      ) : (
        <div className="text-xs opacity-60 italic py-1">{t('heatmap.noActivity')}</div>
      )}
    </div>
  );
}

interface StatsCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  index: number;
}

function StatsCard({ icon, label, value, index }: StatsCardProps) {
  return (
    <div 
      className="flex flex-col gap-1 p-3 rounded-md hover:bg-muted/30 transition-colors"
      style={{ animationDelay: `${index * 100}ms` }}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="opacity-70">{icon}</span>
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight text-foreground font-mono tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function LearningHeatmap({
  months = 12,
  className = '',
  showLegend = true,
  showStats = true,
}: LearningHeatmapProps) {
  const { t } = useTranslation('stats');
  const {
    data,
    heatmapData,
    loading,
    error,
    totalActivities,
    activeDays,
    maxCount,
    refresh,
  } = useLearningHeatmap(months);
  
  // Theme-aware colors computed from CSS custom properties
  const [cssColors, setCssColors] = useState<string[]>(['#f4f4f5', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8']);
  const [themeTextColor, setThemeTextColor] = useState('#71717a');

  // 监听主题变化并从 CSS 变量计算颜色
  useEffect(() => {
    const updateColors = () => {
      
      // 从 CSS 自定义属性计算主题感知颜色
      const colors = computeHeatmapThemeColors();
      setCssColors(colors.panelColors);
      setThemeTextColor(colors.textColor);
    };
    
    updateColors();
    
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          updateColors();
        }
      });
    });
    
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    
    return () => observer.disconnect();
  }, []);

  // 计算开始日期
  const startDate = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - months);
    return date;
  }, [months]);

  // 根据日期获取活动详情
  const getActivityByDate = (date: string): LearningActivity | undefined => {
    return data.find(item => item.date === date);
  };

  if (loading) {
    return (
      <div className={cn("py-12 flex flex-col items-center justify-center text-muted-foreground/50", className)}>
        <Loader2 className="animate-spin mb-2" size={20} />
        <span className="text-xs font-medium">{t('heatmap.loading', '加载学习数据...')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("py-8 flex flex-col items-center justify-center text-muted-foreground/50", className)}>
        <span className="text-xs mb-3">{t('heatmap.error', { error })}</span>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-1.5 rounded-sm hover:bg-muted/40 transition-colors text-xs font-medium">
          <RefreshCw size={12} />
          {t('heatmap.retry', '重试')}
        </button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-4 pl-1">
        <Activity className="w-4 h-4 text-muted-foreground/70" />
        <h3 className="font-medium text-sm text-foreground/80">{t('heatmap.title')}</h3>
      </div>

      {/* 统计卡片 */}
      {showStats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          <StatsCard
            icon={<TrendingUp size={16} />}
            label={t('heatmap.stats.totalActivities', '总活动')}
            value={totalActivities}
            index={0}
          />
          <StatsCard
            icon={<Calendar size={16} />}
            label={t('heatmap.stats.activeDays', '活跃天数')}
            value={activeDays}
            index={1}
          />
          <StatsCard
            icon={<Zap size={16} />}
            label={t('heatmap.stats.maxDaily', '单日峰值')}
            value={maxCount}
            index={2}
          />
        </div>
      )}

      {/* 热力图容器 */}
      <div className="w-full overflow-x-auto pb-2">
        <div className="min-w-[600px]"> 
          <HeatMap
            value={heatmapData}
            width="100%"
            startDate={startDate}
            style={{ 
              color: themeTextColor,
              backgroundColor: 'transparent',
            }}
            panelColors={cssColors}
            rectSize={10}
            space={2}
            rectProps={{
              rx: 1.5, // 微圆角
            }}
            legendCellSize={0} // 隐藏默认图例
            weekLabels={['', t('calendar.weekMon'), '', t('calendar.weekWed'), '', t('calendar.weekFri'), '']}
            monthLabels={Array.from({ length: 12 }, (_, i) => t(`calendar.month${i + 1}`))}
            monthPlacement="top"
            rectRender={(props, data) => {
              const dateStr = data.date;
              const activity = getActivityByDate(dateStr);

              return (
                <CommonTooltip
                  content={activity ? <TooltipContent activity={activity} /> : null}
                  position="top"
                  showArrow={false}
                  offset={10}
                  maxWidth={280}
                >
                  <rect
                    {...props}
                    className="transition-all duration-200 hover:opacity-80 cursor-pointer"
                  />
                </CommonTooltip>
              );
            }}
          />
        </div>
      </div>

      {/* 自定义图例 */}
      {showLegend && (
        <div className="flex items-center justify-end gap-2 mt-2 px-1">
          <span className="text-[10px] text-muted-foreground/60">{t('heatmap.legend.less', 'Less')}</span>
          <div className="flex gap-1">
            {cssColors.map((color, index) => (
              <div
                key={index}
                className="w-2.5 h-2.5 rounded-[1px]"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground/60">{t('heatmap.legend.more', 'More')}</span>
        </div>
      )}

    </div>
  );
}

export default LearningHeatmap;
