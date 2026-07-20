/**
 * 批改流式渲染容器 - 简洁风格
 *
 * 职责：
 * - 封装流式批改结果的渲染逻辑
 * - 支持流式解析和渲染标记符（实时渲染）
 * - 提供原始内容和批注视图切换
 * - 管理批注选中态（overview 行内批注 ↔ details 卡片双向联动）
 * - 流式期间 stick-to-bottom 自动跟随（用户上滚暂停，回底部恢复）
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StreamingMarkdownRenderer } from '../features/chat/components/renderers';
import { StreamingAnnotatedText, isSuggestionErr } from '../components/essay-grading/StreamingAnnotatedText';
import { hasInlineMarkers, hasScoreMarker, parseStreamingContent, removeScoreTag, removeSectionTags } from './streamingMarkerParser';
import { ScoreCard } from '../components/essay-grading/ScoreCard';
import { SentenceDetailView } from '../components/essay-grading/SentenceDetailView';
import { PolishSectionView } from '../components/essay-grading/PolishSectionView';
import { ModelEssayView } from '../components/essay-grading/ModelEssayView';
import { CircleNotch, CaretDown, CaretUp, FileText, ListChecks, Sparkle, BookOpen } from '@phosphor-icons/react';
import { CustomScrollArea } from '../components/custom-scroll-area';
import { cn } from '@/lib/utils';

export type SectionTab = 'overview' | 'details' | 'polish' | 'model_essay';

export type ViewMode = 'annotated' | 'raw';

type MarkerFilter = 'all' | 'errors' | 'suggestions' | 'highlights';

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
  /** 应用批注中的修改建议到输入区（透传给批注详情卡） */
  onApplySuggestion?: (change: { original: string; replacement: string }) => void;
}

/** 距底部阈值：小于该值视为"贴底"，恢复自动跟随 */
const STICK_TO_BOTTOM_THRESHOLD = 48;

const SectionGeneratingPlaceholder: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 px-4 py-3 rounded-md border border-border/30 bg-muted/10 text-sm text-muted-foreground">
    <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
    <span>{label}</span>
  </div>
);

