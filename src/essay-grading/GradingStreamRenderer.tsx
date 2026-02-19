/**
 * 批改流式渲染容器 - Notion 风格
 *
 * 职责：
 * - 封装流式批改结果的渲染逻辑
 * - 支持流式解析和渲染标记符（实时渲染）
 * - 提供原始内容和批注视图切换
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StreamingMarkdownRenderer } from '../chat-v2/components/renderers';
import { StreamingAnnotatedText } from '../components/essay-grading/StreamingAnnotatedText';
import { hasInlineMarkers, hasScoreMarker, parseStreamingContent, removeScoreTag, removeSectionTags } from './streamingMarkerParser';
import { ScoreCard } from '../components/essay-grading/ScoreCard';
import { SentenceDetailView } from '../components/essay-grading/SentenceDetailView';
import { PolishSectionView } from '../components/essay-grading/PolishSectionView';
import { ModelEssayView } from '../components/essay-grading/ModelEssayView';
import { Loader2, ChevronDown, ChevronUp, FileText, ListChecks, Sparkles, BookOpen } from 'lucide-react';
import { CustomScrollArea } from '../components/custom-scroll-area';
import { cn } from '@/lib/utils';

export type SectionTab = 'overview' | 'details' | 'polish' | 'model_essay';

export type ViewMode = 'annotated' | 'raw';

interface GradingStreamRendererProps {
  content: string;
  isStreaming: boolean;
  placeholder?: string;
  showStats?: boolean;
  charCount?: number;
  className?: string;
  /** 外部控制的视图模式 */
  viewMode?: ViewMode;
  /** 是否隐藏内部工具栏（由父组件接管） */
  hideToolbar?: boolean;
  /** 是否隐藏流式状态指示器（父组件已有时设为 true 避免重复） */
  hideStreamingIndicator?: boolean;
}


/**
 * 批改流式渲染容器 - Notion 风格
 */
