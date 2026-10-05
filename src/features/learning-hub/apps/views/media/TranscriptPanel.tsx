/**
 * TranscriptPanel — 字幕面板（搜索 / 点击跳转 / 跟随高亮 / 复制 / 选段引用与制卡）
 *
 * - 桌面宽布局为播放器右侧侧栏，窄布局（手机 / 聊天右侧窄面板）在播放器下方。
 * - 跟随：当前段变化时把它滚入列表视口；用户手动滚动后 4s 内不抢滚动，
 *   「定位到当前播放」按钮可随时回到当前段。搜索时停止跟随。
 * - 选段：宿主提供 onQuoteSelection / onMakeCardsFromSelection 时可进入选择模式，
 *   点行勾选（Shift 连选），底部操作条把选中段引用到对话或制卡（同 PDF 划词闭环）。
 * - 行组件 memo 化：播放中只有新旧两个高亮行重渲染。
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  CardsThree,
  ChatCircleText,
  CheckSquare,
  Copy,
  Crosshair,
  ListChecks,
  MagnifyingGlass,
  Square,
  X,
  CircleNotch,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type {
  TranscriptProgress,
  TranscriptSegment,
  TranscriptStatus,
} from './mediaTranscriptApi';
import { formatTranscriptClock } from './mediaRefTime';

/** 手动滚动后暂停自动跟随的时长 */
export const FOLLOW_PAUSE_AFTER_USER_SCROLL_MS = 4000;

const STAGE_KEYS = new Set(['decode', 'vad', 'asr', 'indexing', 'pending']);

/** 面板展示的段：已完成且有文本 + 失败段（占位提示）；待转写段不展示 */
export function selectDisplaySegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter(
    (seg) => seg.status === 'failed' || (seg.status === 'done' && seg.text.trim().length > 0),
  );
}

export function filterSegments(
  segments: readonly TranscriptSegment[],
  query: string,
): TranscriptSegment[] {
  const q = query.trim().toLowerCase();
  if (!q) return segments as TranscriptSegment[];
  return segments.filter((seg) => seg.status === 'done' && seg.text.toLowerCase().includes(q));
}

/** 复制格式：每行 `[mm:ss] 文本`（与引用时间格式一致，便于粘贴后再引用） */
export function formatTranscriptForCopy(segments: readonly TranscriptSegment[]): string {
  return segments
    .filter((seg) => seg.status === 'done' && seg.text.trim())
    .map((seg) => `[${formatTranscriptClock(seg.startMs)}] ${seg.text.trim()}`)
    .join('\n');
}

