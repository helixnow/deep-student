/**
 * 知识点掌握度雷达图组件
 * 
 * 2026-01 新增：时间维度统计与趋势可视化
 * 
 * 功能特性：
 * - 知识点掌握度雷达图
 * - 多维度对比（当前 vs 上周）
 * - 知识点详情列表
 * - Notion 风格 UI
 */

import React, { useEffect, useMemo } from 'react';
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Legend,
  Tooltip,
} from 'recharts';
import { Brain, Target, TrendingUp, RefreshCw, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import {
  useKnowledgeStats,
  useLoadingKnowledge,
  type KnowledgePoint,
} from '@/stores/questionBankStore';
import { useShallow } from 'zustand/react/shallow';
import { useQuestionBankStore } from '@/stores/questionBankStore';

// ============================================================================
// 类型定义
// ============================================================================

export interface KnowledgeRadarProps {
  examId?: string;
  className?: string;
  showDetailList?: boolean;
}

// ============================================================================
// 自定义 Tooltip
// ============================================================================

interface TooltipPayload {
  payload: {
    tag: string;
    mastery_rate: number;
    correct_rate: number;
    total: number;
    mastered: number;
  };
  name: string;
  value: number;
}

const CustomTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipPayload[];
}> = ({ active, payload }) => {
  const { t } = useTranslation('stats');

  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0]?.payload;
  if (!data) return null;

  return (
    <div className="rounded-lg border border-border bg-popover p-3 shadow-lg min-w-[160px]">
      <div className="font-medium text-foreground mb-2 pb-2 border-b border-border/50">
        {data.tag}
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('knowledgeRadar.mastery')}</span>
          <span className="font-medium text-primary">{data.mastery_rate}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('knowledgeRadar.correctRate')}</span>
          <span className="font-medium text-emerald-600">{data.correct_rate}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('knowledgeRadar.questionCount')}</span>
          <span className="font-medium text-blue-600">{t('knowledgeRadar.questionUnit', { count: data.total })}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('knowledgeRadar.mastered')}</span>
          <span className="font-medium text-amber-600">{t('knowledgeRadar.questionUnit', { count: data.mastered })}</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 知识点详情列表项
// ============================================================================

interface KnowledgeItemProps {
  item: KnowledgePoint;
  index: number;
}

