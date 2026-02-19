/**
 * 批注文本渲染组件 - Notion 风格设计
 * 解析并渲染带标记的批改结果
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  parseMarkers,
  parseScore,
  removeScoreTag,
  type ParsedMarker,
} from '@/essay-grading/markerParser';
import { ScoreCard } from './ScoreCard';

interface AnnotatedTextProps {
  text: string;
  className?: string;
  showScore?: boolean;
}

/**
 * 获取错误类型的翻译键
 */
const getErrorTypeKey = (type?: string): string => {
  if (type) return `essay_grading:markers.error.${type}`;
  return 'essay_grading:markers.error.grammar';
};

/**
 * 渲染单个标记 - Notion 风格
 */
const MarkerRenderer: React.FC<{ marker: ParsedMarker; t: (key: string) => string }> = ({ marker, t }) => {
  switch (marker.type) {
    case 'del':
      return (
        <CommonTooltip
          content={
            <div className="text-xs">
              <div className="font-medium text-red-500/90 mb-1">{t('essay_grading:markers.delete')}</div>
              {marker.reason && <div className="text-muted-foreground leading-relaxed">{marker.reason}</div>}
            </div>
          }
          position="top"
          maxWidth={320}
        >
          <span className={cn(
            'inline text-red-600/80 dark:text-red-400/80',
            'line-through decoration-red-400/60 decoration-1',
            'cursor-help hover:bg-red-50/50 dark:hover:bg-red-950/30 rounded-sm transition-colors'
          )}>
            {marker.content}
          </span>
        </CommonTooltip>
      );
      
    case 'ins':
      return (
        <CommonTooltip
          content={
            <div className="text-xs">
              <div className="font-medium text-emerald-500/90">{t('essay_grading:markers.insert')}</div>
            </div>
          }
          position="top"
          maxWidth={320}
        >
          <span className={cn(
            'inline text-emerald-600 dark:text-emerald-400',
            'underline decoration-emerald-400/60 decoration-1 underline-offset-2',
            'cursor-help hover:bg-emerald-50/50 dark:hover:bg-emerald-950/30 rounded-sm transition-colors'
          )}>
            {marker.content}
          </span>
        </CommonTooltip>
      );
      
    case 'replace':
      return (
        <CommonTooltip
          content={
            <div className="text-xs">
              <div className="font-medium text-amber-500/90 mb-1">{t('essay_grading:markers.replace')}</div>
              {marker.reason && <div className="text-muted-foreground leading-relaxed">{marker.reason}</div>}
            </div>
          }
          position="top"
          maxWidth={320}
        >
          <span className={cn(
            'inline-flex items-baseline gap-1',
            'cursor-help hover:bg-amber-50/50 dark:hover:bg-amber-950/20 rounded-sm transition-colors px-0.5'
          )}>
            <span className="text-red-500/70 dark:text-red-400/70 line-through decoration-1">{marker.oldText}</span>
            <span className="text-muted-foreground/50 text-xs">→</span>
            <span className="text-emerald-600 dark:text-emerald-400">{marker.newText}</span>
          </span>
        </CommonTooltip>
      );
      
    case 'note':
      return (
        <CommonTooltip
          content={
            <div className="text-xs">
              <div className="font-medium text-blue-500/90 mb-1">{t('essay_grading:markers.note')}</div>
              <div className="text-muted-foreground leading-relaxed">{marker.comment}</div>
            </div>
          }
          position="top"
          maxWidth={320}
        >
          <span className={cn(
            'inline text-blue-600 dark:text-blue-400',
            'border-b border-dashed border-blue-400/60',
            'cursor-help hover:bg-blue-50/50 dark:hover:bg-blue-950/30 rounded-sm transition-colors'
          )}>
            {marker.content}
          </span>
        </CommonTooltip>
      );
      
    case 'good':
      return (
        <CommonTooltip
          content={
            <div className="text-xs">
              <div className="font-medium text-amber-500/90">✨ {t('essay_grading:markers.good')}</div>
            </div>
          }
          position="top"
          maxWidth={320}
        >
          <span className={cn(
            'inline text-amber-600 dark:text-amber-400',
            'bg-amber-50/50 dark:bg-amber-950/20 rounded-sm px-0.5',
            'cursor-help hover:bg-amber-100/70 dark:hover:bg-amber-900/30 transition-colors'
          )}>
            {marker.content}
          </span>
        </CommonTooltip>
      );
      
    case 'err':
      return (
        <CommonTooltip
          content={
            <div className="text-xs">
              <div className="font-medium text-red-500/90 mb-1">
                {t(getErrorTypeKey(marker.errorType))}
              </div>
              {marker.explanation && <div className="text-muted-foreground leading-relaxed">{marker.explanation}</div>}
            </div>
          }
          position="top"
          maxWidth={320}
        >
          <span className={cn(
            'inline text-red-600/90 dark:text-red-400/90',
            'decoration-wavy underline decoration-red-400/50 underline-offset-4',
            'cursor-help hover:bg-red-50/50 dark:hover:bg-red-950/30 rounded-sm transition-colors'
          )}>
            {marker.content}
          </span>
        </CommonTooltip>
      );
      
    case 'text':
    default:
      // 普通文本，保留换行
      return <span className="whitespace-pre-wrap">{marker.content}</span>;
  }
};

/**
 * 批注文本组件 - Notion 风格
 */
export const AnnotatedText: React.FC<AnnotatedTextProps> = ({
  text,
  className,
  showScore = true,
}) => {
  const { t } = useTranslation(['essay_grading']);

  // 解析评分
  const score = useMemo(() => parseScore(text), [text]);
  
  // 移除评分标签后解析标记
  const contentWithoutScore = useMemo(() => removeScoreTag(text), [text]);
  const markers = useMemo(() => parseMarkers(contentWithoutScore), [contentWithoutScore]);
  
  return (
    <div className={cn('space-y-6', className)}>
      {/* 评分卡片 */}
      {showScore && score && (
        <ScoreCard score={score} />
      )}
      
      {/* 批注文本 - Notion 风格排版 */}
      <div className="text-[15px] leading-[1.8] text-foreground/85 max-w-none">
        {markers.map((marker, index) => (
          <MarkerRenderer key={index} marker={marker} t={t} />
        ))}
      </div>
    </div>
  );
};

export default AnnotatedText;
