/**
 * 流式批注文本渲染组件 - Notion 风格设计
 * 支持在流式传输过程中实时渲染标记
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  parseStreamingContent,
  type StreamingMarker,
  type StreamingParseResult,
  type ParsedScore,
} from '@/essay-grading/streamingMarkerParser';
import { ScoreCard } from './ScoreCard';
import { Loader2 } from 'lucide-react';

// 调试日志（仅在开发模式下生效）
const debugLog = (message: string, data?: Record<string, unknown>) => {
  if (import.meta.env.DEV) {
    try {
      // 动态导入调试模块，避免生产环境打包
      import('@/debug-panel/plugins/EssayGradingTooltipDebugPlugin').then(({ tooltipDebugLog }) => {
        tooltipDebugLog('debug', 'lifecycle', message, data);
      }).catch(() => {
        // 忽略导入失败
      });
    } catch {
      // 忽略
    }
  }
};

interface StreamingAnnotatedTextProps {
  text: string;
  isStreaming: boolean;
  className?: string;
  showScore?: boolean;
  markerFilter?: 'all' | 'errors' | 'suggestions' | 'highlights';
  /** 父组件已解析的结果，传入后跳过内部重复解析 */
  preParsedResult?: StreamingParseResult;
}

/**
 * 获取错误类型的翻译键
 */
const getErrorTypeKey = (type?: string): string => {
  if (type) return `essay_grading:markers.error.${type}`;
  return 'essay_grading:markers.error.grammar';
};

/**
 * 渲染单个标记 - Notion 风格设计
 * 使用 i18n 国际化
 * 注意：TooltipProvider 由父组件提供，此处不再嵌套
 */
const MarkerRenderer: React.FC<{ marker: StreamingMarker; t: (key: string) => string }> = ({ marker, t }) => {
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
    
    case 'pending':
      // 未完成的标记 - Notion 风格
      return (
        <span className={cn(
          'inline text-muted-foreground/60',
          'animate-pulse'
        )}>
          {marker.content}
        </span>
      );
      
    case 'text':
    default:
      // 普通文本，保留换行
      return <span className="whitespace-pre-wrap">{marker.content}</span>;
  }
};

const ScoreGeneratingPlaceholder: React.FC<{ t: (key: string) => string }> = ({ t }) => (
  <div className="flex items-center gap-2 px-4 py-3 bg-muted/20 rounded-lg border border-border/20">
    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
    <span className="text-sm text-muted-foreground">{t('essay_grading:score_generating')}</span>
  </div>
);

/**
 * 流式批注文本组件 - Notion 风格
 */
export const StreamingAnnotatedText: React.FC<StreamingAnnotatedTextProps> = ({
  text,
  isStreaming,
  className,
  showScore = true,
  markerFilter,
  preParsedResult,
}) => {
  const { t } = useTranslation(['essay_grading']);
  
  const internalParseResult = useMemo(
    () => preParsedResult ? null : parseStreamingContent(text, !isStreaming),
    [text, isStreaming, preParsedResult]
  );
  
  const { markers, score } = preParsedResult ?? internalParseResult!;

  const filteredMarkers = useMemo(() => {
    if (!markerFilter || markerFilter === 'all') return markers;
    return markers.map(marker => {
      if (marker.type === 'text' || marker.type === 'pending') return marker;
      const plainContent = marker.content || marker.oldText || '';
      switch (markerFilter) {
        case 'errors':
          return ['del', 'err'].includes(marker.type) ? marker : { ...marker, type: 'text' as const, content: plainContent };
        case 'suggestions':
          return ['ins', 'replace', 'note'].includes(marker.type) ? marker : { ...marker, type: 'text' as const, content: plainContent };
        case 'highlights':
          return marker.type === 'good' ? marker : { ...marker, type: 'text' as const, content: plainContent };
        default:
          return marker;
      }
    });
  }, [markers, markerFilter]);
  
  return (
    <div className={cn('space-y-6', className)}>
      {/* 评分卡片 - 流式中显示占位符，完成后显示最终评分 */}
      {showScore && score && isStreaming && !score.isComplete && (
        <ScoreGeneratingPlaceholder t={t} />
      )}
      {showScore && score && (!isStreaming || score.isComplete) && (
        <ScoreCard score={score} />
      )}
      
      {/* 批注文本 - Notion 风格排版 */}
      <div className="text-[15px] leading-[1.8] text-foreground/85 max-w-none">
        {filteredMarkers.map((marker, index) => (
          <MarkerRenderer key={index} marker={marker} t={t} />
        ))}
        
        {/* 流式光标 - Notion 风格 */}
        {isStreaming && (
          <span className="inline-block w-0.5 h-[1.1em] bg-foreground/40 animate-pulse ml-0.5 align-middle" />
        )}
      </div>
    </div>
  );
};

export default StreamingAnnotatedText;
