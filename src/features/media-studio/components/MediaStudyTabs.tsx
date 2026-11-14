/**
 * 学习页伴随分区：讲义 / 问答 / 练习（字幕分区由 MediaStudyView 自带）。
 * 全部复用既有能力：讲义 = useGenerateHandout + 来源回链笔记；问答 / 出题 = 新对话 +
 * 媒体引用 + 课程学习技能（mediaChat.ts）；制卡 = CardForge 直接制卡（mediaCards.ts，
 * 对话里定制作为次要入口）；本课台账 = media_study_ledger；进度 = media_progress_get。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CardsThree,
  ChatCircleText,
  Check,
  CircleNotch,
  ClockCounterClockwise,
  ListChecks,
  Notebook,
  Sparkle,
  Target,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useGenerateHandout, openHandoutNote } from '@/features/media-handout';
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
import {
  ContextualMiniChat,
  type MiniChatContextAnchor,
} from '@/features/chat';
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

export interface MediaTabMeta {
  name: string;
  mimeType?: string;
  size?: number;
}

const sectionClass = 'flex flex-col gap-2 px-3 py-3';
const sectionTitleClass = 'text-xs font-medium text-muted-foreground';
const actionButtonClass = 'w-full !justify-start gap-2';

/** 分区滚动容器：手机为单手拇指区留出底部安全区 */
const TabScroll: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CustomScrollArea
    className="min-h-0 flex-1"
    viewportClassName="pb-[calc(0.75rem+var(--mobile-safe-area-bottom,0px))]"
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

// ============================================================================
// 讲义
// ============================================================================

/** 根据当前媒体课程的标题、章节列表与字幕片段构建结构化 HandoutDocument */
export function buildMediaHandoutDocument(
  ctx: Pick<MediaStudyCompanionRenderContext, 'fileName' | 'chapters' | 'segments'>,
): HandoutDocument {
  const cleanTitle = ctx.fileName.replace(/\.[^.]+$/, '') || ctx.fileName || '课程精读讲义';
  const doneSegments = ctx.segments.filter((seg) => seg.status === 'done' && seg.text.trim());

  const sections: HandoutSection[] =
    ctx.chapters.length > 0
      ? ctx.chapters.map((chapter, index) => {
          const nextChapterSeconds = ctx.chapters[index + 1]?.seconds ?? Number.POSITIVE_INFINITY;
          const chapterSegments = doneSegments.filter(
            (seg) => seg.startMs >= chapter.seconds * 1000 && seg.startMs < nextChapterSeconds * 1000,
          );
          const effectiveSegments = chapterSegments.length > 0 ? chapterSegments : doneSegments.slice(0, 3);
          const summaryText =
            effectiveSegments.map((seg) => seg.text.trim()).join(' ') ||
            `本节围绕「${chapter.title}」展开核心概念与关键推导梳理。`;
          const keyPointText =
            effectiveSegments[0]?.text.trim() || `掌握「${chapter.title}」的核心定义、推导脉络与适用边界。`;

          const blocks: HandoutContentBlock[] = [
            {
              type: 'lead',
              text: `时间锚点 ${formatMediaRefTimestamp(chapter.seconds)} · ${chapter.title}`,
            },
            {
              type: 'para',
              text: summaryText,
            },
            {
              type: 'callout',
              kind: index % 2 === 0 ? 'theorem' : 'definition',
              title: `${chapter.title} · 重点提炼`,
              text: keyPointText,
            },
            {
              type: 'checkpoint',
              id: `media-cp-${index + 1}`,
              question: `关于「${chapter.title}」，下列哪项最符合本节课程的核心要点？`,
              options: [
                keyPointText,
                '仅凭直觉忽略前置假设与推导边界条件',
                '跳过时间锚点对应的关键步骤直接套用结论',
              ],
              answerIndex: 0,
              explanation: `本节在 ${formatMediaRefTimestamp(chapter.seconds)} 处重点阐述了「${chapter.title}」：${keyPointText}`,
            },
          ];

          return {
            id: `media-sec-${index + 1}`,
            heading: chapter.title,
            difficulty: index === 0 ? 'foundation' : index === ctx.chapters.length - 1 ? 'olympiad' : 'intermediate',
            estimatedMinutes: 5,
            blocks,
          };
        })
      : [
          {
            id: 'media-sec-1',
            heading: `${cleanTitle} · 核心精要`,
            difficulty: 'foundation',
            estimatedMinutes: 6,
            blocks: [
              {
                type: 'lead',
                text: `${cleanTitle} 课程全文核心脉络导读`,
              },
              {
                type: 'para',
                text:
                  doneSegments.map((seg) => seg.text.trim()).join(' ') ||
                  `${cleanTitle} 的核心概念、推导过程与重点归纳。`,
              },
              {
                type: 'callout',
                kind: 'definition',
                title: `${cleanTitle} · 核心要点`,
                text: doneSegments[0]?.text.trim() || `梳理「${cleanTitle}」的关键定义与知识框架。`,
              },
              {
                type: 'checkpoint',
                id: 'media-cp-1',
                question: `关于「${cleanTitle}」，下列哪项准确概括了本课的核心内容？`,
                options: [
                  doneSegments[0]?.text.trim() || `掌握「${cleanTitle}」的核心定义与推导方法`,
                  '忽略课程核心推导逻辑与边界条件',
                  '无需结合上下文直接跳过概念辨析',
                ],
                answerIndex: 0,
                explanation: `结合课程转写内容，应重点掌握：${doneSegments[0]?.text.trim() || cleanTitle}`,
              },
            ],
          },
        ];

  return {
    title: `${cleanTitle} · 精读讲义`,
    courseName: cleanTitle,
    summary: `共 ${sections.length} 个核心章节，融合课堂时间锚点摘要、重点提炼与随堂自测。`,
    estimatedMinutes: sections.length * 5,
    difficulty: 'intermediate',
    sections,
  };
}

