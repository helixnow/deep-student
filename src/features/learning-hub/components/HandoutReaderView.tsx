import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import {
  BookOpen,
  Check,
  FileArrowDown,
  FilePlus,
  Play,
  Printer,
  Sparkle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import {
  CALLOUT_KIND_LABELS,
  DIFFICULTY_META,
  h1Num,
  h2Num,
  handoutIrToMarkdown,
  validateHandoutIr,
  type HandoutBlock,
  type HandoutCalloutBlock,
  type HandoutCalloutKind,
  type HandoutCheckpointBlock,
  type HandoutContentBlock,
  type HandoutDiagramBlock,
  type HandoutDifficulty,
  type HandoutDocument,
  type HandoutExtendedBlock,
  type HandoutFormulaBlock,
  type HandoutSection,
  type HandoutSectionAnchorPayload,
} from '../utils/handoutIr';

export {
  h1Num,
  h2Num,
  handoutIrToMarkdown,
  validateHandoutIr,
  type HandoutBlock,
  type HandoutCalloutBlock,
  type HandoutCalloutKind,
  type HandoutCheckpointBlock,
  type HandoutContentBlock,
  type HandoutDiagramBlock,
  type HandoutDifficulty,
  type HandoutDocument,
  type HandoutExtendedBlock,
  type HandoutFormulaBlock,
  type HandoutSection,
  type HandoutSectionAnchorPayload,
};

export interface HandoutReaderViewProps {
  document: HandoutDocument;
  initialCompletedSectionIds?: string[];
  onExportMarkdown?: (markdown: string, document: HandoutDocument) => void;
  onSaveToNote?: (
    doc: HandoutDocument,
    markdown: string,
  ) => boolean | void | Promise<boolean | void>;
  onPrintView?: (document: HandoutDocument) => void;
  onBindMiniChatAnchor?: (anchor: HandoutSectionAnchorPayload) => void;
  /** 网课音视频伴读回调：点击章节或配图时间锚点跳转至视频对应秒数 */
  onSeekTimestamp?: (seconds: number) => void;
  className?: string;
}

// ============================================================================
// 表格数值与 SVG 消毒工具函数
// ============================================================================

const NUMERIC_CELL_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:%|e[+-]?\d+)?$/i;

function isNumericTableCell(cell: string): boolean {
  return NUMERIC_CELL_RE.test(cell.trim());
}

/** 严格消毒讲义内联 SVG 图表，彻底剥离 script / 事件属性 / javascript: / foreignObject */
export function sanitizeHandoutSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'xlink:href'],
  });
}

function getSectionId(section: HandoutSection, index: number): string {
  return section.id ?? `section-${index + 1}`;
}

function formatAnchorClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const SEEK_FEEDBACK_MS = 1200;
const ACTION_FEEDBACK_MS = 3500;

// ============================================================================
// 组件实现
// ============================================================================

