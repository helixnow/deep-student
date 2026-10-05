/**
 * 学习页伴随分区：讲义 / 问答 / 练习（字幕分区由 MediaStudyView 自带）。
 * 全部复用既有能力：讲义 = useGenerateHandout + 来源回链笔记；问答 / 出题 = 新对话 +
 * 媒体引用 + 课程学习技能（mediaChat.ts）；制卡 = CardForge 直接制卡（mediaCards.ts，
 * 对话里定制作为次要入口）；本课台账 = media_study_ledger；进度 = media_progress_get。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CardsThree,
  ChatCircleText,
  CircleNotch,
  ClockCounterClockwise,
  ListChecks,
  Notebook,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useGenerateHandout, openHandoutNote } from '@/features/media-handout';
import { useReferenceToChat } from '@/features/learning-hub/useReferenceToChat';
import {
  mediaTranscriptApi,
  type MediaPlaybackProgress,
} from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import type { MediaStudyCompanionRenderContext } from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';
import type { TranscriptSegment } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import { buildMediaRefMarker } from '@/features/learning-hub/apps/views/media/mediaRefTime';
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

export const MediaHandoutTab: React.FC<{ ctx: MediaStudyCompanionRenderContext; visible: boolean }> = ({ ctx, visible }) => {
  const { t, i18n } = useTranslation(['mediaStudio', 'learningHub']);
  const { running, progress, result, start, cancel } = useGenerateHandout({
    resourceId: ctx.resourceId,
    kind: ctx.kind,
    src: ctx.src,
    fileName: ctx.fileName,
  });
  const [notes, setNotes] = useState<MediaRelatedNote[] | null>(null);

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

  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
  const now = Date.now();

  return (
    <TabScroll>
      <div className={sectionClass}>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('mediaStudio:handout.intro')}</p>
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
            onClick={start}
            disabled={!ctx.hasTranscript}
            data-media-handout-generate=""
            className="gap-1.5 self-start"
          >
            <Notebook size={14} aria-hidden="true" />
            {t('learningHub:mediaHandout.generate')}
          </DsButton>
        )}
        {!ctx.hasTranscript && !running ? (
          <p className="text-xs text-muted-foreground">{t('learningHub:mediaHandout.needTranscript')}</p>
        ) : null}
      </div>

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

export const MediaAskTab: React.FC<{ ctx: MediaStudyCompanionRenderContext; meta: MediaTabMeta }> = ({ ctx, meta }) => {
  const { t } = useTranslation(['mediaStudio']);
  const { starting, start } = useStartChat(meta, ctx.resourceId);
  const name = meta.name.replace(/\.[^.]+$/, '') || meta.name;

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
        <p className="text-xs text-muted-foreground/80">{t('mediaStudio:ask.citationHint')}</p>
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
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] px-3 py-2.5 text-xs">
          <dt className="text-muted-foreground">{t('mediaStudio:progress.watched')}</dt>
          <dd className="tabular-nums text-foreground">
            {minutes > 0 ? t('mediaStudio:progress.minutes', { count: minutes }) : t('mediaStudio:progress.notStarted')}
          </dd>
          <dt className="text-muted-foreground">{t('mediaStudio:progress.position')}</dt>
          <dd className="tabular-nums text-foreground">
            {playback?.finished
              ? t('mediaStudio:progress.finished')
              : position
                ? duration ? `${position} / ${duration}` : position
                : '—'}
          </dd>
          <dt className="text-muted-foreground">{t('mediaStudio:progress.transcript')}</dt>
          <dd className="tabular-nums text-foreground">
            {ctx.doneSegments > 0
              ? t('mediaStudio:progress.segments', { done: ctx.doneSegments, total: Math.max(ctx.totalSegments, ctx.doneSegments) })
              : t('mediaStudio:status.none')}
          </dd>
        </dl>
      </div>
    </TabScroll>
  );
};
