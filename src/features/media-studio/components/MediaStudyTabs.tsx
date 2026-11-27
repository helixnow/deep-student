/**
 * 学习页伴随分区：讲义 / 问答 / 练习（字幕分区由 MediaStudyView 自带）。
 * 全部复用既有能力：讲义 = useGenerateHandout + 来源回链笔记；问答 / 出题 = 新对话 +
 * 媒体引用 + 课程学习技能（mediaChat.ts）；制卡 = CardForge 直接制卡（mediaCards.ts，
 * 对话里定制作为次要入口）；本课台账 = media_study_ledger；进度 = media_progress_get。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CardsThree,
  ChatCircleText,
  Check,
  CircleNotch,
  ListChecks,
  Notebook,
  Target,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useGenerateHandout, openHandoutNote } from '@/features/media-handout';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import {
  HandoutReaderView,
  chapterIndexAt,
  useMediaStudyCompanion,
  type HandoutContentBlock,
  type HandoutDocument,
  type HandoutReaderViewProps,
  type HandoutSection,
  type MediaStudyCompanionRenderContext,
} from '@/features/learning-hub';
import type { MiniChatContextAnchor } from '@/features/chat';
import { useReferenceToChat } from '@/features/learning-hub/useReferenceToChat';
import {
  mediaTranscriptApi,
  type MediaPlaybackProgress,
  type TranscriptSegment,
} from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import { buildMediaRefMarker, formatMediaRefTimestamp } from '@/features/learning-hub/apps/views/media/mediaRefTime';
import { makeMediaCards } from '@/features/learning-hub/apps/views/media/mediaCards';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import {
  buildTranscriptQuote,
  RECENT_MOMENT_WINDOW_SECONDS,
  segmentsInWindow,
} from '@/features/learning-hub/apps/views/media/transcriptExcerpt';
import {
  ledgerAccuracy,
  mediaStudioApi,
  type MediaRelatedNote,
  type MediaStudyLedger,
} from '../api';
import { formatDuration, formatRelativeTime, watchedMinutes } from '../libraryModel';
import { startMediaChat } from '../mediaChat';
import {
  askMediaCompanionQa,
  cancelCompanionQaRequest,
  openMediaAiModelSettings,
  type CompanionQaTurn,
} from '../mediaCompanionQa';
import { MediaCompanionQaCard } from './MediaCompanionQaCard';

export interface MediaTabMeta {
  name: string;
  mimeType?: string;
  size?: number;
}

const sectionClass = 'flex flex-col gap-2 px-3 py-3';
const sectionTitleClass = 'text-xs font-medium text-muted-foreground';
const actionButtonClass = 'w-full !justify-start gap-2';

/** 分区滚动容器：手机为单手拇指区与底部程序坞留出安全避让 */
const TabScroll: React.FC<{
  children: React.ReactNode;
  nativeScrollbars?: boolean;
  viewportRef?: React.Ref<HTMLDivElement>;
}> = ({ children, nativeScrollbars, viewportRef }) => (
  <CustomScrollArea
    className="min-h-0 flex-1"
    nativeScrollbars={nativeScrollbars}
    viewportRef={viewportRef}
    viewportClassName="pb-[calc(0.75rem+var(--mobile-safe-area-bottom,env(safe-area-inset-bottom,0px))+var(--wb-mobile-dock-clearance,var(--mobile-dock-height,var(--wb-dock-clearance,0px))))]"
  >
    {children}
  </CustomScrollArea>
);

function useStartChat(meta: MediaTabMeta, resourceId: string) {
  const { t } = useTranslation(['mediaStudio']);
  const { referenceToChat } = useReferenceToChat();
  const [starting, setStarting] = useState<string | null>(null);
  const start = useCallback(async (key: string, prompt?: string) => {
    if (starting) return;
    setStarting(key);
    try {
      await startMediaChat({
        resourceId,
        name: meta.name,
        mimeType: meta.mimeType,
        size: meta.size,
        prompt,
        referenceToChat,
      });
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('mediaStudio:ask.failed'));
    } finally {
      setStarting(null);
    }
  }, [meta.mimeType, meta.name, meta.size, referenceToChat, resourceId, starting, t]);
  return { starting, start };
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function interpolateFallback(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, k: string) => {
    const val = vars[k];
    return val === undefined || val === null ? match : String(val);
  });
}

function resolveText(
  t: TranslateFn | undefined,
  key: string,
  defaultValue: string,
  vars?: Record<string, unknown>,
): string {
  if (!t) return interpolateFallback(defaultValue, vars);
  return t(key, { defaultValue, ...vars });
}

const CHAPTER_SEEK_FEEDBACK_MS = 1200;

// ============================================================================
// 讲义
// ============================================================================