/**
 * 批改流式渲染容器 - 简洁风格
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
  onApplySuggestion,
}) => {
  const { t } = useTranslation(['essay_grading']);
  const displayPlaceholder = placeholder || t('essay_grading:result_section.placeholder');
  // 内部视图模式仅作为未受控时的默认值（当前无内部切换入口）
  const [internalViewMode] = useState<ViewMode>('annotated');
  const [markerFilter, setMarkerFilter] = useState<MarkerFilter>('all');
  const [showLegend, setShowLegend] = useState(false);

  // 使用外部传入的 viewMode 或内部状态
  const viewMode = externalViewMode ?? internalViewMode;

  const charCount = providedCharCount ?? content.length;
  const [activeTab, setActiveTab] = useState<SectionTab>('overview');

  // 选中批注（parseStreamingContent().markers 原始下标）
  // overview 行内批注与 details 卡片共享此状态实现双向联动
  const [selectedMarkerIndex, setSelectedMarkerIndex] = useState<number | null>(null);

  // 在剥离 section 标签后检测 inline markers，避免 section 内部误触发
  const strippedContent = useMemo(() => removeSectionTags(content), [content]);
  const contentHasInlineMarkers = useMemo(() => hasInlineMarkers(strippedContent), [strippedContent]);
  const contentHasScore = useMemo(() => hasScoreMarker(content), [content]);
  const shouldShowAnnotated = contentHasInlineMarkers && viewMode === 'annotated';

  // 解析结构化数据（markers、score、sections）。
  // 流式中用 useDeferredValue 合并高频 chunk 的重解析（React 低优先级批处理），
  // 流结束后回到实时值做一次完整解析，避免完成态短暂落后。
  const deferredContent = useDeferredValue(content);
  const parseTarget = isStreaming ? deferredContent : content;
  const parseResult = useMemo(
    () => parseStreamingContent(parseTarget, !isStreaming),
    [parseTarget, isStreaming]
  );

  const scoreOnly = useMemo(() => {
    if (!contentHasScore || contentHasInlineMarkers) return null;
    return parseResult.score;
  }, [contentHasScore, contentHasInlineMarkers, parseResult.score]);

  const markdownContent = useMemo(() => {
    if (!contentHasScore || contentHasInlineMarkers) return strippedContent;
    return removeScoreTag(strippedContent);
  }, [strippedContent, contentHasScore, contentHasInlineMarkers]);

  // A6-30: 模型输出了 <score> 标签但解析失败（畸形标签）时，总分区静默缺失。
  // 仅在「确有 score 标签、非批注视图、流已结束却解析不出分数」时给降级提示，
  // 避免对本就没有评分的作文误报。
  const scoreParseFailed = useMemo(
    () => !isStreaming && contentHasScore && !contentHasInlineMarkers && !parseResult.score,
    [isStreaming, contentHasScore, contentHasInlineMarkers, parseResult.score]
  );

  const hasPolish = parseResult.polishItems.length > 0;
  const hasModelEssay = !!parseResult.modelEssay;

  // Tab 稳定性：section 开标签一出现就展示该 Tab（"生成中"态），
  // overview/details 常驻，避免流式中 Tab 突然出现/消失造成布局跳动。
  const polishDetected = useMemo(() => /<section-polish/i.test(content), [content]);
  const modelEssayDetected = useMemo(() => /<section-model-essay/i.test(content), [content]);
  const polishGenerating = isStreaming && polishDetected && !hasPolish;
  const modelEssayGenerating = isStreaming && modelEssayDetected && !hasModelEssay;

  // 新一轮流式开始时重置选中与筛选无关的瞬态
  useEffect(() => {
    if (isStreaming) setSelectedMarkerIndex(null);
  }, [isStreaming]);

  // 选中下标越界（内容重置/回放旧轮次）时清除
  useEffect(() => {
    if (selectedMarkerIndex != null && selectedMarkerIndex >= parseResult.markers.length) {
      setSelectedMarkerIndex(null);
    }
  }, [selectedMarkerIndex, parseResult.markers.length]);

  const handleFilterChange = useCallback((filter: MarkerFilter) => {
    setMarkerFilter(filter);
    // 切换筛选后选中的批注可能被隐藏，直接收起
    setSelectedMarkerIndex(null);
  }, []);

  // 筛选计数
  const filterCounts = useMemo(() => {
    let errors = 0;
    let suggestions = 0;
    let highlights = 0;
    for (const m of parseResult.markers) {
      if (m.type === 'del' || (m.type === 'err' && !isSuggestionErr(m))) errors += 1;
      else if (m.type === 'ins' || m.type === 'replace' || m.type === 'note' || isSuggestionErr(m)) suggestions += 1;
      else if (m.type === 'good') highlights += 1;
    }
    return { all: errors + suggestions + highlights, errors, suggestions, highlights };
  }, [parseResult.markers]);

  // Tab 定义。
  // overview 常驻；details 在流式期间即常驻（不等 marker 逐个解析出来才闪现），
  // 仅纯 Markdown 结果（无行内标记）在流结束后收起；polish/model_essay 见开标签即出现。
  const tabs = useMemo(() => {
    const list: { id: SectionTab; label: string; icon: React.ReactNode; show: boolean; generating?: boolean }[] = [
      { id: 'overview', label: t('essay_grading:sections.tab_overview'), icon: <FileText size={14} />, show: true },
      { id: 'details', label: t('essay_grading:sections.tab_details'), icon: <ListChecks size={14} />, show: isStreaming || contentHasInlineMarkers },
      { id: 'polish', label: t('essay_grading:sections.tab_polish'), icon: <Sparkle size={14} />, show: polishDetected || hasPolish, generating: polishGenerating },
      { id: 'model_essay', label: t('essay_grading:sections.tab_model_essay'), icon: <BookOpen size={14} />, show: modelEssayDetected || hasModelEssay, generating: modelEssayGenerating },
    ];
    return list.filter(tab => tab.show);
  }, [t, isStreaming, contentHasInlineMarkers, polishDetected, hasPolish, polishGenerating, modelEssayDetected, hasModelEssay, modelEssayGenerating]);

  // BUG-6 FIX: 当前 tab 不在可用列表时回退到 overview
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some(tab => tab.id === activeTab)) {
      setActiveTab('overview');
    }
  }, [tabs, activeTab]);

  // -------------------------------------------------------------------------
  // 流式 stick-to-bottom：isStreaming 时自动滚动到底；
  // 用户上滚（距底 > 阈值）暂停跟随，手动回到底部后恢复。
  // -------------------------------------------------------------------------
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  const viewportRefCallback = useCallback((el: HTMLDivElement | null) => {
    setViewportEl(el);
  }, []);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (isStreaming) stickToBottomRef.current = true;
  }, [isStreaming]);

  useEffect(() => {
    if (!viewportEl) return;
    const handleScroll = () => {
      const distance = viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight;
      stickToBottomRef.current = distance < STICK_TO_BOTTOM_THRESHOLD;
    };
    viewportEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewportEl.removeEventListener('scroll', handleScroll);
  }, [viewportEl]);

  useEffect(() => {
    if (!isStreaming || !viewportEl || !stickToBottomRef.current) return;
    viewportEl.scrollTop = viewportEl.scrollHeight;
  }, [content, isStreaming, viewportEl, activeTab]);

  // 非流式下切换分段时回到顶部，避免停留在超出新内容高度的滚动位置
  // （仅响应 tab 实际变化，流式结束等其他依赖变化不重置滚动）
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    const tabChanged = prevTabRef.current !== activeTab;
    prevTabRef.current = activeTab;
    if (!tabChanged || isStreaming || !viewportEl) return;
    viewportEl.scrollTop = 0;
  }, [activeTab, isStreaming, viewportEl]);

  return (
    <div className={`grading-stream-renderer flex min-h-0 flex-col h-full ${className || ''}`}>
      {/* 顶部流式状态提示 - 简洁风格简洁 */}
      {!hideToolbar && !hideStreamingIndicator && isStreaming && (
        <div className="flex items-center gap-2 px-5 py-2 border-b border-border/20">
          <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
            <CircleNotch size={12} className="animate-spin motion-reduce:animate-none" />
            <span>{t('essay_grading:progress.grading')}...</span>
          </div>
        </div>
      )}

      {/* Section Tabs + Filter Bar */}
      {content && !hideToolbar && tabs.length > 1 && (
        <CustomScrollArea
          className="shrink-0 border-b border-border/20"
          viewportClassName="flex items-center gap-1 px-4 py-1"
          orientation="horizontal"
          fullHeight={false}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors duration-150 motion-reduce:transition-none whitespace-nowrap",
                activeTab === tab.id
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]"
              )}
            >
              {tab.icon}
              {tab.label}
              {tab.generating && (
                <CircleNotch size={10} className="animate-spin motion-reduce:animate-none text-muted-foreground/50" />
              )}
            </button>
          ))}
        </CustomScrollArea>
      )}

      {contentHasInlineMarkers && !hideToolbar && activeTab === 'overview' && (
        <div className="px-4 py-1.5 border-b border-border/20 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {(['all', 'errors', 'suggestions', 'highlights'] as const).map((filter) => {
              const count = filterCounts[filter];
              const isZero = count === 0;
              return (
                <button
                  key={filter}
                  onClick={() => handleFilterChange(filter)}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-full transition-colors duration-150 motion-reduce:transition-none tabular-nums",
                    markerFilter === filter
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]",
                    isZero && markerFilter !== filter && "opacity-40"
                  )}
                >
                  {t(`essay_grading:legend.filter_${filter}`)}
                  <span className={cn("ml-1", markerFilter === filter ? "text-primary/70" : "text-muted-foreground/40")}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setShowLegend(!showLegend)}
            className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors duration-150 motion-reduce:transition-none"
          >
            {showLegend ? t('essay_grading:legend.collapse') : t('essay_grading:legend.expand')}
            {showLegend ? <CaretUp size={12} /> : <CaretDown size={12} />}
          </button>
        </div>
      )}
      {showLegend && contentHasInlineMarkers && activeTab === 'overview' && (
        <div className="px-5 py-3 border-b border-border/20 bg-muted/10 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-red-500 line-through">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.del_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-amber-600 dark:text-amber-400 underline decoration-amber-400/70">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.ins_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap"><span className="text-muted-foreground/70 line-through">{t('essay_grading:legend.example_old')}</span><span className="text-muted-foreground/50 mx-0.5">→</span><span className="text-amber-600 dark:text-amber-400">{t('essay_grading:legend.example_new')}</span></span>
            <span className="text-muted-foreground">{t('essay_grading:legend.replace_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-amber-600 dark:text-amber-400 border-b border-dashed border-amber-400/70">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.note_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-emerald-700 dark:text-emerald-300 bg-emerald-100/60 dark:bg-emerald-400/10 border-l-2 border-emerald-400/80 pl-1 pr-0.5 rounded-r-sm">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.good_desc')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-red-500 underline decoration-wavy decoration-red-400/50">{t('essay_grading:legend.example')}</span>
            <span className="text-muted-foreground">{t('essay_grading:legend.err_desc')}</span>
          </div>
        </div>
      )}

      {/* 批改内容 - 简洁风格留白 */}
      {content ? (
        <CustomScrollArea
          className="grading-content flex-1 min-h-0"
          viewportClassName="px-5 pt-5 pb-20"
          viewportRef={viewportRefCallback}
          hideTrackWhenIdle={true}
        >
          <div key={activeTab} className="motion-safe:animate-chat-fade-in">
          {activeTab === 'overview' ? (
            shouldShowAnnotated ? (
              <StreamingAnnotatedText
                text={parseTarget}
                isStreaming={isStreaming}
                showScore={true}
                markerFilter={markerFilter}
                preParsedResult={parseResult}
                activeMarkerIndex={selectedMarkerIndex}
                onMarkerSelect={setSelectedMarkerIndex}
                onApplySuggestion={onApplySuggestion}
              />
            ) : (
              <>
                {scoreOnly && (
                  <ScoreCard score={scoreOnly} className="mb-6" />
                )}
                {scoreParseFailed && (
                  <div className="mb-6 px-4 py-3 rounded-lg border border-border/30 bg-muted/20 text-sm text-muted-foreground">
                    {t('essay_grading:score.parse_failed')}
                  </div>
                )}
                <StreamingMarkdownRenderer
                  content={markdownContent}
                  isStreaming={isStreaming}
                />
              </>
            )
          ) : activeTab === 'details' ? (
            <SentenceDetailView
              markers={parseResult.markers}
              activeMarkerIndex={selectedMarkerIndex}
              onMarkerSelect={setSelectedMarkerIndex}
            />
          ) : activeTab === 'polish' ? (
            polishGenerating ? (
              <SectionGeneratingPlaceholder label={t('essay_grading:sections.generating_polish')} />
            ) : (
              <PolishSectionView items={parseResult.polishItems} />
            )
          ) : activeTab === 'model_essay' ? (
            modelEssayGenerating ? (
              <SectionGeneratingPlaceholder label={t('essay_grading:sections.generating_model_essay')} />
            ) : (
              <ModelEssayView essay={parseResult.modelEssay ?? ''} />
            )
          ) : null}
          </div>
        </CustomScrollArea>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground/40 text-sm select-none px-5">
          {isStreaming ? (
            <div className="flex items-center gap-2">
              <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
              <span>{t('essay_grading:progress.waiting_response')}</span>
            </div>
          ) : (
            displayPlaceholder
          )}
        </div>
      )}

      {/* 字符统计 - 简洁风格极简 */}
      {showStats && content && (
        <div className="flex items-center gap-4 px-5 pb-3 text-xs text-muted-foreground/50 tabular-nums">
          <span>{t('essay_grading:stats.characters')}: {charCount}</span>
        </div>
      )}
    </div>
  );
};