function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let hit = lower.indexOf(needle, from);
  while (hit >= 0) {
    if (hit > from) parts.push(text.slice(from, hit));
    parts.push(
      <mark key={hit} className="rounded-sm bg-warning/30 text-foreground">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    from = hit + needle.length;
    hit = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

interface RowProps {
  seg: TranscriptSegment;
  active: boolean;
  query: string;
  onSeek: (seg: TranscriptSegment) => void;
  onCopy: (seg: TranscriptSegment) => void;
  registerRow: (idx: number, el: HTMLElement | null) => void;
  /** 选择模式：点行勾选而非跳转 */
  selecting: boolean;
  selected: boolean;
  onToggle: (seg: TranscriptSegment, range: boolean) => void;
}

const TranscriptRow = memo(function TranscriptRow({
  seg,
  active,
  query,
  onSeek,
  onCopy,
  registerRow,
  selecting,
  selected,
  onToggle,
}: RowProps) {
  const { t } = useTranslation(['learningHub']);
  const time = formatTranscriptClock(seg.startMs);
  const failed = seg.status === 'failed';
  const selectable = selecting && !failed;
  return (
    <li
      ref={(el) => registerRow(seg.idx, el)}
      className="group/row relative"
      data-segment-idx={seg.idx}
    >
      <button
        type="button"
        onClick={(event) => {
          if (selecting) {
            if (selectable) onToggle(seg, event.shiftKey);
            return;
          }
          onSeek(seg);
        }}
        disabled={selecting && !selectable}
        aria-current={active ? 'true' : undefined}
        aria-pressed={selectable ? selected : undefined}
        aria-label={`${selecting
          ? t('learningHub:mediaTranscript.selectSegment', { time })
          : t('learningHub:mediaTranscript.seekTo', { time })}: ${failed ? t('learningHub:mediaTranscript.segmentFailed') : seg.text}`}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left',
          '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-2.5',
          'transition-colors duration-150 motion-reduce:transition-none',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          selectable && selected
            ? 'bg-primary/10'
            : active && !selecting ? 'bg-primary/10' : 'hover:bg-[var(--interactive-hover)]',
          selecting && !selectable && 'opacity-50',
        )}
      >
        {selecting ? (
          selected
            ? <CheckSquare size={16} weight="fill" className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
            : <Square size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : null}
        <span
          className={cn(
            'mt-px shrink-0 font-mono text-[11px] tabular-nums leading-5',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {time}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 break-words pr-6 text-sm leading-5',
            failed ? 'italic text-muted-foreground' : active ? 'text-foreground' : 'text-foreground/85',
          )}
        >
          {failed ? t('learningHub:mediaTranscript.segmentFailed') : highlight(seg.text, query)}
        </span>
      </button>
      {!failed && !selecting && (
        <button
          type="button"
          onClick={() => onCopy(seg)}
          aria-label={t('learningHub:mediaTranscript.copySegment')}
          title={t('learningHub:mediaTranscript.copySegment')}
          className={cn(
            'absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground',
            'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100',
            'hover:bg-[var(--interactive-hover)] hover:text-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            '[@media(pointer:coarse)]:hidden',
          )}
        >
          <Copy size={13} aria-hidden="true" />
        </button>
      )}
    </li>
  );
});

export interface TranscriptPanelProps {
  segments: readonly TranscriptSegment[];
  /** 当前播放段的 idx（-1 = 无） */
  activeSegmentIdx: number;
  onSeek: (seg: TranscriptSegment) => void;
  status: TranscriptStatus;
  progress: TranscriptProgress | null;
  error?: string | null;
  onCancel?: () => void;
  cancelling?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  layout: 'side' | 'bottom';
  /** 宿主已有分区标题（音视频子应用分段面板）时隐藏「字幕」标题 */
  hideTitle?: boolean;
  /** 宿主容器自带分隔线时关闭面板自身的边框 */
  bordered?: boolean;
  className?: string;
  /** 选中段 → 引用到对话（按时间排序）；与 onMakeCardsFromSelection 任一提供即可进入选择模式 */
  onQuoteSelection?: (segments: TranscriptSegment[]) => void;
  /** 选中段 → 制卡 */
  onMakeCardsFromSelection?: (segments: TranscriptSegment[]) => void;
}

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  segments,
  activeSegmentIdx,
  onSeek,
  status,
  progress,
  error,
  onCancel,
  cancelling = false,
  onRetry,
  retrying = false,
  layout,
  hideTitle = false,
  bordered = true,
  className,
  onQuoteSelection,
  onMakeCardsFromSelection,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [query, setQuery] = useState('');
  const canSelect = Boolean(onQuoteSelection || onMakeCardsFromSelection);
  const [selecting, setSelecting] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<ReadonlySet<number>>(() => new Set());
  const rangeAnchorRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(new Map<number, HTMLElement>());
  const lastUserScrollAtRef = useRef(0);

  const displaySegments = useMemo(() => selectDisplaySegments(segments), [segments]);
  const visibleSegments = useMemo(
    () => filterSegments(displaySegments, query),
    [displaySegments, query],
  );
  const searching = query.trim().length > 0;
  const doneCount = useMemo(
    () => segments.filter((s) => s.status === 'done').length,
    [segments],
  );
  const unfinishedCount = segments.length - doneCount;

  const registerRow = useCallback((idx: number, el: HTMLElement | null) => {
    if (el) rowsRef.current.set(idx, el);
    else rowsRef.current.delete(idx);
  }, []);

  const scrollRowIntoView = useCallback((idx: number, force: boolean) => {
    const list = listRef.current;
    const row = rowsRef.current.get(idx);
    if (!list || !row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (!force && rowTop >= viewTop && rowBottom <= viewBottom) return;
    // 当前段放在视口上 1/3，保留下文可读
    list.scrollTop = Math.max(0, rowTop - list.clientHeight / 3);
  }, []);

  useEffect(() => {
    if (activeSegmentIdx < 0 || searching) return;
    if (Date.now() - lastUserScrollAtRef.current < FOLLOW_PAUSE_AFTER_USER_SCROLL_MS) return;
    scrollRowIntoView(activeSegmentIdx, false);
  }, [activeSegmentIdx, searching, scrollRowIntoView]);

  const markUserScroll = useCallback(() => {
    lastUserScrollAtRef.current = Date.now();
  }, []);

  const handleFollow = useCallback(() => {
    lastUserScrollAtRef.current = 0;
    if (searching) setQuery('');
    // 清空搜索后行需要先渲染出来
    window.requestAnimationFrame(() => scrollRowIntoView(activeSegmentIdx, true));
  }, [searching, activeSegmentIdx, scrollRowIntoView]);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyTextToClipboard(text);
      showGlobalNotification(
        ok ? 'success' : 'error',
        ok ? t('learningHub:mediaTranscript.copied') : t('learningHub:mediaTranscript.copyFailed'),
      );
    },
    [t],
  );

  const handleCopyAll = useCallback(() => {
    void copy(formatTranscriptForCopy(searching ? visibleSegments : displaySegments));
  }, [copy, searching, visibleSegments, displaySegments]);

  const handleCopySegment = useCallback(
    (seg: TranscriptSegment) => {
      void copy(`[${formatTranscriptClock(seg.startMs)}] ${seg.text.trim()}`);
    },
    [copy],
  );

  // ---------------------------------------------------------------- 选段
  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelectedIdx(new Set());
    rangeAnchorRef.current = null;
  }, []);

  const handleToggle = useCallback(
    (seg: TranscriptSegment, range: boolean) => {
      const anchor = rangeAnchorRef.current;
      setSelectedIdx((prev) => {
        const next = new Set(prev);
        if (range && anchor !== null) {
          const ids = visibleSegments.filter((s) => s.status === 'done').map((s) => s.idx);
          const from = ids.indexOf(anchor);
          const to = ids.indexOf(seg.idx);
          if (from >= 0 && to >= 0) {
            for (const idx of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(idx);
            return next;
          }
        }
        if (next.has(seg.idx)) next.delete(seg.idx);
        else next.add(seg.idx);
        return next;
      });
      rangeAnchorRef.current = seg.idx;
    },
    [visibleSegments],
  );

  const selectedSegments = useMemo(
    () => displaySegments
      .filter((seg) => selectedIdx.has(seg.idx) && seg.status === 'done')
      .sort((a, b) => a.startMs - b.startMs),
    [displaySegments, selectedIdx],
  );

  const runSelectionAction = useCallback(
    (action: ((segments: TranscriptSegment[]) => void) | undefined) => {
      if (!action || selectedSegments.length === 0) return;
      action(selectedSegments);
      exitSelecting();
    },
    [exitSelecting, selectedSegments],
  );

  const running = status === 'running' || status === 'queued';
  const stageKey = progress?.stage && STAGE_KEYS.has(progress.stage) ? progress.stage : 'unknown';
  const percent = progress
    ? Math.round(
        progress.totalSegments > 0
          ? (progress.completedSegments / progress.totalSegments) * 100
          : progress.percent,
      )
    : 0;

  return (
    <section
      aria-label={t('learningHub:mediaTranscript.panelTitle')}
      className={cn(
        'flex min-h-0 flex-col bg-background',
        bordered && (layout === 'side' ? 'border-l border-border' : 'border-t border-border'),
        className,
      )}
    >
      {/* 头部：标题 + 计数 + 复制 / 定位 */}
      <div className="flex h-10 shrink-0 items-center gap-1 px-3">
        {!hideTitle && (
          <h3 className="text-sm font-medium text-foreground">
            {t('learningHub:mediaTranscript.panelTitle')}
          </h3>
        )}
        <span className={cn('text-xs tabular-nums text-muted-foreground', !hideTitle && 'ml-1')}>
          {searching
            ? t('learningHub:mediaTranscript.searchResults', { count: visibleSegments.length })
            : t('learningHub:mediaTranscript.segmentCount', { count: displaySegments.length })}
        </span>
        <div className="flex-1" />
        {canSelect && (
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
            disabled={!selecting && doneCount === 0}
            aria-pressed={selecting}
            aria-label={selecting ? t('learningHub:mediaTranscript.selectDone') : t('learningHub:mediaTranscript.selectMode')}
            title={selecting ? t('learningHub:mediaTranscript.selectDone') : t('learningHub:mediaTranscript.selectMode')}
            data-transcript-select-toggle=""
            className={cn(
              'h-8 w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
              selecting && 'bg-primary/10 text-primary',
            )}
          >
            <ListChecks size={15} aria-hidden="true" />
          </DsButton>
        )}
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={handleFollow}
          disabled={activeSegmentIdx < 0}
          aria-label={t('learningHub:mediaTranscript.follow')}
          title={t('learningHub:mediaTranscript.follow')}
          className="h-8 w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <Crosshair size={15} aria-hidden="true" />
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={handleCopyAll}
          disabled={doneCount === 0}
          aria-label={t('learningHub:mediaTranscript.copyAll')}
          title={t('learningHub:mediaTranscript.copyAll')}
          className="h-8 w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <Copy size={15} aria-hidden="true" />
        </DsButton>
      </div>

      {/* 搜索 */}
      <div className="shrink-0 px-3 pb-2">
        <div className="relative flex items-center">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder={t('learningHub:mediaTranscript.searchPlaceholder')}
            aria-label={t('learningHub:mediaTranscript.searchLabel')}
            className={cn(
              'h-8 w-full rounded-md border border-border bg-background pl-8 pr-8 text-sm text-foreground',
              'placeholder:text-muted-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
              '[&::-webkit-search-cancel-button]:hidden',
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('learningHub:mediaTranscript.clearSearch')}
              className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* 状态条：进行中 / 部分完成 / 失败 */}
      {running && (
        <div className="shrink-0 border-y border-border/60 bg-muted/40 px-3 py-2" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CircleNotch size={13} className="animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            <span className="truncate">
              {status === 'queued' || progress?.stage === 'queued'
                ? t('learningHub:mediaTranscript.queued')
                : t(`learningHub:mediaTranscript.stage.${stageKey}`)}
            </span>
            {progress && progress.totalSegments > 0 && (
              <span className="tabular-nums">
                {t('learningHub:mediaTranscript.progressCount', {
                  completed: progress.completedSegments,
                  total: progress.totalSegments,
                })}
              </span>
            )}
            <div className="flex-1" />
            {onCancel && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={cancelling}
                className="h-7 px-2 text-xs [@media(pointer:coarse)]:!h-11"
              >
                {t('learningHub:mediaTranscript.cancel')}
              </DsButton>
            )}
          </div>
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('learningHub:mediaTranscript.running')}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}
      {!running && (status === 'partial' || status === 'failed') && (
        <div className="flex shrink-0 items-center gap-2 border-y border-border/60 bg-muted/40 px-3 py-2 text-xs" role="status">
          <span className={cn('min-w-0 flex-1', status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {status === 'failed'
              ? error || t('learningHub:mediaTranscript.failedHint')
              : t('learningHub:mediaTranscript.partialHint', { count: unfinishedCount })}
          </span>
          {onRetry && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={onRetry}
              disabled={retrying}
              className="h-7 shrink-0 px-2 text-xs [@media(pointer:coarse)]:!h-11"
            >
              <ArrowClockwise size={12} aria-hidden="true" />
              {t('learningHub:mediaTranscript.retryFailed')}
            </DsButton>
          )}
        </div>
      )}

      {/* 列表 */}
      <div
        ref={listRef}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1"
      >
        {visibleSegments.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {searching
              ? t('learningHub:mediaTranscript.noMatches')
              : running
                ? t('learningHub:mediaTranscript.emptyRunning')
                : null}
          </p>
        ) : (
          <ul aria-label={t('learningHub:mediaTranscript.listLabel')} className="space-y-0.5 pb-2">
            {visibleSegments.map((seg) => (
              <TranscriptRow
                key={seg.idx}
                seg={seg}
                active={seg.idx === activeSegmentIdx}
                query={query}
                onSeek={onSeek}
                onCopy={handleCopySegment}
                registerRow={registerRow}
                selecting={selecting}
                selected={selectedIdx.has(seg.idx)}
                onToggle={handleToggle}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 选段操作条 */}
      {selecting && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/60 bg-background px-3 py-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]"
          role="toolbar"
          aria-label={t('learningHub:mediaTranscript.selectionToolbar')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              exitSelecting();
            }
          }}
        >
          <span className="mr-auto text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {selectedSegments.length > 0
              ? t('learningHub:mediaTranscript.selectedCount', { count: selectedSegments.length })
              : t('learningHub:mediaTranscript.selectHint')}
          </span>
          {onQuoteSelection && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => runSelectionAction(onQuoteSelection)}
              disabled={selectedSegments.length === 0}
              className="gap-1.5"
            >
              <ChatCircleText size={14} aria-hidden="true" />
              {t('learningHub:mediaTranscript.quoteSelection')}
            </DsButton>
          )}
          {onMakeCardsFromSelection && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => runSelectionAction(onMakeCardsFromSelection)}
              disabled={selectedSegments.length === 0}
              className="gap-1.5"
            >
              <CardsThree size={14} aria-hidden="true" />
              {t('learningHub:mediaTranscript.cardsFromSelection')}
            </DsButton>
          )}
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={exitSelecting}
            aria-label={t('learningHub:mediaTranscript.selectDone')}
            title={t('learningHub:mediaTranscript.selectDone')}
          >
            <X size={14} aria-hidden="true" />
          </DsButton>
        </div>
      )}
    </section>
  );
};

export default TranscriptPanel;