export const MediaHandoutTab: React.FC<{ ctx: MediaStudyCompanionRenderContext; visible: boolean }> = ({ ctx, visible }) => {
  const { t, i18n } = useTranslation(['mediaStudio', 'learningHub']);
  const { running, progress, result, start: generate, cancel } = useGenerateHandout({
    resourceId: ctx.resourceId,
    kind: ctx.kind,
    src: ctx.src,
    fileName: ctx.fileName,
  });
  const [notes, setNotes] = useState<MediaRelatedNote[] | null>(null);
  const [showInlineReader, setShowInlineReader] = useState(false);

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

  const canShowInlineReader =
    ctx.chapters.length > 0 || Boolean(result) || Boolean(notes && notes.length > 0);

  const handoutDoc = useMemo(
    () => buildMediaHandoutDocument(ctx),
    [ctx.fileName, ctx.chapters, ctx.segments],
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
      '正在生成讲义笔记，完成后将自动关联至本课讲义列表',
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
              className="gap-1.5 self-start"
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
              className="gap-1.5 self-start border border-border/35"
            >
              <Notebook size={14} aria-hidden="true" />
              <span>{showInlineReader ? '收起内联讲义阅读器' : '内联讲义阅读器'}</span>
            </DsButton>
          ) : null}
        </div>
        {!ctx.hasTranscript && !running ? (
          <p className="text-xs text-muted-foreground">{t('learningHub:mediaHandout.needTranscript')}</p>
        ) : null}
      </div>

      {canShowInlineReader && showInlineReader ? (
        <div className={sectionClass}>
          <HandoutReaderView
            document={handoutDoc}
            onSaveToNote={handleOpenOrSaveHandoutNote}
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
              return (
                <li key={`${chapter.seconds}-${index}`}>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => ctx.seekTo(chapter.seconds)}
                    aria-current={current ? 'true' : undefined}
                    className={cn(
                      '!h-auto w-full !justify-start gap-2.5 !py-1.5 text-left',
                      current && 'bg-primary/10',
                    )}
                  >
                    <span className={cn('shrink-0 font-mono text-xs tabular-nums', current ? 'text-primary' : 'text-muted-foreground')}>
                      {formatMediaRefTimestamp(chapter.seconds)}
                    </span>
                    <span className={cn('min-w-0 flex-1 whitespace-normal text-sm', passed ? 'text-muted-foreground' : 'text-foreground')}>
                      {chapter.title}
                    </span>
                    {passed ? <Check size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
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

const ASK_PROMPTS = ['summary', 'keyPoints'] as const;
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

/** 结合当前播放时间点、匹配章节与邻近字幕窗口生成即时伴读速答摘要 */
export function buildMiniChatCompanionReply(
  ctx: Pick<
    MediaStudyCompanionRenderContext,
    'resourceId' | 'chapters' | 'segments' | 'getCurrentTime' | 'hasTranscript'
  >,
  courseName: string,
  payload: {
    text: string;
    anchor: MiniChatContextAnchor | null;
    presetId?: string;
  },
): string {
  const nowSeconds = Math.max(0, Math.floor(ctx.getCurrentTime()));
  const timeLabel = formatMediaRefTimestamp(nowSeconds);
  const chapIdx = chapterIndexAt(ctx.chapters, nowSeconds);
  const chapterTitle = chapIdx >= 0 ? ctx.chapters[chapIdx]?.title ?? null : null;
  const headerContext = chapterTitle
    ? `当前时间点 ${timeLabel}（章节：${chapterTitle}）`
    : `当前时间点 ${timeLabel}（${courseName}）`;

  const doneSegments = ctx.segments.filter(
    (seg) => seg.status === 'done' && seg.text.trim().length > 0,
  );
  if (!ctx.hasTranscript || doneSegments.length === 0) {
    return `${headerContext}尚无可用字幕转写。请先在「字幕」分区完成课程转写以获取基于原话的即时速答，或点击右上角「迁入主会话」携带时间锚点发起完整提问。`;
  }

  const fromMs = Math.max(0, nowSeconds - MINI_CHAT_WINDOW_RADIUS_SECONDS) * 1000;
  const toMs = (nowSeconds + MINI_CHAT_WINDOW_RADIUS_SECONDS) * 1000 + 1;
  const nearbySegments = segmentsInWindow(ctx.segments, fromMs, toMs);

  if (nearbySegments.length === 0) {
    const centerMs = nowSeconds * 1000;
    const nearest = [...doneSegments].sort((a, b) => {
      const distA = Math.min(Math.abs(a.startMs - centerMs), Math.abs(a.endMs - centerMs));
      const distB = Math.min(Math.abs(b.startMs - centerMs), Math.abs(b.endMs - centerMs));
      return distA - distB;
    })[0];
    const nearestHint = nearest
      ? `最近相关原话位于 [${formatMediaRefTimestamp(Math.floor(nearest.startMs / 1000))}]：「${nearest.text.trim()}」。`
      : '';
    return `${headerContext}前后 ${MINI_CHAT_WINDOW_RADIUS_SECONDS} 秒内暂无课程对白。${nearestHint}可定位到对应讲解片段后重试，或点击右上角「迁入主会话」发起完整深度追问。`;
  }

  const excerptLines = nearbySegments
    .slice(0, 4)
    .map(
      (seg) =>
        `[${formatMediaRefTimestamp(Math.floor(seg.startMs / 1000))}] ${seg.text.trim()}`,
    )
    .join('；');

  let focusLead = '结合当前时间窗内的课程原话要点梳理：';
  if (payload.presetId === 'explain_paragraph') {
    focusLead = '围绕当前段落原话的核心概念梳理：';
  } else if (payload.presetId === 'derive_formula') {
    focusLead = '结合当前时刻讲解的推导脉络梳理：';
  } else if (payload.presetId === 'generate_variant') {
    focusLead = '紧扣当前时间点考查要点的迁移提示：';
  }

  return `${headerContext} · ${focusLead}${excerptLines}。如需展开完整公式推导、变式演练或多轮深入探讨，可点击右上角「迁入主会话」发起完整深度追问。`;
}

export const MediaAskTab: React.FC<{
  ctx: MediaStudyCompanionRenderContext;
  meta: MediaTabMeta;
  visible?: boolean;
}> = ({ ctx, meta, visible }) => {
  const { t } = useTranslation(['mediaStudio']);
  const companion = useMediaStudyCompanion();
  const isVisible = visible ?? (companion ? companion.activeTab === 'ask' : true);
  const { starting, start } = useStartChat(meta, ctx.resourceId);
  const name = meta.name.replace(/\.[^.]+$/, '') || meta.name;
  const [playheadSeconds, setPlayheadSeconds] = useState<number>(() =>
    Math.max(0, Math.floor(ctx.getCurrentTime())),
  );

  useEffect(() => {
    setPlayheadSeconds(Math.max(0, Math.floor(ctx.getCurrentTime())));
    if (!isVisible) return;
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

  const handleMiniChatAsk = useCallback(
    (payload: {
      text: string;
      anchor: MiniChatContextAnchor | null;
      presetId?: string;
    }) => {
      const latestSeconds = Math.max(0, Math.floor(ctx.getCurrentTime()));
      setPlayheadSeconds((prev) => (prev === latestSeconds ? prev : latestSeconds));
      return buildMiniChatCompanionReply(ctx, name, payload);
    },
    [ctx, name],
  );

  return (
    <TabScroll>
      <div className={sectionClass}>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('mediaStudio:ask.intro')}</p>
        <DsButton
          variant="primary"
          size="sm"
          onClick={() => void start('ask')}
          disabled={starting !== null}
          data-media-ask=""
          className="gap-1.5 self-start"
        >
          {starting === 'ask'
            ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <ChatCircleText size={14} aria-hidden="true" />}
          {t('mediaStudio:ask.start')}
        </DsButton>
        {!ctx.hasTranscript ? (
          <p className="text-xs text-muted-foreground">{t('mediaStudio:ask.needTranscript')}</p>
        ) : null}
      </div>
      <div className={sectionClass}>
        <h4 className={sectionTitleClass}>{t('mediaStudio:ask.quickTitle')}</h4>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => void start('moment', buildRecentMomentPrompt(ctx, name, t))}
          disabled={starting !== null}
          data-media-ask-moment=""
          className={cn(actionButtonClass, 'study-shell-secondary-card !h-auto !py-2 text-left')}
        >
          {starting === 'moment'
            ? <CircleNotch size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <ClockCounterClockwise size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="whitespace-normal text-sm text-foreground">{t('mediaStudio:ask.quick.moment')}</span>
            <span className="whitespace-normal text-xs text-muted-foreground">{t('mediaStudio:ask.quick.momentHint')}</span>
          </span>
        </DsButton>
        {ASK_PROMPTS.map((key) => (
          <DsButton
            key={key}
            variant="ghost"
            size="sm"
            onClick={() => void start(key, t(`mediaStudio:ask.prompt.${key}`, { name }))}
            disabled={starting !== null}
            className={cn(actionButtonClass, 'study-shell-secondary-card !h-auto !py-2 text-left')}
          >
            {starting === key
              ? <CircleNotch size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Sparkle size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="min-w-0 flex-1 whitespace-normal text-sm text-foreground">{t(`mediaStudio:ask.quick.${key}`)}</span>
          </DsButton>
        ))}
        {/* 「时间引用可点击跳转」已在顶部 ask.intro 说明，这里不再重复一遍 */}
      </div>
      <div className={sectionClass}>
        <ContextualMiniChat
          anchor={miniChatAnchor}
          defaultMinimized={false}
          className="max-w-none"
          onSendMessage={handleMiniChatAsk}
          onPromoteToMainChat={({ messages, anchor }) => {
            const lastUserMsg =
              [...messages].reverse().find((m) => m.role === 'user') ?? messages[messages.length - 1];
            const effectiveRef = anchor?.referenceId ?? miniChatAnchor.referenceId;
            const promptOrLastQuestion = lastUserMsg
              ? `${effectiveRef} ${lastUserMsg.content}`
              : buildRecentMomentPrompt(ctx, name, t);
            void start('mini-chat-promote', promptOrLastQuestion);
          }}
        />
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
