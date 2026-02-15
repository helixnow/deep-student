/**
 * 智能题目集统计视图
 * 
 * P2-1 功能：图表展示学习进度和统计数据
 * 
 * 🆕 2026-01 新增
 * 🆕 2026-01 增强：时间维度统计与趋势可视化
 *   - 时间维度选择器（今日/本周/本月/全部）
 *   - 学习趋势折线图
 *   - 学习热力图
 *   - 知识点掌握度雷达图
 */

import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  BookOpen,
  CheckCircle,
  Clock,
  Target,
  TrendingUp,
  AlertCircle,
  Star,
  BarChart3,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuestionBankStats } from '@/api/questionBankApi';
import { LearningTrendChart } from './stats/LearningTrendChart';
import { LearningHeatmapChart } from './stats/LearningHeatmapChart';
import { KnowledgeRadar } from './stats/KnowledgeRadar';
import { Skeleton } from './ui/shad/Skeleton';

// ============================================================================
// 类型定义
// ============================================================================

interface QuestionBankStatsViewProps {
  stats: QuestionBankStats | null;
  examId?: string;
  className?: string;
  /** 是否显示详细统计图表（默认 true） */
  showDetailCharts?: boolean;
  /** 是否使用紧凑模式（默认 false） */
  compact?: boolean;
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  description?: string;
  color?: string;
}

// ============================================================================
// 统计卡片组件
// ============================================================================

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, description, color = 'text-primary' }) => (
  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
    <div className={cn('p-2 rounded-lg bg-background', color)}>
      {icon}
    </div>
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('text-lg font-semibold', color)}>{value}</span>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
    </div>
  </div>
);

// ============================================================================
// 骨架屏组件
// ============================================================================

const StatsSkeleton: React.FC = () => (
  <div className="space-y-6">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {[1, 2, 3, 4].map(i => (
        <Skeleton key={i} className="h-20 rounded-lg" />
      ))}
    </div>
    <Skeleton className="h-3 w-full rounded-full" />
    <Skeleton className="h-10 w-full rounded-lg" />
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export const QuestionBankStatsView: React.FC<QuestionBankStatsViewProps> = ({
  stats,
  examId,
  className,
  showDetailCharts = true,
  compact = false,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);
  const [expandedCharts, setExpandedCharts] = useState(true);
  const correctRatePercent = Math.round((stats?.correctRate ?? 0) * 100);

  const progressData = useMemo(() => {
    if (!stats || stats.total === 0) {
      return {
        masteredPercent: 0,
        inProgressPercent: 0,
        reviewPercent: 0,
        newPercent: 100,
      };
    }

    return {
      masteredPercent: Math.round((stats.mastered / stats.total) * 100),
      inProgressPercent: Math.round((stats.inProgress / stats.total) * 100),
      reviewPercent: Math.round((stats.review / stats.total) * 100),
      newPercent: Math.round((stats.newCount / stats.total) * 100),
    };
  }, [stats]);

  // 空状态
  if (!stats) {
    return (
      <div className={cn('flex items-center justify-center p-8', className)}>
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>{t('exam_sheet:questionBank.stats.noData')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-6', className)}>
      {/* 概览卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard
          icon={<BookOpen className="w-5 h-5" />}
          label={t('exam_sheet:questionBank.stats.total')}
          value={stats.total}
          color="text-blue-500"
        />
        <StatCard
          icon={<CheckCircle className="w-5 h-5" />}
          label={t('exam_sheet:questionBank.stats.mastered')}
          value={stats.mastered}
          description={`${progressData.masteredPercent}%`}
          color="text-green-500"
        />
        <StatCard
          icon={<Clock className="w-5 h-5" />}
          label={t('exam_sheet:questionBank.stats.inProgress')}
          value={stats.inProgress}
          description={`${progressData.inProgressPercent}%`}
          color="text-amber-500"
        />
        <StatCard
          icon={<AlertCircle className="w-5 h-5" />}
          label={t('exam_sheet:questionBank.stats.review')}
          value={stats.review}
          description={`${progressData.reviewPercent}%`}
          color="text-orange-500"
        />
      </div>

      {/* 学习进度条 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium">{t('exam_sheet:questionBank.stats.progress')}</span>
          </div>
          <span className="text-muted-foreground">{progressData.masteredPercent}%</span>
        </div>
        
        {/* 进度条 */}
        <div className="relative h-2 rounded-full bg-muted/50 overflow-hidden">
          <div
            className="absolute left-0 top-0 h-full bg-emerald-500 transition-all"
            style={{ width: `${progressData.masteredPercent}%` }}
          />
          <div
            className="absolute top-0 h-full bg-amber-500 transition-all"
            style={{
              left: `${progressData.masteredPercent}%`,
              width: `${progressData.inProgressPercent}%`,
            }}
          />
          <div
            className="absolute top-0 h-full bg-orange-500 transition-all"
            style={{
              left: `${progressData.masteredPercent + progressData.inProgressPercent}%`,
              width: `${progressData.reviewPercent}%`,
            }}
          />
        </div>
        
        {/* 图例 */}
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-muted-foreground">{t('exam_sheet:questionBank.stats.mastered')}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-muted-foreground">{t('exam_sheet:questionBank.stats.inProgress')}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-orange-500" />
            <span className="text-muted-foreground">{t('exam_sheet:questionBank.stats.review')}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
            <span className="text-muted-foreground">{t('exam_sheet:questionBank.stats.new')}</span>
          </div>
        </div>
      </div>

      {/* 正确率 */}
      <div className="flex items-center justify-between py-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('exam_sheet:questionBank.stats.accuracy')}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
              <circle
                cx="20" cy="20" r="16"
                fill="none" stroke="currentColor" strokeWidth="3"
                strokeDasharray={`${Math.min(correctRatePercent, 100) * 1.005} 100.5`}
                className="text-emerald-500"
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[10px] font-semibold">{correctRatePercent}%</span>
            </div>
          </div>
          <div className="flex items-center gap-1 text-xs">
            <Star className="w-3 h-3 text-amber-400" />
            <span className="text-muted-foreground">
              {correctRatePercent >= 80
                ? t('exam_sheet:questionBank.stats.excellent')
                : correctRatePercent >= 60
                ? t('exam_sheet:questionBank.stats.good')
                : correctRatePercent >= 40
                ? t('exam_sheet:questionBank.stats.needsWork')
                : t('exam_sheet:questionBank.stats.keepGoing')}
            </span>
          </div>
        </div>
      </div>

      {/* 详细统计图表区域 */}
      {showDetailCharts && !compact && (
        <>
          {/* 展开/收起按钮 */}
          <NotionButton variant="ghost" size="sm" onClick={() => setExpandedCharts(!expandedCharts)} className="w-full justify-center !py-2 text-muted-foreground hover:text-foreground border-t border-border/50">
            <BarChart3 className="w-4 h-4" />
            <span>{expandedCharts ? t('exam_sheet:questionBank.stats.collapseCharts') : t('exam_sheet:questionBank.stats.expandCharts')}</span>
            {expandedCharts ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </NotionButton>

          {/* 图表内容 */}
          {expandedCharts && (
            <div className="space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
              {/* 学习趋势图 */}
              <LearningTrendChart 
                examId={examId} 
                showDateRangeSelector={true}
              />

              {/* 两列布局：热力图 + 雷达图 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 学习活跃度热力图 */}
                <LearningHeatmapChart examId={examId} />

                {/* 知识点雷达图 */}
                <KnowledgeRadar 
                  examId={examId} 
                  showDetailList={true}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default QuestionBankStatsView;