function parseClockSeconds(clock: string): number {
  const parts = clock.split(':').map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/** 将 AI 讲义生成的 Markdown 笔记还原为结构化 HandoutDocument（保留多章节、时间锚点与正文块） */
export function parseHandoutMarkdownToDocument(
  markdown: string,
  courseName: string,
): HandoutDocument | null {
  const trimmed = markdown.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  let docTitle = courseName;
  const summaryLines: string[] = [];
  const sections: HandoutSection[] = [];
  let current: HandoutSection | null = null;
  let pendingList: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (pendingList && current && pendingList.items.length > 0) {
      current.blocks.push({ type: 'list', ordered: pendingList.ordered, items: pendingList.items });
    }
    pendingList = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith('# ') && !current) {
      docTitle = line.slice(2).trim() || courseName;
      continue;
    }
    if (line.startsWith('## ')) {
      flushList();
      if (current) sections.push(current);
      const rawHeading = line.slice(3).trim();
      const dedupedHeading = rawHeading.replace(/^(?:[一二三四五六七八九十百]+[、.．:：]\s*)+/, '').trim();
      current = {
        heading: dedupedHeading || rawHeading || courseName,
        blocks: [],
      };
      continue;
    }
    if (!current) {
      summaryLines.push(line);
      continue;
    }
    const anchorMatch = /^\[媒体@[^:\]]+:(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.*)$/.exec(line);
    if (anchorMatch) {
      flushList();
      if (current.anchorSeconds == null) {
        current.anchorSeconds = parseClockSeconds(anchorMatch[1]);
      }
      if (anchorMatch[2]?.trim()) {
        current.blocks.push({ type: 'para', text: anchorMatch[2].trim() });
      }
      continue;
    }
    if (line.startsWith('### ')) {
      flushList();
      current.blocks.push({ type: 'h2', text: line.slice(4).trim() });
      continue;
    }
    if (line.startsWith('> ')) {
      flushList();
      current.blocks.push({ type: 'note', text: line.slice(2).trim() });
      continue;
    }
    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      if (!pendingList || pendingList.ordered) {
        flushList();
        pendingList = { ordered: false, items: [] };
      }
      pendingList.items.push(bulletMatch[1].trim());
      continue;
    }
    const orderedMatch = /^\d+\.\s+(.+)$/.exec(line);
    if (orderedMatch) {
      if (!pendingList || !pendingList.ordered) {
        flushList();
        pendingList = { ordered: true, items: [] };
      }
      pendingList.items.push(orderedMatch[1].trim());
      continue;
    }
    flushList();
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line)) continue;
    if (line.startsWith('|')) continue;
    current.blocks.push({ type: 'para', text: line });
  }
  flushList();
  if (current) sections.push(current);
  if (sections.length === 0) return null;

  return {
    title: docTitle,
    courseName,
    summary: summaryLines.join(' ').trim() || docTitle,
    estimatedMinutes: sections.length * 5,
    difficulty: 'intermediate',
    sections,
  };
}