export const HandoutReaderView: React.FC<HandoutReaderViewProps> = ({
  document: doc,
  initialCompletedSectionIds = [],
  onExportMarkdown,
  onSaveToNote,
  onPrintView,
  onBindMiniChatAnchor,
  onSeekTimestamp,
  className,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [selectedDifficulty, setSelectedDifficulty] = useState<'all' | HandoutDifficulty>('all');
  const [activeSectionId, setActiveSectionId] = useState<string>(() =>
    doc.sections.length > 0 ? getSectionId(doc.sections[0], 0) : '',
  );
  const [completedSections, setCompletedSections] = useState<Set<string>>(
    () => new Set(initialCompletedSectionIds),
  );
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [isPrintPreview, setIsPrintPreview] = useState(false);
  const [savedToNote, setSavedToNote] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [justSeekedKey, setJustSeekedKey] = useState<string | null>(null);

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const seekTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setSavedToNote(false);
  }, [doc]);

  useEffect(() => () => {
    if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const showActionFeedback = useCallback((message: string | null) => {
    setActionFeedback(message);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    if (message) {
      feedbackTimerRef.current = window.setTimeout(() => {
        setActionFeedback(null);
        feedbackTimerRef.current = null;
      }, ACTION_FEEDBACK_MS);
    }
  }, []);

  const difficultyLabels = useMemo<Record<HandoutDifficulty, string>>(
    () => ({
      foundation: t('learningHub:handoutReader.difficulty.foundation', {
        defaultValue: DIFFICULTY_META.foundation.label,
      }),
      intermediate: t('learningHub:handoutReader.difficulty.intermediate', {
        defaultValue: DIFFICULTY_META.intermediate.label,
      }),
      olympiad: t('learningHub:handoutReader.difficulty.olympiad', {
        defaultValue: DIFFICULTY_META.olympiad.label,
      }),
    }),
    [t],
  );

  const calloutLabels = useMemo<Record<HandoutCalloutKind, string>>(
    () => ({
      theorem: t('learningHub:handoutReader.callout.theorem', {
        defaultValue: CALLOUT_KIND_LABELS.theorem,
      }),
      definition: t('learningHub:handoutReader.callout.definition', {
        defaultValue: CALLOUT_KIND_LABELS.definition,
      }),
      lemma: t('learningHub:handoutReader.callout.lemma', {
        defaultValue: CALLOUT_KIND_LABELS.lemma,
      }),
      corollary: t('learningHub:handoutReader.callout.corollary', {
        defaultValue: CALLOUT_KIND_LABELS.corollary,
      }),
      pitfall: t('learningHub:handoutReader.callout.pitfall', {
        defaultValue: CALLOUT_KIND_LABELS.pitfall,
      }),
      example: t('learningHub:handoutReader.callout.example', {
        defaultValue: CALLOUT_KIND_LABELS.example,
      }),
    }),
    [t],
  );

  const allSectionEntries = useMemo(
    () =>
      doc.sections.map((section, index) => ({
        section,
        index,
        id: getSectionId(section, index),
        difficulty: section.difficulty ?? doc.difficulty ?? 'foundation',
      })),
    [doc.sections, doc.difficulty],
  );

  const filteredSectionEntries = useMemo(() => {
    if (selectedDifficulty === 'all') return allSectionEntries;
    return allSectionEntries.filter((entry) => entry.difficulty === selectedDifficulty);
  }, [allSectionEntries, selectedDifficulty]);

  // 当切换难度筛选导致当前选中章节被隐藏时，自动回退选中首个可见章节
  useEffect(() => {
    if (filteredSectionEntries.length === 0) return;
    const isActiveStillVisible = filteredSectionEntries.some(
      (entry) => entry.id === activeSectionId,
    );
    if (!isActiveStillVisible) {
      setActiveSectionId(filteredSectionEntries[0].id);
    }
  }, [filteredSectionEntries, activeSectionId]);

  // 汇总所有自测题统计
  const allCheckpoints = useMemo(() => {
    const list: HandoutCheckpointBlock[] = [];
    for (const sec of doc.sections) {
      for (const block of sec.blocks) {
        if (block.type === 'checkpoint') {
          list.push(block);
        }
      }
    }
    return list;
  }, [doc.sections]);

  const checkpointStats = useMemo(() => {
    const total = allCheckpoints.length;
    let answered = 0;
    let correct = 0;
    for (const cp of allCheckpoints) {
      const userChoice = selectedAnswers[cp.id];
      if (userChoice !== undefined) {
        answered += 1;
        if (userChoice === cp.answerIndex) {
          correct += 1;
        }
      }
    }
    const accuracyRate = answered > 0 ? Math.round((correct / answered) * 100) : 0;
    return { total, answered, correct, accuracyRate };
  }, [allCheckpoints, selectedAnswers]);

  const readingProgress = useMemo(() => {
    const total = allSectionEntries.length;
    const completed = allSectionEntries.filter((entry) =>
      completedSections.has(entry.id),
    ).length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, percent };
  }, [allSectionEntries, completedSections]);

  const totalEstimatedMinutes = useMemo(() => {
    if (doc.estimatedMinutes && doc.estimatedMinutes > 0) return doc.estimatedMinutes;
    const sum = doc.sections.reduce((acc, s) => acc + (s.estimatedMinutes ?? 5), 0);
    return sum;
  }, [doc.estimatedMinutes, doc.sections]);

  const handleSelectTocSection = useCallback((sectionId: string) => {
    setActiveSectionId(sectionId);
    const targetEl = sectionRefs.current[sectionId];
    targetEl?.scrollIntoView?.({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  }, []);

  const handleSeekAnchor = useCallback(
    (anchorKey: string, seconds: number) => {
      if (!onSeekTimestamp) return;
      onSeekTimestamp(seconds);
      setJustSeekedKey(anchorKey);
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = window.setTimeout(() => {
        setJustSeekedKey((prev) => (prev === anchorKey ? null : prev));
        seekTimerRef.current = null;
      }, SEEK_FEEDBACK_MS);
    },
    [onSeekTimestamp],
  );

  const handleToggleSectionRead = useCallback((sectionId: string) => {
    setCompletedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  const handleSelectCheckpointOption = useCallback(
    (checkpointId: string, optionIndex: number, sectionId: string) => {
      setSelectedAnswers((prev) => ({
        ...prev,
        [checkpointId]: optionIndex,
      }));
      setCompletedSections((prev) => {
        if (prev.has(sectionId)) return prev;
        const next = new Set(prev);
        next.add(sectionId);
        return next;
      });
    },
    [],
  );

  const handleExportMarkdown = useCallback(() => {
    const md = handoutIrToMarkdown(doc);
    onExportMarkdown?.(md, doc);
    showActionFeedback(
      t('learningHub:handoutReader.exportedMarkdown', { defaultValue: '已导出 Markdown' }),
    );
  }, [doc, onExportMarkdown, showActionFeedback, t]);

  const handleSaveToNote = useCallback(async () => {
    if (!onSaveToNote) return;
    const md = handoutIrToMarkdown(doc);
    try {
      const saveResult = await onSaveToNote(doc, md);
      if (saveResult !== false) {
        setSavedToNote(true);
        showActionFeedback(
          t('learningHub:handoutReader.savedToNote', { defaultValue: '已转存至笔记' }),
        );
      } else {
        setSavedToNote(false);
        showActionFeedback(null);
      }
    } catch {
      setSavedToNote(false);
      showActionFeedback(null);
    }
  }, [doc, onSaveToNote, showActionFeedback, t]);

  const handlePrintView = useCallback(() => {
    setIsPrintPreview((prev) => !prev);
    onPrintView?.(doc);
    showActionFeedback(
      t('learningHub:handoutReader.toggledPrintView', { defaultValue: '已切换打印视图' }),
    );
  }, [doc, onPrintView, showActionFeedback, t]);

  const docDifficulty = doc.difficulty ?? 'intermediate';

  return (
    <div
      data-testid="handout-reader-view"
      data-print-mode={isPrintPreview ? 'true' : 'false'}
      className={cn(
        'flex flex-col w-full bg-background text-foreground border border-border/35 rounded-xl overflow-hidden',
        isPrintPreview && 'bg-background text-foreground shadow-sm print:border-0',
        className,
      )}
    >
      {/* 顶栏操作与全局状态区 */}
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-border/35 bg-muted/20">
        <div className="flex items-center gap-3 min-w-0">
          <BookOpen className="w-4 h-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground truncate">
                {doc.courseName ??
                  t('learningHub:handoutReader.defaultCourseName', {
                    defaultValue: '深度精读讲义',
                  })}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-0.5 text-2xs font-medium rounded-full border',
                  DIFFICULTY_META[docDifficulty].badgeClass,
                )}
              >
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    DIFFICULTY_META[docDifficulty].dotClass,
                  )}
                />
                {difficultyLabels[docDifficulty]}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* 阅读进度与自测得分率统计 */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span>
                {t('learningHub:handoutReader.estimatedRead', { defaultValue: '预计阅读' })}
              </span>
              <strong className="font-mono tabular-nums text-foreground">
                {totalEstimatedMinutes}
              </strong>
              <span>
                {t('learningHub:handoutReader.minutesUnit', { defaultValue: '分钟' })}
              </span>
            </span>
            <span className="h-3 w-px bg-border/35" />
            <span className="inline-flex items-center gap-1.5" data-testid="handout-reading-progress">
              <span>
                {t('learningHub:handoutReader.readingProgress', { defaultValue: '阅读进度' })}
              </span>
              <strong className="font-mono tabular-nums text-foreground">
                {readingProgress.completed}/{readingProgress.total}
              </strong>
              <span className="font-mono tabular-nums text-muted-foreground">
                ({readingProgress.percent}%)
              </span>
            </span>
            {checkpointStats.total > 0 && (
              <>
                <span className="h-3 w-px bg-border/35" />
                <span
                  className="inline-flex items-center gap-1.5"
                  data-testid="handout-checkpoint-score"
                >
                  <span>
                    {t('learningHub:handoutReader.checkpointScore', {
                      defaultValue: '自测得分率',
                    })}
                  </span>
                  <strong className="font-mono tabular-nums text-foreground">
                    {checkpointStats.accuracyRate}%
                  </strong>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    ({checkpointStats.correct}/{checkpointStats.total})
                  </span>
                </span>
              </>
            )}
          </div>

          {/* 顶栏操作按钮 */}
          <div className="flex items-center gap-1.5">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleExportMarkdown}
              className="!h-auto gap-1.5 !px-2.5 !py-1.5 text-xs font-medium rounded-md border border-border/35 bg-background text-foreground hover:bg-muted/60 active:scale-[0.98] motion-reduce:transition-none motion-reduce:transform-none"
            >
              <FileArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {t('learningHub:handoutReader.exportMarkdown', {
                  defaultValue: '导出 Markdown',
                })}
              </span>
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => void handleSaveToNote()}
              data-saved={savedToNote ? 'true' : 'false'}
              className={cn(
                '!h-auto gap-1.5 !px-2.5 !py-1.5 text-xs font-medium rounded-md border border-border/35 active:scale-[0.98] motion-reduce:transition-none motion-reduce:transform-none',
                savedToNote
                  ? 'bg-success/15 text-success hover:bg-success/20'
                  : 'bg-background text-foreground hover:bg-muted/60',
              )}
            >
              {savedToNote ? (
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <FilePlus className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>
                {savedToNote
                  ? t('learningHub:handoutReader.savedToNote', {
                      defaultValue: '已转存至笔记',
                    })
                  : t('learningHub:handoutReader.saveToNote', {
                      defaultValue: '转存至笔记',
                    })}
              </span>
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handlePrintView}
              aria-pressed={isPrintPreview}
              className={cn(
                '!h-auto gap-1.5 !px-2.5 !py-1.5 text-xs font-medium rounded-md border border-border/35 active:scale-[0.98] motion-reduce:transition-none motion-reduce:transform-none',
                isPrintPreview
                  ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-muted/60',
              )}
            >
              <Printer className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {t('learningHub:handoutReader.printView', { defaultValue: '打印视图' })}
              </span>
            </DsButton>
          </div>
        </div>
      </header>

      {actionFeedback && (
        <div
          role="status"
          aria-live="polite"
          className="px-5 py-1.5 text-xs bg-primary/10 text-primary border-b border-border/35 flex items-center justify-between ui-fade-in motion-reduce:animate-none"
        >
          <span>{actionFeedback}</span>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => showActionFeedback(null)}
            className="!h-auto !px-1.5 !py-0.5 text-2xs text-primary underline hover:bg-primary/10 motion-reduce:transition-none"
          >
            {t('learningHub:handoutReader.dismissFeedback', { defaultValue: '关闭提示' })}
          </DsButton>
        </div>
      )}

      {/* 主体：左侧 TOC 目录导航 + 右侧印刷级正文排版 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[520px]">
        {/* 左侧目录导航与难度筛选 */}
        <aside
          aria-label={t('learningHub:handoutReader.tocAria', { defaultValue: '章节目录导航' })}
          className="lg:col-span-3 border-b lg:border-b-0 lg:border-r border-border/35 bg-muted/10 p-4 flex flex-col gap-4"
        >
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold tracking-wide text-foreground">
                {t('learningHub:handoutReader.tocTitle', { defaultValue: '章节目录' })}
              </span>
              <span className="text-xs font-mono tabular-nums text-muted-foreground">
                {readingProgress.percent}%
              </span>
            </div>
            {/* 阅读进度条 */}
            <div
              role="progressbar"
              aria-label={t('learningHub:handoutReader.readingProgressBarAria', {
                defaultValue: '讲义阅读进度',
              })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={readingProgress.percent}
              className="w-full h-1.5 rounded-full bg-muted overflow-hidden"
            >
              <div
                className="h-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
                style={{ width: `${readingProgress.percent}%` }}
              />
            </div>
          </div>

          {/* 难度筛选器 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold tracking-wide text-foreground">
              {t('learningHub:handoutReader.filterTitle', { defaultValue: '按难度筛选章节' })}
            </span>
            <div
              role="group"
              aria-label={t('learningHub:handoutReader.filterAria', { defaultValue: '难度筛选' })}
              className="grid grid-cols-2 gap-1"
            >
              {(
                [
                  {
                    key: 'all',
                    label: t('learningHub:handoutReader.filterAll', {
                      defaultValue: '全部章节',
                    }),
                  },
                  { key: 'foundation', label: difficultyLabels.foundation },
                  { key: 'intermediate', label: difficultyLabels.intermediate },
                  { key: 'olympiad', label: difficultyLabels.olympiad },
                ] as const
              ).map((item) => (
                <DsButton
                  key={item.key}
                  variant="ghost"
                  size="sm"
                  aria-pressed={selectedDifficulty === item.key}
                  onClick={() => setSelectedDifficulty(item.key)}
                  className={cn(
                    '!h-auto !justify-start !px-2 !py-1 text-xs rounded border border-border/35 text-left motion-reduce:transition-none',
                    selectedDifficulty === item.key
                      ? 'bg-primary text-primary-foreground border-primary font-medium hover:bg-primary/90 hover:text-primary-foreground'
                      : 'bg-background/70 text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  )}
                >
                  {item.label}
                </DsButton>
              ))}
            </div>
          </div>

          <div className="h-px bg-border/35" />

          {/* 目录列表 */}
          <nav className="flex flex-col gap-1 flex-1">
            {filteredSectionEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                {t('learningHub:handoutReader.emptyFiltered', {
                  defaultValue: '当前难度下暂无章节',
                })}
              </p>
            ) : (
              filteredSectionEntries.map(({ section, index, id, difficulty }) => {
                const isActive = activeSectionId === id;
                const isCompleted = completedSections.has(id);
                return (
                  <div
                    key={id}
                    className={cn(
                      'group flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border transition-colors duration-150 motion-reduce:transition-none',
                      isActive
                        ? 'bg-primary/10 border-primary/30 text-foreground'
                        : 'border-transparent hover:bg-muted/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSelectTocSection(id)}
                      aria-current={isActive ? 'location' : undefined}
                      className="!h-auto !min-h-0 !justify-start gap-2 !px-0 !py-0.5 text-left text-xs min-w-0 flex-1 bg-transparent hover:bg-transparent text-inherit motion-reduce:transition-none"
                    >
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full shrink-0 transition-colors duration-150 motion-reduce:transition-none',
                          isCompleted
                            ? 'bg-success'
                            : isActive
                              ? 'bg-primary'
                              : DIFFICULTY_META[difficulty].dotClass,
                        )}
                      />
                      <span className="truncate font-medium">
                        {h1Num(index)}、{section.heading}
                      </span>
                    </DsButton>
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground shrink-0">
                      {difficultyLabels[difficulty]}
                    </span>
                  </div>
                );
              })
            )}
          </nav>
        </aside>

        {/* 右侧印刷级讲义正文 */}
        <main className="lg:col-span-9 p-6 lg:p-8 flex flex-col gap-8">
          {/* 讲义标题与导读摘要 */}
          <div className="pb-6 border-b border-border/35">
            <h1 className="text-2xl font-bold tracking-tight text-foreground mb-3">
              {doc.title}
            </h1>
            {doc.summary && (
              <p className="text-sm text-muted-foreground leading-relaxed bg-muted/25 p-4 rounded-lg border border-border/35">
                {doc.summary}
              </p>
            )}
          </div>

          {/* 章节列表 */}
          {filteredSectionEntries.map(({ section, index, id, difficulty }) => {
            const isCompleted = completedSections.has(id);
            const isActive = activeSectionId === id;
            const sectionAnchorKey = `section:${id}`;
            const isSectionJustSeeked = justSeekedKey === sectionAnchorKey;
            const formattedAnchorTime =
              section.anchorSeconds !== undefined
                ? formatAnchorClock(section.anchorSeconds)
                : null;
            let subHeadingCounter = 0;

            return (
              <section
                key={id}
                id={id}
                ref={(node) => {
                  sectionRefs.current[id] = node;
                }}
                data-testid={`handout-section-${id}`}
                data-active={isActive ? 'true' : 'false'}
                className={cn(
                  'scroll-mt-4 flex flex-col gap-4 pb-8 border-b border-border/35 last:border-b-0 transition-[background-color,box-shadow] duration-200 motion-reduce:transition-none',
                  isActive && 'ring-1 ring-primary/20 rounded-lg p-4 -mx-4 bg-muted/5',
                )}
              >
                {/* 章节标题行 */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full transition-colors duration-150 motion-reduce:transition-none',
                        isCompleted ? 'bg-success' : DIFFICULTY_META[difficulty].dotClass,
                      )}
                    />
                    <h2 className="text-lg font-semibold text-foreground">
                      {h1Num(index)}、{section.heading}
                    </h2>
                    <span
                      className={cn(
                        'px-2 py-0.5 text-2xs rounded-full border',
                        DIFFICULTY_META[difficulty].badgeClass,
                      )}
                    >
                      {difficultyLabels[difficulty]}
                    </span>
                    {section.estimatedMinutes && (
                      <span className="text-xs font-mono tabular-nums text-muted-foreground">
                        {t('learningHub:handoutReader.sectionMinutes', {
                          count: section.estimatedMinutes,
                          defaultValue: '{{count}} 分钟',
                        })}
                      </span>
                    )}
                    {onSeekTimestamp &&
                      section.anchorSeconds !== undefined &&
                      formattedAnchorTime && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSeekAnchor(sectionAnchorKey, section.anchorSeconds!)}
                          data-testid={`handout-seek-section-${id}`}
                          aria-label={t('learningHub:handoutReader.jumpToTime', {
                            time: formattedAnchorTime,
                            defaultValue: '跳转至 {{time}}',
                          })}
                          className={cn(
                            '!h-auto gap-1 !px-2 !py-0.5 text-2xs font-mono tabular-nums rounded-full border active:scale-95 motion-reduce:transition-none motion-reduce:transform-none',
                            isSectionJustSeeked
                              ? 'border-success/40 bg-success/15 text-success hover:bg-success/20'
                              : 'border-border/35 bg-background/80 text-primary hover:bg-primary/10',
                          )}
                        >
                          {isSectionJustSeeked ? (
                            <Check className="w-3 h-3" aria-hidden="true" />
                          ) : (
                            <Play className="w-2.5 h-2.5" weight="fill" aria-hidden="true" />
                          )}
                          <span>
                            {isSectionJustSeeked
                              ? t('learningHub:handoutReader.jumpedToTime', {
                                  time: formattedAnchorTime,
                                  defaultValue: '已定位 {{time}}',
                                })
                              : formattedAnchorTime}
                          </span>
                        </DsButton>
                      )}
                  </div>

                  <div className="flex items-center gap-2">
                    {onBindMiniChatAnchor && (
                      <DsButton
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onBindMiniChatAnchor({
                            kind: 'handout_section',
                            label: `${h1Num(index)}、${section.heading}`,
                            referenceId: id,
                          })
                        }
                        className="!h-auto gap-1 !px-2 !py-1 text-xs rounded border border-border/35 text-muted-foreground hover:text-foreground hover:bg-muted/50 active:scale-[0.98] motion-reduce:transition-none motion-reduce:transform-none"
                      >
                        <Sparkle className="w-3 h-3" aria-hidden="true" />
                        <span>
                          {t('learningHub:handoutReader.askCompanion', {
                            defaultValue: '伴读提问',
                          })}
                        </span>
                      </DsButton>
                    )}
                    <DsButton
                      variant="ghost"
                      size="sm"
                      aria-pressed={isCompleted}
                      onClick={() => handleToggleSectionRead(id)}
                      className={cn(
                        '!h-auto gap-1 !px-2.5 !py-1 text-xs rounded border active:scale-[0.98] motion-reduce:transition-none motion-reduce:transform-none',
                        isCompleted
                          ? 'bg-success/15 text-success border-border/35 hover:bg-success/20'
                          : 'border-border/35 text-muted-foreground hover:text-foreground hover:bg-muted/50',
                      )}
                    >
                      <Check className="w-3 h-3" aria-hidden="true" />
                      <span>
                        {isCompleted
                          ? t('learningHub:handoutReader.completedRead', {
                              defaultValue: '已完成阅读',
                            })
                          : t('learningHub:handoutReader.markRead', {
                              defaultValue: '标记已读',
                            })}
                      </span>
                    </DsButton>
                  </div>
                </div>

                {/* 章节内容块渲染 */}
                <div className="flex flex-col gap-4">
                  {section.blocks.map((block, blockIndex) => {
                    const blockKey = `${id}-block-${blockIndex}`;

                    switch (block.type) {
                      case 'lead':
                        return (
                          <p
                            key={blockKey}
                            className="text-sm font-medium text-foreground/90 leading-7 bg-primary/5 px-4 py-2.5 rounded-md border-l-2 border-primary"
                          >
                            {block.text}
                          </p>
                        );

                      case 'para':
                        return (
                          <p
                            key={blockKey}
                            className="text-sm text-foreground/90 leading-7 indent-8"
                          >
                            {block.text}
                          </p>
                        );

                      case 'note':
                        return (
                          <div
                            key={blockKey}
                            className="text-xs text-muted-foreground bg-muted/30 px-3.5 py-2.5 rounded-lg border border-border/35"
                          >
                            <span className="font-semibold text-foreground">
                              {t('learningHub:handoutReader.notePrefix', {
                                defaultValue: '批注：',
                              })}
                            </span>
                            {block.text}
                          </div>
                        );

                      case 'h2': {
                        const numLabel = h2Num(subHeadingCounter++);
                        return (
                          <h3
                            key={blockKey}
                            className="text-base font-semibold text-foreground mt-2"
                          >
                            {numLabel}
                            {block.text}
                          </h3>
                        );
                      }

                      case 'list': {
                        const ListTag = block.ordered ? 'ol' : 'ul';
                        return (
                          <ListTag
                            key={blockKey}
                            className={cn(
                              'pl-6 space-y-1.5 text-sm text-foreground/90',
                              block.ordered ? 'list-decimal' : 'list-disc',
                            )}
                          >
                            {block.items.map((item, i) => (
                              <li key={i} className="leading-6">
                                {item}
                              </li>
                            ))}
                          </ListTag>
                        );
                      }

                      case 'table':
                        return (
                          <div
                            key={blockKey}
                            className="overflow-x-auto border border-border/35 rounded-lg"
                          >
                            <table className="w-full text-xs border-collapse">
                              {block.caption && (
                                <caption className="py-2 px-3 font-medium text-muted-foreground border-b border-border/35 bg-muted/15">
                                  {block.caption}
                                </caption>
                              )}
                              <thead>
                                <tr className="bg-muted/30 border-b border-border/35">
                                  {block.header.map((head, hIdx) => (
                                    <th
                                      key={hIdx}
                                      className="px-3 py-2 text-left font-semibold text-foreground"
                                    >
                                      {head}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {block.rows.map((row, rIdx) => (
                                  <tr
                                    key={rIdx}
                                    className="border-b border-border/35 last:border-b-0"
                                  >
                                    {row.map((cell, cIdx) => (
                                      <td
                                        key={cIdx}
                                        className={cn(
                                          'px-3 py-2 text-foreground/90',
                                          isNumericTableCell(cell) &&
                                            'font-mono tabular-nums',
                                        )}
                                      >
                                        {cell}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );

                      case 'callout':
                        return (
                          <div
                            key={blockKey}
                            data-testid={`handout-callout-${block.kind}`}
                            className="rounded-lg border border-border/35 bg-muted/20 p-4 flex flex-col gap-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                              <span className="text-xs font-semibold text-primary">
                                {calloutLabels[block.kind]}
                              </span>
                              <span className="text-xs font-semibold text-foreground">
                                {block.title}
                              </span>
                            </div>
                            <p className="text-sm text-foreground/90 leading-relaxed">
                              {block.text}
                            </p>
                          </div>
                        );

                      case 'formula':
                        return (
                          <div
                            key={blockKey}
                            data-testid="handout-formula-block"
                            className="rounded-lg border border-border/35 bg-muted/15 px-4 py-3 flex flex-col gap-1.5"
                          >
                            <div className="flex items-center justify-between gap-4 overflow-x-auto">
                              <code className="font-mono tabular-nums text-sm text-foreground">
                                {block.latex}
                              </code>
                              {block.label && (
                                <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                                  ({block.label})
                                </span>
                              )}
                            </div>
                            {block.explanation && (
                              <p className="text-xs text-muted-foreground border-t border-border/35 pt-1.5">
                                {t('learningHub:handoutReader.derivationPrefix', {
                                  defaultValue: '推导注记：',
                                })}
                                {block.explanation}
                              </p>
                            )}
                          </div>
                        );

                      case 'diagram': {
                        const safeSvg = sanitizeHandoutSvg(block.svg);
                        return (
                          <figure
                            key={blockKey}
                            data-testid="handout-diagram-block"
                            className="rounded-lg border border-border/35 bg-muted/10 p-4 flex flex-col items-center gap-2"
                          >
                            <div
                              className="max-w-full overflow-x-auto"
                              dangerouslySetInnerHTML={{ __html: safeSvg }}
                            />
                            {block.caption && (
                              <figcaption className="text-xs text-muted-foreground">
                                {t('learningHub:handoutReader.diagramPrefix', {
                                  defaultValue: '图示：',
                                })}
                                {block.caption}
                              </figcaption>
                            )}
                          </figure>
                        );
                      }

                      case 'figure': {
                        const figureAnchorKey = `figure:${blockKey}`;
                        const isFigureJustSeeked = justSeekedKey === figureAnchorKey;
                        const figureTimeLabel = formatAnchorClock(block.ts);
                        return (
                          <figure
                            key={blockKey}
                            className="rounded-lg border border-border/35 bg-muted/10 p-3 text-center"
                          >
                            <figcaption className="text-xs text-muted-foreground inline-flex flex-wrap items-center justify-center gap-1.5">
                              <span>
                                {t('learningHub:handoutReader.figurePrefix', {
                                  defaultValue: '配图（时间锚点',
                                })}{' '}
                                {onSeekTimestamp ? (
                                  <DsButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleSeekAnchor(figureAnchorKey, block.ts)}
                                    data-testid={`handout-seek-figure-${blockKey}`}
                                    aria-label={t('learningHub:handoutReader.jumpToTime', {
                                      time: figureTimeLabel,
                                      defaultValue: '跳转至 {{time}}',
                                    })}
                                    className={cn(
                                      'inline-flex !h-auto gap-1 !px-1.5 !py-0.5 text-2xs font-mono tabular-nums rounded border active:scale-95 motion-reduce:transition-none motion-reduce:transform-none',
                                      isFigureJustSeeked
                                        ? 'border-success/40 bg-success/15 text-success'
                                        : 'border-border/35 bg-background text-primary hover:bg-primary/10',
                                    )}
                                  >
                                    {isFigureJustSeeked ? (
                                      <Check className="w-2.5 h-2.5" aria-hidden="true" />
                                    ) : (
                                      <Play className="w-2.5 h-2.5" weight="fill" aria-hidden="true" />
                                    )}
                                    <span>{figureTimeLabel}</span>
                                  </DsButton>
                                ) : (
                                  <span className="font-mono tabular-nums">{block.ts}s</span>
                                )}
                                {t('learningHub:handoutReader.figureSuffix', {
                                  defaultValue: '）：',
                                })}
                                {block.caption ??
                                  t('learningHub:handoutReader.figureDefaultCaption', {
                                    defaultValue: '课堂板书截图',
                                  })}
                              </span>
                            </figcaption>
                          </figure>
                        );
                      }

                      case 'checkpoint': {
                        const userChoice = selectedAnswers[block.id];
                        const isAnswered = userChoice !== undefined;
                        const isCorrect = isAnswered && userChoice === block.answerIndex;

                        return (
                          <div
                            key={blockKey}
                            data-testid={`handout-checkpoint-${block.id}`}
                            className="rounded-lg border border-border/35 bg-card p-4 flex flex-col gap-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    'w-1.5 h-1.5 rounded-full transition-colors duration-150 motion-reduce:transition-none',
                                    !isAnswered
                                      ? 'bg-warning'
                                      : isCorrect
                                        ? 'bg-success'
                                        : 'bg-destructive',
                                  )}
                                />
                                <span className="text-xs font-semibold text-foreground">
                                  {t('learningHub:handoutReader.checkpointHeader', {
                                    defaultValue: '随堂自测与概念检验',
                                  })}
                                </span>
                              </div>
                              {isAnswered && (
                                <span
                                  className={cn(
                                    'text-xs font-medium px-2 py-0.5 rounded ui-fade-in motion-reduce:animate-none',
                                    isCorrect
                                      ? 'bg-success/15 text-success'
                                      : 'bg-destructive/15 text-destructive',
                                  )}
                                >
                                  {isCorrect
                                    ? t('learningHub:handoutReader.correct', {
                                        defaultValue: '回答正确',
                                      })
                                    : t('learningHub:handoutReader.wrong', {
                                        defaultValue: '回答错误',
                                      })}
                                </span>
                              )}
                            </div>

                            <p className="text-sm font-medium text-foreground">
                              {block.question}
                            </p>

                            <div className="grid grid-cols-1 gap-2">
                              {block.options.map((option, optIdx) => {
                                const optionLetter = String.fromCharCode(65 + optIdx);
                                const isSelected = userChoice === optIdx;
                                const isRightOption = optIdx === block.answerIndex;

                                return (
                                  <DsButton
                                    key={optIdx}
                                    variant="ghost"
                                    size="sm"
                                    aria-pressed={isSelected}
                                    onClick={() =>
                                      handleSelectCheckpointOption(block.id, optIdx, id)
                                    }
                                    className={cn(
                                      '!h-auto !w-full !justify-between !whitespace-normal !px-3 !py-2 rounded-md border text-left text-xs font-normal active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none',
                                      !isAnswered &&
                                        'border-border/35 bg-background text-foreground hover:bg-muted/50',
                                      isAnswered &&
                                        isRightOption &&
                                        'border-border/35 bg-success/15 text-foreground font-medium hover:bg-success/20',
                                      isAnswered &&
                                        isSelected &&
                                        !isRightOption &&
                                        'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive',
                                      isAnswered &&
                                        !isSelected &&
                                        !isRightOption &&
                                        'border-border/35 bg-background/50 text-muted-foreground hover:bg-muted/30',
                                    )}
                                  >
                                    <span className="flex items-center gap-2">
                                      <span className="font-mono tabular-nums font-semibold">
                                        {optionLetter}.
                                      </span>
                                      <span>{option}</span>
                                    </span>
                                    {isAnswered && isRightOption && (
                                      <span className="text-2xs text-success shrink-0">
                                        {t('learningHub:handoutReader.correctOptionBadge', {
                                          defaultValue: '正确答案',
                                        })}
                                      </span>
                                    )}
                                  </DsButton>
                                );
                              })}
                            </div>

                            {isAnswered && (
                              <div
                                data-testid={`checkpoint-explanation-${block.id}`}
                                className="mt-1 pt-2.5 border-t border-border/35 text-xs text-muted-foreground leading-relaxed ui-rise-in motion-reduce:animate-none"
                              >
                                <span className="font-semibold text-foreground">
                                  {t('learningHub:handoutReader.explanationPrefix', {
                                    defaultValue: '答案解析：',
                                  })}
                                </span>
                                {block.explanation}
                              </div>
                            )}
                          </div>
                        );
                      }
                    }
                  })}
                </div>
              </section>
            );
          })}
        </main>
      </div>
    </div>
  );
};

export default HandoutReaderView;
