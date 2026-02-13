/**
 * 评分卡片组件 - Notion 风格设计
 * 简洁、留白、细线边框、柔和色彩
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ParsedScore, GradeCode } from '@/essay-grading/markerParser';

interface ScoreCardProps {
  score: ParsedScore;
  className?: string;
}

export const ScoreCard: React.FC<ScoreCardProps> = ({ score, className }) => {
  const { t } = useTranslation('essay_grading');
  
  const percentage = (score.total / score.maxTotal) * 100;
  
  // 根据百分比获取等级代码
  const getGradeCodeFromPercentage = (pct: number): GradeCode => {
    if (pct >= 90) return 'excellent';
    if (pct >= 75) return 'good';
    if (pct >= 60) return 'pass';
    return 'fail';
  };
  
  // Notion 风格：柔和的文字颜色
  const getGradeColor = (grade: GradeCode) => {
    switch (grade) {
      case 'excellent':
        return 'text-emerald-600 dark:text-emerald-500';
      case 'good':
        return 'text-blue-600 dark:text-blue-500';
      case 'pass':
        return 'text-amber-600 dark:text-amber-500';
      case 'fail':
      default:
        return 'text-red-600 dark:text-red-500';
    }
  };
  
  // Notion 风格：极细的进度条颜色
  const getProgressColor = (pct: number) => {
    if (pct >= 90) return 'bg-emerald-500';
    if (pct >= 75) return 'bg-blue-500';
    if (pct >= 60) return 'bg-amber-500';
    return 'bg-red-500';
  };

  // Notion 风格：柔和的徽章背景
  const getGradeBadgeStyle = (grade: GradeCode) => {
    switch (grade) {
      case 'excellent':
        return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400';
      case 'good':
        return 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400';
      case 'pass':
        return 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400';
      case 'fail':
      default:
        return 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400';
    }
  };
  
  return (
    <div className={cn('mb-6', className)}>
      {/* 总分区域 - Notion 风格简洁布局 */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-4">
          {/* 分数圆环 */}
          <div className="relative w-16 h-16">
            <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
              {/* 背景圆环 */}
              <circle
                cx="32"
                cy="32"
                r="28"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                className="text-muted/20"
              />
              {/* 进度圆环 */}
              <circle
                cx="32"
                cy="32"
                r="28"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={`${percentage * 1.76} 176`}
                className={getGradeColor(score.grade)}
              />
            </svg>
            {/* 中心分数 */}
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={cn('text-xl font-semibold tabular-nums', getGradeColor(score.grade))}>
                {score.total}
              </span>
            </div>
          </div>
          
          <div>
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span className="text-sm text-muted-foreground">{t('score.total')}</span>
            </div>
            <div className="flex items-baseline gap-0.5">
              <span className={cn('text-3xl font-semibold tabular-nums', getGradeColor(score.grade))}>
                {score.total}
              </span>
              <span className="text-base text-muted-foreground/60">
                /{score.maxTotal}
              </span>
            </div>
          </div>
        </div>
        
        {/* 等级徽章 - Notion 风格 */}
        <div className={cn(
          'px-3 py-1.5 rounded-md text-sm font-medium',
          getGradeBadgeStyle(score.grade)
        )}>
          {t(`score.grade.${score.grade}`)}
        </div>
      </div>
      
      {/* 总进度条 - Notion 风格细线 */}
      <div className="h-1 bg-muted/30 rounded-full overflow-hidden mb-5">
        <div
          className={cn('h-full rounded-full transition-all duration-700 ease-out', getProgressColor(percentage))}
          style={{ width: `${percentage}%` }}
        />
      </div>
      
      {/* 分项评分 - Notion 风格简洁列表 */}
      {score.dimensions.length > 0 && (
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
            {t('score.dimensions')}
          </div>
          <div className="space-y-3">
            {score.dimensions.map((dim, index) => {
              const dimPct = (dim.score / dim.maxScore) * 100;
              const dimGrade = getGradeCodeFromPercentage(dimPct);
              return (
                <div key={index} className="group">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-foreground/80">{dim.name}</span>
                    <span className="text-sm tabular-nums">
                      <span className={cn('font-medium', getGradeColor(dimGrade))}>
                        {dim.score}
                      </span>
                      <span className="text-muted-foreground/50 mx-0.5">/</span>
                      <span className="text-muted-foreground/50">{dim.maxScore}</span>
                    </span>
                  </div>
                  {/* 细进度条 */}
                  <div className="h-0.5 bg-muted/20 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all duration-500', getProgressColor(dimPct))}
                      style={{ width: `${dimPct}%` }}
                    />
                  </div>
                  {dim.comment && (
                    <div className="mt-1.5 text-xs text-muted-foreground/60 leading-relaxed">
                      {dim.comment}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ScoreCard;