/** 根据当前媒体课程的标题、章节列表与字幕片段构建结构化 HandoutDocument */
export function buildMediaHandoutDocument(
  ctx: Pick<MediaStudyCompanionRenderContext, 'fileName' | 'chapters' | 'segments'>,
  t?: TranslateFn,
): HandoutDocument {
  const defaultTitle = resolveText(t, 'mediaStudio:handout.defaultCourseTitle', '课程精读讲义');
  const cleanTitle = ctx.fileName.replace(/\.[^.]+$/, '') || ctx.fileName || defaultTitle;
  const doneSegments = ctx.segments.filter((seg) => seg.status === 'done' && seg.text.trim());

  const sections: HandoutSection[] =
    ctx.chapters.length > 0
      ? ctx.chapters.map((chapter, index) => {
          const nextChapterSeconds = ctx.chapters[index + 1]?.seconds ?? Number.POSITIVE_INFINITY;
          const chapterSegments = doneSegments.filter(
            (seg) => seg.startMs >= chapter.seconds * 1000 && seg.startMs < nextChapterSeconds * 1000,
          );
          const effectiveSegments = chapterSegments.length > 0 ? chapterSegments : doneSegments.slice(0, 3);
          const timeStr = formatMediaRefTimestamp(chapter.seconds);
          const summaryText =
            effectiveSegments.map((seg) => seg.text.trim()).join(' ') ||
            resolveText(
              t,
              'mediaStudio:handout.chapterSummaryFallback',
              '本节围绕「{{title}}」展开核心概念与关键推导梳理。',
              { title: chapter.title },
            );
          const keyPointText =
            effectiveSegments[0]?.text.trim() ||
            resolveText(
              t,
              'mediaStudio:handout.chapterKeyPointFallback',
              '掌握「{{title}}」的核心定义、推导脉络与适用边界。',
              { title: chapter.title },
            );

          const blocks: HandoutContentBlock[] = [
            {
              type: 'lead',
              text: resolveText(
                t,
                'mediaStudio:handout.chapterLead',
                '时间锚点 {{time}} · {{title}}',
                { time: timeStr, title: chapter.title },
              ),
            },
            {
              type: 'para',
              text: summaryText,
            },
            {
              type: 'callout',
              kind: index % 2 === 0 ? 'theorem' : 'definition',
              title: resolveText(
                t,
                'mediaStudio:handout.chapterCalloutTitle',
                '{{title}} · 重点提炼',
                { title: chapter.title },
              ),
              text: keyPointText,
            },
            {
              type: 'checkpoint',
              id: `media-cp-${index + 1}`,
              question: resolveText(
                t,
                'mediaStudio:handout.chapterQuestion',
                '关于「{{title}}」，下列哪项最符合本节课程的核心要点？',
                { title: chapter.title },
              ),
              options: [
                keyPointText,
                resolveText(
                  t,
                  'mediaStudio:handout.chapterDistractor1',
                  '仅凭直觉忽略前置假设与推导边界条件',
                ),
                resolveText(
                  t,
                  'mediaStudio:handout.chapterDistractor2',
                  '跳过时间锚点对应的关键步骤直接套用结论',
                ),
              ],
              answerIndex: 0,
              explanation: resolveText(
                t,
                'mediaStudio:handout.chapterExplanation',
                '本节在 {{time}} 处重点阐述了「{{title}}」：{{point}}',
                { time: timeStr, title: chapter.title, point: keyPointText },
              ),
            },
          ];

          return {
            id: `media-sec-${index + 1}`,
            heading: chapter.title,
            difficulty: index === 0 ? 'foundation' : index === ctx.chapters.length - 1 ? 'olympiad' : 'intermediate',
            estimatedMinutes: 5,
            anchorSeconds: chapter.seconds,
            blocks,
          };
        })
      : [
          {
            id: 'media-sec-1',
            heading: resolveText(
              t,
              'mediaStudio:handout.singleHeading',
              '{{title}} · 核心精要',
              { title: cleanTitle },
            ),
            difficulty: 'foundation',
            estimatedMinutes: 6,
            blocks: [
              {
                type: 'lead',
                text: resolveText(
                  t,
                  'mediaStudio:handout.singleLead',
                  '{{title}} 课程全文核心脉络导读',
                  { title: cleanTitle },
                ),
              },
              {
                type: 'para',
                text:
                  doneSegments.map((seg) => seg.text.trim()).join(' ') ||
                  resolveText(
                    t,
                    'mediaStudio:handout.singleSummaryFallback',
                    '{{title}} 的核心概念、推导过程与重点归纳。',
                    { title: cleanTitle },
                  ),
              },
              {
                type: 'callout',
                kind: 'definition',
                title: resolveText(
                  t,
                  'mediaStudio:handout.singleCalloutTitle',
                  '{{title}} · 核心要点',
                  { title: cleanTitle },
                ),
                text:
                  doneSegments[0]?.text.trim() ||
                  resolveText(
                    t,
                    'mediaStudio:handout.singleKeyPointFallback',
                    '梳理「{{title}}」的关键定义与知识框架。',
                    { title: cleanTitle },
                  ),
              },
              {
                type: 'checkpoint',
                id: 'media-cp-1',
                question: resolveText(
                  t,
                  'mediaStudio:handout.singleQuestion',
                  '关于「{{title}}」，下列哪项准确概括了本课的核心内容？',
                  { title: cleanTitle },
                ),
                options: [
                  doneSegments[0]?.text.trim() ||
                    resolveText(
                      t,
                      'mediaStudio:handout.singleOptionFallback',
                      '掌握「{{title}}」的核心定义与推导方法',
                      { title: cleanTitle },
                    ),
                  resolveText(
                    t,
                    'mediaStudio:handout.singleDistractor1',
                    '忽略课程核心推导逻辑与边界条件',
                  ),
                  resolveText(
                    t,
                    'mediaStudio:handout.singleDistractor2',
                    '无需结合上下文直接跳过概念辨析',
                  ),
                ],
                answerIndex: 0,
                explanation: resolveText(
                  t,
                  'mediaStudio:handout.singleExplanation',
                  '结合课程转写内容，应重点掌握：{{point}}',
                  { point: doneSegments[0]?.text.trim() || cleanTitle },
                ),
              },
            ],
          },
        ];

  return {
    title: resolveText(t, 'mediaStudio:handout.docTitle', '{{title}} · 精读讲义', {
      title: cleanTitle,
    }),
    courseName: cleanTitle,
    summary: resolveText(
      t,
      'mediaStudio:handout.docSummary',
      '共 {{count}} 个核心章节，融合课堂时间锚点摘要、重点提炼与随堂自测。',
      { count: sections.length },
    ),
    estimatedMinutes: sections.length * 5,
    difficulty: 'intermediate',
    sections,
  };
}