export const GradingStreamRenderer: React.FC<GradingStreamRendererProps> = ({
  content,
  isStreaming,
  placeholder,
  showStats = true,
  charCount: providedCharCount,
  className,
  viewMode: externalViewMode,
  hideToolbar = false,
  hideStreamingIndicator = false,
}) => {
  const { t } = useTranslation(['essay_grading']);
  const displayPlaceholder = placeholder || t('essay_grading:result_section.placeholder');
  const [internalViewMode, setInternalViewMode] = useState<ViewMode>('annotated');
  const [markerFilter, setMarkerFilter] = useState<'all' | 'errors' | 'suggestions' | 'highlights'>('all');
  const [showLegend, setShowLegend] = useState(false);
  
  // 使用外部传入的 viewMode 或内部状态
  const viewMode = externalViewMode ?? internalViewMode;

  const charCount = providedCharCount ?? content.length;
  const [activeTab, setActiveTab] = useState<SectionTab>('overview');
  
  // 在剥离 section 标签后检测 inline markers，避免 section 内部误触发
  const strippedContent = useMemo(() => removeSectionTags(content), [content]);
  const contentHasInlineMarkers = useMemo(() => hasInlineMarkers(strippedContent), [strippedContent]);
  const contentHasScore = useMemo(() => hasScoreMarker(content), [content]);
  const shouldShowAnnotated = contentHasInlineMarkers && viewMode === 'annotated';

  // 解析结构化数据（markers、score、sections）
  const parseResult = useMemo(
    () => parseStreamingContent(content, !isStreaming),
    [content, isStreaming]
  );
  
  const scoreOnly = useMemo(() => {
    if (!contentHasScore || contentHasInlineMarkers) return null;
    return parseResult.score;
  }, [contentHasScore, contentHasInlineMarkers, parseResult.score]);
  
  const markdownContent = useMemo(() => {
    if (!contentHasScore || contentHasInlineMarkers) return strippedContent;
    return removeScoreTag(strippedContent);
  }, [strippedContent, contentHasScore, contentHasInlineMarkers]);

  const hasPolish = useMemo(() => parseResult.polishItems.length > 0, [parseResult.polishItems]);
  const hasModelEssay = useMemo(() => !!parseResult.modelEssay, [parseResult.modelEssay]);
  const hasDetails = useMemo(() => parseResult.markers.some(m => m.type !== 'text' && m.type !== 'pending' && m.type !== 'good'), [parseResult.markers]);

  // Tab 定义
  const tabs = useMemo(() => {
    const list: { id: SectionTab; label: string; icon: React.ReactNode; show: boolean }[] = [
      { id: 'overview', label: t('essay_grading:sections.tab_overview'), icon: <FileText className="w-3.5 h-3.5" />, show: true },
      { id: 'details', label: t('essay_grading:sections.tab_details'), icon: <ListChecks className="w-3.5 h-3.5" />, show: hasDetails },
      { id: 'polish', label: t('essay_grading:sections.tab_polish'), icon: <Sparkles className="w-3.5 h-3.5" />, show: hasPolish },
      { id: 'model_essay', label: t('essay_grading:sections.tab_model_essay'), icon: <BookOpen className="w-3.5 h-3.5" />, show: hasModelEssay },
    ];
    return list.filter(tab => tab.show);
  }, [t, hasDetails, hasPolish, hasModelEssay]);

  // BUG-6 FIX: 当前 tab 不在可用列表时回退到 overview
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some(tab => tab.id === activeTab)) {
      setActiveTab('overview');
    }
  }, [tabs, activeTab]);

  return (
    <div className={`grading-stream-renderer flex flex-col h-full ${className || ''}`}>
      {/* 顶部流式状态提示 - Notion 风格简洁 */}
      {!hideToolbar && !hideStreamingIndicator && isStreaming && (
        <div className="flex items-center gap-2 px-5 py-2 border-b border-border/20">
          <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{t('essay_grading:progress.grading')}...</span>
          </div>
        </div>
      )}

      {/* Section Tabs + Filter Bar */}
      {content && !hideToolbar && tabs.length > 1 && (
        <div className="px-4 py-1 border-b border-border/20 flex items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors whitespace-nowrap",
                activeTab === tab.id
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {contentHasInlineMarkers && !hideToolbar && activeTab === 'overview' && (
        <div className="px-4 py-1.5 border-b border-border/20 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {(['all', 'errors', 'suggestions', 'highlights'] as const).map((filter) => (
              <button
                key={filter}
                onClick={() => setMarkerFilter(filter)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-full transition-colors",
                  markerFilter === filter
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50"
                )}
              >
                {t(`essay_grading:legend.filter_${filter}`)}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setShowLegend(!showLegend)}
            className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            {showLegend ? t('essay_grading:legend.collapse') : t('essay_grading:legend.expand')}
            {showLegend ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      )}
      {showLegend && contentHasInlineMarkers && activeTab === 'overview' && (
        <div className="px-5 py-3 border-b border-border/20 bg-muted/10 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-red-500 line-through">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.del_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-500 underline">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.ins_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span><span className="text-red-400 line-through">{t('essay_grading:legend.example_old')}</span><span className="text-muted-foreground/50 mx-0.5">→</span><span className="text-emerald-500">{t('essay_grading:legend.example_new')}</span></span>
            <span className="text-muted-foreground">{t('essay_grading:legend.replace_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-blue-500 border-b border-dashed border-blue-400">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.note_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-amber-500 bg-amber-50 dark:bg-amber-950/20 px-1 rounded">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.good_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-red-500 underline decoration-wavy decoration-red-400/50">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.err_desc')}</span>
          </div>
        </div>
      )}

      {/* 批改内容 - Notion 风格留白 */}
      <CustomScrollArea 
        className="grading-content flex-1 min-h-0"
        viewportClassName="px-5 pt-5 pb-20"
        hideTrackWhenIdle={true}
      >
        {content ? (
          activeTab === 'overview' ? (
            shouldShowAnnotated ? (
              <StreamingAnnotatedText
                text={content}
                isStreaming={isStreaming}
                showScore={true}
                markerFilter={markerFilter}
                preParsedResult={parseResult}
              />
            ) : (
              <>
                {scoreOnly && (!isStreaming || scoreOnly.isComplete) && (
                  <ScoreCard score={scoreOnly} className="mb-6" />
                )}
                <StreamingMarkdownRenderer
                  content={markdownContent}
                  isStreaming={isStreaming}
                />
              </>
            )
          ) : activeTab === 'details' ? (
            <SentenceDetailView markers={parseResult.markers} />
          ) : activeTab === 'polish' ? (
            <PolishSectionView items={parseResult.polishItems} />
          ) : activeTab === 'model_essay' ? (
            <ModelEssayView essay={parseResult.modelEssay ?? ''} />
          ) : null
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground/40 text-sm select-none">
            {displayPlaceholder}
          </div>
        )}
      </CustomScrollArea>

      {/* 字符统计 - Notion 风格极简 */}
      {showStats && content && (
        <div className="flex items-center gap-4 px-5 pb-3 text-xs text-muted-foreground/50 tabular-nums">
          <span>{t('essay_grading:stats.characters')}: {charCount}</span>
        </div>
      )}
    </div>
  );
};