const KnowledgeItem: React.FC<KnowledgeItemProps> = ({ item, index }) => {
  const { t } = useTranslation('stats');

  // 根据掌握度设置颜色
  const getMasteryColor = (rate: number) => {
    if (rate >= 80) return 'text-emerald-600 bg-emerald-500/10';
    if (rate >= 60) return 'text-blue-600 bg-blue-500/10';
    if (rate >= 40) return 'text-amber-600 bg-amber-500/10';
    return 'text-red-600 bg-red-500/10';
  };

  const masteryColorClass = getMasteryColor(item.mastery_rate);

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* 序号 */}
      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
        {index + 1}
      </div>
      
      {/* 知识点名称 */}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{item.tag}</div>
        <div className="text-xs text-muted-foreground">
          {t('knowledgeRadar.itemDetail', { total: item.total, mastered: item.mastered })}
        </div>
      </div>
      
      {/* 掌握度 */}
      <div className={cn('px-2 py-1 rounded-md text-sm font-medium', masteryColorClass)}>
        {item.mastery_rate}%
      </div>
      
      {/* 进度条 */}
      <div className="w-20 hidden sm:block">
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${item.mastery_rate}%` }}
          />
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 骨架屏组件
// ============================================================================

const RadarSkeleton: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-8 w-8" />
    </div>
    <Skeleton className="h-64 w-full rounded-lg" />
    <div className="space-y-2">
      {[1, 2, 3].map(i => (
        <Skeleton key={i} className="h-14 rounded-lg" />
      ))}
    </div>
  </div>
);

// ============================================================================
// 空状态组件
// ============================================================================

const EmptyState: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const { t } = useTranslation('stats');

  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <Brain className="w-12 h-12 text-muted-foreground/30 mb-3" />
      <p className="text-muted-foreground mb-4">
        {t('knowledgeRadar.noData')}
      </p>
      <p className="text-xs text-muted-foreground mb-4">
        {t('knowledgeRadar.noDataHint')}
      </p>
      {onRefresh && (
        <NotionButton variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="w-4 h-4 mr-2" />
          {t('knowledgeRadar.refreshData')}
        </NotionButton>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const KnowledgeRadar: React.FC<KnowledgeRadarProps> = ({
  examId,
  className,
  showDetailList = true,
}) => {
  const { t } = useTranslation('stats');
  
  // Store hooks
  const knowledgeStats = useKnowledgeStats();
  const isLoading = useLoadingKnowledge();
  const { loadKnowledgeStats } = useQuestionBankStore(
    useShallow((state) => ({
      loadKnowledgeStats: state.loadKnowledgeStats,
    }))
  );

  // 加载数据
  useEffect(() => {
    loadKnowledgeStats(examId).catch(console.error);
  }, [examId, loadKnowledgeStats]);

  // 刷新数据
  const handleRefresh = () => {
    loadKnowledgeStats(examId).catch(console.error);
  };

  // 准备雷达图数据
  const radarData = useMemo(() => {
    if (!knowledgeStats?.current || knowledgeStats.current.length === 0) {
      return [];
    }

    // 取前 8 个知识点用于雷达图展示
    return knowledgeStats.current.slice(0, 8).map(item => ({
      tag: item.tag.length > 6 ? `${item.tag.slice(0, 6)}...` : item.tag,
      fullTag: item.tag,
      mastery_rate: item.mastery_rate,
      correct_rate: item.correct_rate,
      total: item.total,
      mastered: item.mastered,
    }));
  }, [knowledgeStats]);

  // 计算总体统计
  const overallStats = useMemo(() => {
    if (!knowledgeStats?.current || knowledgeStats.current.length === 0) {
      return { avgMastery: 0, avgCorrectRate: 0, totalKnowledgePoints: 0 };
    }

    const items = knowledgeStats.current;
    const avgMastery = Math.round(
      items.reduce((sum, item) => sum + item.mastery_rate, 0) / items.length
    );
    const avgCorrectRate = Math.round(
      items.reduce((sum, item) => sum + item.correct_rate, 0) / items.length
    );

    return {
      avgMastery,
      avgCorrectRate,
      totalKnowledgePoints: items.length,
    };
  }, [knowledgeStats]);

  if (isLoading) {
    return (
      <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
        <RadarSkeleton />
      </div>
    );
  }

  const hasData = radarData.length > 0;

  return (
    <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-purple-500" />
          <h3 className="font-semibold">{t('knowledgeRadar.title')}</h3>
        </div>
        
        <NotionButton
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleRefresh}
        >
          <RefreshCw className="w-4 h-4" />
        </NotionButton>
      </div>

      {/* 总体统计 */}
      {hasData && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg bg-purple-500/10 p-3 text-center">
            <div className="text-xl font-bold text-purple-600">
              {overallStats.avgMastery}%
            </div>
            <div className="text-xs text-muted-foreground">{t('knowledgeRadar.avgMastery')}</div>
          </div>
          <div className="rounded-lg bg-emerald-500/10 p-3 text-center">
            <div className="text-xl font-bold text-emerald-600">
              {overallStats.avgCorrectRate}%
            </div>
            <div className="text-xs text-muted-foreground">{t('knowledgeRadar.avgCorrectRate')}</div>
          </div>
          <div className="rounded-lg bg-blue-500/10 p-3 text-center">
            <div className="text-xl font-bold text-blue-600">
              {overallStats.totalKnowledgePoints}
            </div>
            <div className="text-xs text-muted-foreground">{t('knowledgeRadar.knowledgePoints')}</div>
          </div>
        </div>
      )}

      {/* 雷达图 */}
      {!hasData ? (
        <EmptyState onRefresh={handleRefresh} />
      ) : (
        <div className="h-64 mb-4">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart
              cx="50%"
              cy="50%"
              outerRadius="70%"
              data={radarData}
            >
              <PolarGrid
                stroke="hsl(var(--border))"
                strokeDasharray="3 3"
              />
              <PolarAngleAxis
                dataKey="tag"
                tick={{
                  fill: 'hsl(var(--muted-foreground))',
                  fontSize: 11,
                }}
              />
              <PolarRadiusAxis
                angle={90}
                domain={[0, 100]}
                tick={{
                  fill: 'hsl(var(--muted-foreground))',
                  fontSize: 10,
                }}
                tickCount={5}
              />
              
              {/* 掌握度 */}
              <Radar
                name={t('knowledgeRadar.mastery')}
                dataKey="mastery_rate"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))"
                fillOpacity={0.3}
                strokeWidth={2}
              />
              
              {/* 正确率 */}
              <Radar
                name={t('knowledgeRadar.correctRate')}
                dataKey="correct_rate"
                stroke="hsl(142, 76%, 36%)"
                fill="hsl(142, 76%, 36%)"
                fillOpacity={0.2}
                strokeWidth={2}
                strokeDasharray="5 5"
              />
              
              <Legend
                verticalAlign="bottom"
                height={36}
                iconType="circle"
                iconSize={8}
                formatter={(value) => (
                  <span className="text-xs text-muted-foreground">{value}</span>
                )}
              />
              
              <Tooltip content={<CustomTooltip />} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 知识点详情列表 */}
      {showDetailList && hasData && (
        <div className="border-t border-border/50 pt-4">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t('knowledgeRadar.details')}</span>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {knowledgeStats?.current.map((item, index) => (
              <KnowledgeItem key={item.tag} item={item} index={index} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeRadar;