export const MediaHandoutTab: React.FC<{ ctx: MediaStudyCompanionRenderContext; visible: boolean }> = ({ ctx, visible }) => {
  const { t, i18n } = useTranslation(['mediaStudio', 'learningHub']);
  const { running, progress, result, error: handoutError, start: generate, cancel } = useGenerateHandout({
    resourceId: ctx.resourceId,
    kind: ctx.kind,
    src: ctx.src,
    fileName: ctx.fileName,
  });
  const [notes, setNotes] = useState<MediaRelatedNote[] | null>(null);
  const [noteHandoutDoc, setNoteHandoutDoc] = useState<HandoutDocument | null>(null);
  const [showInlineReader, setShowInlineReader] = useState(false);
  const [justSeekedIndex, setJustSeekedIndex] = useState<number | null>(null);
  const seekTimerRef = useRef<number | null>(null);
  const autoOpenedNoteIdRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
  }, []);

  const load = useCallback(async () => {
    try {
      setNotes(await mediaStudioApi.relatedNotes(ctx.resourceId));
    } catch {
      setNotes((prev) => prev ?? []);
    }
  }, [ctx.resourceId]);

  // 分区可见时 / 新讲义生成后刷新
  useEffect(() => {
    if (visible) void load();
  }, [visible, load, result]);

  const justSeekedTimerRef = seekTimerRef;
  void justSeekedTimerRef;
  const wasGeneratingHandoutRef = useRef(running);

  // 仅在主动生成讲义结束并产出新笔记时自动展开内联讲义阅读器
  useEffect(() => {
    if (running) {
      wasGeneratingHandoutRef.current = true;
      return;
    }
    if (wasGeneratingHandoutRef.current && result?.noteId && result.noteId !== autoOpenedNoteIdRef.current) {
      autoOpenedNoteIdRef.current = result.noteId;
      wasGeneratingHandoutRef.current = false;
      setShowInlineReader(true);
    } else if (!result) {
      wasGeneratingHandoutRef.current = false;
    }
  }, [running, result]);

  const activeHandoutNoteId = result?.noteId ?? notes?.[0]?.id ?? null;
  const { fileName, chapters, segments } = ctx;
  const cleanCourseTitle = fileName.replace(/\.[^.]+$/, '') || fileName;

  useEffect(() => {
    if (!visible || !activeHandoutNoteId) {
      setNoteHandoutDoc(null);
      return;
    }
    let cancelled = false;
    void notesDstuAdapter
      .getNoteContent(activeHandoutNoteId)
      .then((res) => {
        if (cancelled) return;
        if (res?.ok && res.value) {
          setNoteHandoutDoc(parseHandoutMarkdownToDocument(res.value, cleanCourseTitle));
        } else {
          setNoteHandoutDoc(null);
        }
      })
      .catch(() => {
        if (!cancelled) setNoteHandoutDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, activeHandoutNoteId, cleanCourseTitle]);

  const canShowInlineReader =
    ctx.chapters.length > 0 || Boolean(result) || Boolean(notes && notes.length > 0);

  const fallbackHandoutDoc = useMemo(
    () => buildMediaHandoutDocument({ fileName, chapters, segments }, t),
    [chapters, fileName, segments, t],
  );
  const handoutDoc = noteHandoutDoc ?? fallbackHandoutDoc;

  const handleChapterSeek = useCallback(
    (index: number, seconds: number) => {
      ctx.seekTo(seconds);
      setJustSeekedIndex(index);
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = window.setTimeout(() => {
        setJustSeekedIndex((prev) => (prev === index ? null : prev));
        seekTimerRef.current = null;
      }, CHAPTER_SEEK_FEEDBACK_MS);
    },
    [ctx],
  );

  const handleOpenOrSaveHandoutNote = useCallback<
    NonNullable<HandoutReaderViewProps['onSaveToNote']>
  >(() => {
    const targetNoteId = result?.noteId ?? notes?.[0]?.id;
    if (targetNoteId) {
      openHandoutNote(targetNoteId);
      return true;
    }
    if (!ctx.hasTranscript) {
      showGlobalNotification('info', t('learningHub:mediaHandout.needTranscript'));
      return false;
    }
    if (!running) {
      void generate();
    }
    showGlobalNotification(
      'info',
      t('mediaStudio:handout.generatingAutoLink', {
        defaultValue: '正在生成讲义笔记，完成后将自动关联至本课讲义列表',
      }),
    );
    return false;
  }, [ctx.hasTranscript, generate, notes, result, running, t]);

  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
  const now = Date.now();

  return (
    <TabScroll>
      <div className={sectionClass}>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('mediaStudio:handout.intro')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <div className="study-shell-secondary-card flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
              <CircleNotch size={14} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t(`learningHub:mediaHandout.phase.${progress?.phase ?? 'transcript'}`)}
                {progress && progress.total > 1 ? ` ${progress.done}/${progress.total}` : ''}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                onClick={cancel}
                aria-label={t('learningHub:mediaHandout.cancel')}
                title={t('learningHub:mediaHandout.cancel')}
                className="!h-7 !w-7 shrink-0"
              >
                <X size={13} aria-hidden="true" />
              </DsButton>
            </div>
          ) : (
            <DsButton
              variant="primary"
              size="sm"
              onClick={generate}
              disabled={!ctx.hasTranscript}
              data-media-handout-generate=""
              className="gap-1.5 self-start !border-primary/35 !bg-primary/10 !text-primary hover:!bg-primary/15 hover:!text-primary"
            >
              <Notebook size={14} aria-hidden="true" />
              {t('learningHub:mediaHandout.generate')}
            </DsButton>
          )}
          {canShowInlineReader ? (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setShowInlineReader((prev) => !prev)}
              aria-expanded={showInlineReader}
              data-testid="toggle-inline-handout-reader"
              className="gap-1.5 self-start border border-border/35 active:scale-[0.98] motion-reduce:transition-none motion-reduce:transform-none"
            >
              <Notebook size={14} aria-hidden="true" />
              <span>
                {showInlineReader
                  ? t('mediaStudio:handout.inlineReaderClose', {
                      defaultValue: '收起内联讲义阅读器',
                    })
                  : t('mediaStudio:handout.inlineReaderOpen', {
                      defaultValue: '内联讲义阅读器',
                    })}
              </span>
            </DsButton>
          ) : null}
        </div>
        {!ctx.hasTranscript && !running ? (
          <p className="text-xs text-muted-foreground">{t('learningHub:mediaHandout.needTranscript')}</p>
        ) : null}
        {handoutError && !running ? (
          <div
            role="alert"
            data-media-handout-error=""
            className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 leading-relaxed break-words">{handoutError}</span>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={generate}
              className="!h-7 shrink-0 px-2 text-xs !text-destructive hover:!bg-destructive/10"
            >
              {t('common:retry', { defaultValue: '重试' })}
            </DsButton>
          </div>
        ) : null}
      </div>

      {canShowInlineReader && showInlineReader ? (
        <div className={cn(sectionClass, 'ui-rise-in motion-reduce:animate-none')}>
          <HandoutReaderView
            document={handoutDoc}
            onSaveToNote={handleOpenOrSaveHandoutNote}
            onSeekTimestamp={ctx.seekTo}
          />
        </div>
      ) : null}

      {ctx.chapters.length > 0 ? (
        <div className={sectionClass} data-media-chapters="">
          <h4 className={sectionTitleClass}>
            {t('mediaStudio:chapters.title', { current: Math.max(0, ctx.currentChapterIndex + 1), total: ctx.chapters.length })}
          </h4>
          <ol className="flex flex-col gap-0.5">
            {ctx.chapters.map((chapter, index) => {
              const current = index === ctx.currentChapterIndex;
              const passed = index < ctx.currentChapterIndex;
              const justSeeked = index === justSeekedIndex;
              return (
                <li key={`${chapter.seconds}-${index}`}>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleChapterSeek(index, chapter.seconds)}
                    aria-current={current ? 'true' : undefined}
                    data-seek-active={justSeeked ? 'true' : undefined}
                    className={cn(
                      '!h-auto w-full !justify-start gap-2.5 !py-1.5 text-left active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none',
                      justSeeked
                        ? 'bg-success/10 ring-1 ring-inset ring-success/30'
                        : current && 'bg-primary/10',
                    )}
                  >
                    <span
                      className={cn(
                        'shrink-0 font-mono text-xs tabular-nums transition-colors duration-150 motion-reduce:transition-none',
                        justSeeked
                          ? 'text-success'
                          : current
                            ? 'text-primary'
                            : 'text-muted-foreground',
                      )}
                    >
                      {formatMediaRefTimestamp(chapter.seconds)}
                    </span>
                    <span className={cn('min-w-0 flex-1 whitespace-normal text-sm', passed && !justSeeked ? 'text-muted-foreground' : 'text-foreground')}>
                      {chapter.title}
                    </span>
                    {justSeeked ? (
                      <span
                        data-testid={`media-chapter-seek-feedback-${index}`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-2xs font-medium text-success ui-fade-in motion-reduce:animate-none"
                      >
                        <Check size={11} aria-hidden="true" />
                        <span>{t('mediaStudio:chapters.jumped', { defaultValue: '已定位' })}</span>
                      </span>
                    ) : passed ? (
                      <Check size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : null}
                  </DsButton>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className={sectionClass}>
        <h4 className={sectionTitleClass}>{t('mediaStudio:handout.listTitle')}</h4>
        {notes === null ? (
          <CircleNotch size={16} className="mx-auto my-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label={t('common:loading')} />
        ) : notes.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{t('mediaStudio:handout.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {notes.map((note) => (
              <li key={note.id}>
                <DsButton
                  variant="ghost"
                  onClick={() => openHandoutNote(note.id)}
                  className="study-shell-secondary-card !h-auto w-full !justify-start gap-2.5 !px-3 !py-2 text-left"
                >
                  <Notebook size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{note.title || t('mediaStudio:handout.untitled')}</span>
                    {note.updatedAt > 0 ? (
                      <span className="text-xs text-muted-foreground">{formatRelativeTime(note.updatedAt, now, locale)}</span>
                    ) : null}
                  </span>
                </DsButton>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground/80">{t('mediaStudio:handout.wordHint')}</p>
      </div>
    </TabScroll>
  );
};

// ============================================================================
// 问答
// ============================================================================

export const MINI_CHAT_WINDOW_RADIUS_SECONDS = 45;

/** 「问刚才这段」：播放位置前 1 分钟的字幕连同锚点预填进新对话；还没字幕时只带锚点让模型按时间读转写 */
export function buildRecentMomentPrompt(
  ctx: Pick<MediaStudyCompanionRenderContext, 'resourceId' | 'segments' | 'getCurrentTime'>,
  name: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const now = Math.max(0, ctx.getCurrentTime());
  const from = Math.max(0, now - RECENT_MOMENT_WINDOW_SECONDS);
  const quote = buildTranscriptQuote(ctx.resourceId, segmentsInWindow(ctx.segments, from * 1000, now * 1000 + 1));
  return quote
    ? t('mediaStudio:ask.prompt.moment', { name, ref: quote.marker, quote: quote.quote })
    : t('mediaStudio:ask.prompt.momentNoTranscript', { name, ref: buildMediaRefMarker(ctx.resourceId, from) });
}

export const MediaAskTab: React.FC<{
  ctx: MediaStudyCompanionRenderContext;
  meta: MediaTabMeta;
  visible?: boolean;
}> = ({ ctx, meta, visible }) => {
  const { t } = useTranslation(['mediaStudio']);
  const companion = useMediaStudyCompanion();
  const isVisible = visible ?? (companion ? companion.activeTab === 'ask' : true);
  const { start } = useStartChat(meta, ctx.resourceId);
  const name = meta.name.replace(/\.[^.]+$/, '') || meta.name;
  const [playheadSeconds, setPlayheadSeconds] = useState<number>(() =>
    Math.max(0, Math.floor(ctx.getCurrentTime())),
  );
  const askScrollViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPlayheadSeconds(Math.max(0, Math.floor(ctx.getCurrentTime())));
    if (!isVisible) return;
    if (askScrollViewportRef.current) {
      askScrollViewportRef.current.scrollTop = 0;
    }
    const timer = window.setInterval(() => {
      const nextSeconds = Math.max(0, Math.floor(ctx.getCurrentTime()));
      setPlayheadSeconds((prev) => (prev === nextSeconds ? prev : nextSeconds));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ctx, isVisible]);

  const activeChapterIdx = useMemo(
    () => chapterIndexAt(ctx.chapters, playheadSeconds),
    [ctx.chapters, playheadSeconds],
  );
  const activeChapterTitle =
    activeChapterIdx >= 0 ? ctx.chapters[activeChapterIdx]?.title ?? null : null;

  const miniChatAnchor = useMemo<MiniChatContextAnchor>(
    () => ({
      kind: 'video_timestamp',
      label: activeChapterTitle
        ? `${formatMediaRefTimestamp(playheadSeconds)} · ${name} · ${activeChapterTitle}`
        : `${formatMediaRefTimestamp(playheadSeconds)} · ${name}`,
      referenceId: buildMediaRefMarker(ctx.resourceId, playheadSeconds),
    }),
    [activeChapterTitle, ctx.resourceId, name, playheadSeconds],
  );

  const handleCompanionAsk = useCallback(
    async (payload: {
      text: string;
      anchor: MiniChatContextAnchor | null;
      presetId?: string;
      history: CompanionQaTurn[];
      requestId: string;
    }) => {
      const latestSeconds = Math.max(0, Math.floor(ctx.getCurrentTime()));
      setPlayheadSeconds((prev) => (prev === latestSeconds ? prev : latestSeconds));
      return askMediaCompanionQa({
        ctx: {
          resourceId: ctx.resourceId,
          courseName: name,
          hasTranscript: ctx.hasTranscript,
          segments: ctx.segments,
          chapters: ctx.chapters,
          currentTimeSeconds: latestSeconds,
        },
        question: payload.text,
        history: payload.history,
        presetId: payload.presetId,
        requestId: payload.requestId,
      });
    },
    [ctx, name],
  );

  const handleCancelCompanionAsk = useCallback((requestId: string) => {
    void cancelCompanionQaRequest(requestId);
  }, []);

  const handleOpenSettings = useCallback(() => {
    openMediaAiModelSettings('apis');
  }, []);

  return (
    <TabScroll nativeScrollbars viewportRef={askScrollViewportRef}>
      <div
        data-media-ask-composer-host=""
        className="flex flex-col gap-2 px-3 py-2 sm:py-3"
      >
        <MediaCompanionQaCard
          anchor={miniChatAnchor}
          defaultMinimized={false}
          expandSignal={isVisible}
          className="max-w-none"
          onAskQuestion={handleCompanionAsk}
          onCancelRequest={handleCancelCompanionAsk}
          onSeekTimestamp={ctx.seekTo}
          onOpenSettings={handleOpenSettings}
          onPromoteToMainChat={({ messages, anchor }) => {
            const firstAnchoredMsg = messages.find((m) => m.anchor?.referenceId);
            const effectiveRef =
              firstAnchoredMsg?.anchor?.referenceId ??
              anchor?.referenceId ??
              miniChatAnchor.referenceId;
            const conversationLines = messages
              .filter((m) => m.content.trim().length > 0)
              .map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content.trim()}`);
            const promptOrConversation =
              conversationLines.length > 0
                ? `${effectiveRef}\n${conversationLines.join('\n\n')}`
                : buildRecentMomentPrompt(ctx, name, t);
            void start('mini-chat-promote', promptOrConversation);
          }}
        />
        {!ctx.hasTranscript ? (
          <p className="px-1 text-xs text-muted-foreground">{t('mediaStudio:ask.needTranscript')}</p>
        ) : null}
      </div>
    </TabScroll>
  );
};

// ============================================================================
// 练习 + 进度
// ============================================================================

/** 整节课直接制卡的张数：约每 10 分钟 6 张，6–40 张 */
export function lectureCardBudget(segments: readonly TranscriptSegment[]): number {
  const done = segments.filter((seg) => seg.status === 'done' && seg.text.trim());
  if (done.length === 0) return 0;
  const spanMs = Math.max(...done.map((seg) => seg.endMs)) - Math.min(...done.map((seg) => seg.startMs));
  return Math.min(40, Math.max(6, Math.round((spanMs / 600_000) * 6)));
}

/** 「复习本课卡片」：与聊天制卡块同一入口（已开窗 activate，未开窗 fallbackLaunch） */
function reviewLectureCards(cardIds: string[]): void {
  if (cardIds.length === 0) return;
  const payload = { screen: 'session' as const, mode: 'batch' as const, cardIds };
  void workbenchBus.activate({
    typeId: 'flashcards',
    instanceKey: '',
    action: 'startReview',
    payload,
    fallbackLaunch: { typeId: 'flashcards', reason: 'api', payload },
  });
}

export const MediaPracticeTab: React.FC<{ ctx: MediaStudyCompanionRenderContext; meta: MediaTabMeta; visible: boolean }> = ({
  ctx,
  meta,
  visible,
}) => {
  const { t } = useTranslation(['mediaStudio', 'learningHub']);
  const { starting, start } = useStartChat(meta, ctx.resourceId);
  const [playback, setPlayback] = useState<MediaPlaybackProgress | null>(null);
  const [ledger, setLedger] = useState<MediaStudyLedger | null>(null);
  const [makingCards, setMakingCards] = useState(false);
  const name = meta.name.replace(/\.[^.]+$/, '') || meta.name;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void mediaTranscriptApi.getProgress(ctx.resourceId)
      .then((value) => { if (!cancelled) setPlayback(value); })
      .catch(() => undefined);
    void mediaStudioApi.studyLedger([ctx.resourceId], true)
      .then(([value]) => { if (!cancelled) setLedger(value ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [ctx.resourceId, visible]);

  // 整节课直接制卡：不开聊天，CardForge 后台任务（任务台跟踪），来源记为该媒体
  const makeCards = useCallback(async () => {
    if (makingCards) return;
    setMakingCards(true);
    try {
      await makeMediaCards({
        resourceId: ctx.resourceId,
        fileName: meta.name,
        segments: ctx.segments,
        maxCards: lectureCardBudget(ctx.segments),
        t,
      });
    } finally {
      setMakingCards(false);
    }
  }, [ctx.resourceId, ctx.segments, makingCards, meta.name, t]);

  const duration = formatDuration(playback?.durationMs ?? null);
  const position = formatDuration(playback?.lastPositionMs ?? null);
  const minutes = watchedMinutes(playback?.watchedMs);
  const accuracy = ledger ? ledgerAccuracy(ledger) : null;
  const busy = starting !== null || makingCards;

  return (
    <TabScroll>
      <div className={sectionClass}>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('mediaStudio:practice.intro')}</p>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => void makeCards()}
          disabled={busy || !ctx.hasTranscript}
          data-media-practice="cards"
          className={cn(actionButtonClass, 'study-shell-secondary-card !h-auto !py-2.5 text-left')}
        >
          {makingCards
            ? <CircleNotch size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <CardsThree size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">{t('mediaStudio:practice.cards')}</span>
            <span className="whitespace-normal text-xs text-muted-foreground">{t('mediaStudio:practice.cardsHint')}</span>
          </span>
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => void start('questions', t('mediaStudio:practice.prompt.questions', { name }))}
          disabled={busy || !ctx.hasTranscript}
          data-media-practice="questions"
          className={cn(actionButtonClass, 'study-shell-secondary-card !h-auto !py-2.5 text-left')}
        >
          {starting === 'questions'
            ? <CircleNotch size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <ListChecks size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">{t('mediaStudio:practice.questions')}</span>
            <span className="whitespace-normal text-xs text-muted-foreground">{t('mediaStudio:practice.questionsHint')}</span>
          </span>
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => void start('checkpoints', t('mediaStudio:practice.prompt.checkpoints', { name, id: ctx.resourceId }))}
          disabled={busy || !ctx.hasTranscript}
          data-media-practice="checkpoints"
          className={cn(actionButtonClass, 'study-shell-secondary-card !h-auto !py-2.5 text-left')}
        >
          {starting === 'checkpoints'
            ? <CircleNotch size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <Target size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">{t('mediaStudio:practice.checkpoints')}</span>
            <span className="whitespace-normal text-xs text-muted-foreground">{t('mediaStudio:practice.checkpointsHint')}</span>
          </span>
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => void start('cardsChat', t('mediaStudio:practice.prompt.cards', { name }))}
          disabled={busy || !ctx.hasTranscript}
          data-media-practice="cards-chat"
          className="self-start gap-1.5 text-xs text-muted-foreground"
        >
          {starting === 'cardsChat'
            ? <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <ChatCircleText size={13} aria-hidden="true" />}
          {t('mediaStudio:practice.cardsInChat')}
        </DsButton>
        {!ctx.hasTranscript ? (
          <p className="text-xs text-muted-foreground">{t('mediaStudio:practice.needTranscript')}</p>
        ) : null}
      </div>

      <div className={sectionClass} data-media-ledger="">
        <h4 className={sectionTitleClass}>{t('mediaStudio:ledger.title')}</h4>
        {ledger && (ledger.cardCount > 0 || ledger.questionCount > 0) ? (
          <div className="flex flex-col gap-1.5">
            <div className="study-shell-secondary-card flex items-center gap-2.5 px-3 py-2">
              <CardsThree size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm text-foreground">{t('mediaStudio:ledger.cards', { count: ledger.cardCount })}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('mediaStudio:ledger.cardsDetail', { due: ledger.cardsDue, fresh: ledger.cardsNew })}
                </span>
              </span>
              <DsButton
                variant={ledger.cardsDue > 0 ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => reviewLectureCards(ledger.cardIds)}
                disabled={ledger.cardIds.length === 0}
                data-media-ledger-review=""
                className="shrink-0"
              >
                {t('mediaStudio:ledger.reviewCards')}
              </DsButton>
            </div>
            <div className="study-shell-secondary-card flex items-center gap-2.5 px-3 py-2">
              <ListChecks size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm text-foreground">{t('mediaStudio:ledger.questions', { count: ledger.questionCount })}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {accuracy === null
                    ? t('mediaStudio:ledger.questionsUntried')
                    : t('mediaStudio:ledger.questionsDetail', { accuracy, wrong: ledger.questionsWrong })}
                </span>
              </span>
              <DsButton
                variant={ledger.questionsWrong > 0 ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => {
                  const examId = ledger.examIds[0];
                  if (examId) dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_EXAM_SHEET, { sessionId: examId });
                }}
                disabled={ledger.examIds.length === 0}
                data-media-ledger-practice=""
                className="shrink-0"
              >
                {t('mediaStudio:ledger.practice')}
              </DsButton>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('mediaStudio:ledger.empty')}</p>
        )}
      </div>

      <div className={sectionClass} data-media-progress="">
        <h4 className={sectionTitleClass}>{t('mediaStudio:progress.title')}</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-border/35 bg-foreground/[0.02] px-3.5 py-2.5 text-xs">
          <dt className="text-muted-foreground">{t('mediaStudio:progress.watched')}</dt>
          <dd className="font-mono tabular-nums text-foreground">
            {minutes > 0 ? t('mediaStudio:progress.minutes', { count: minutes }) : t('mediaStudio:progress.notStarted')}
          </dd>
          <dt className="text-muted-foreground">{t('mediaStudio:progress.position')}</dt>
          <dd className="font-mono tabular-nums text-foreground">
            {playback?.finished
              ? t('mediaStudio:progress.finished')
              : position
                ? duration ? `${position} / ${duration}` : position
                : '—'}
          </dd>
          <dt className="text-muted-foreground">{t('mediaStudio:progress.transcript')}</dt>
          <dd className="font-mono tabular-nums text-foreground">
            {ctx.doneSegments > 0
              ? t('mediaStudio:progress.segments', { done: ctx.doneSegments, total: Math.max(ctx.totalSegments, ctx.doneSegments) })
              : t('mediaStudio:status.none')}
          </dd>
        </dl>
      </div>
    </TabScroll>
  );
};
