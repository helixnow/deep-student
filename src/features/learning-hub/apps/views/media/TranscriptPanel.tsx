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
  TextAa,
  X,
  CircleNotch,
  DotsSixVertical,
  TreeStructure,
  Cards,
  NotePencil,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import type { AnchorEdgeRecord, AnchorEdgeSourceKind } from '@/ui-kernel/contracts/interop';
import { DsButton } from '@/components/ui/DsButton';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type {
  TranscriptProgress,
  TranscriptSegment,
  TranscriptStatus,
} from './mediaTranscriptApi';
import { formatTranscriptClock } from './mediaRefTime';
import {
  backlinkCountParts,
  buildCueDragLabel,
  buildMediaExcerptPayload,
  buildMediaSemanticAnchor,
  CUE_PULSE_DURATION_MS,
  findCueIndexForMs,
  mediaAutoExcerptKey,
  setCompactCueDragImage,
  sharedMediaExcerptGuard,
  type AnchorBacklinkSummary,
} from './mediaInteropBridge';
import {
  enrichMediaExcerptWithKeyframe,
  type CueBranchTint,
} from './mediaKeyframeExcerpt';

/** 字幕区跨插件互操作上下文：拖拽引用 / 划选即入图的锚点资源 */
export interface TranscriptInteropOptions {
  /** 锚点主资源 id（VFS file_*） */
  resourceId: string;
  /** 别名资源 id（DSTU sourceId） */
  aliasResourceId?: string;
  /** 人类可读的音视频名（摘录来源标注） */
  mediaTitle?: string;
  /** 「划选即入图」：点选 / 划选字幕即送入当前导图或笔记 */
  autoExcerptActive?: boolean;
  /** 可选视频元素访问器：视频播放时自动附带当前关键帧缩略图 */
  getVideoElement?: () => HTMLVideoElement | null;
}

const SOURCE_ICON: Record<AnchorEdgeSourceKind, React.ElementType> = {
  mindmap: TreeStructure,
  flashcard: Cards,
  note: NotePencil,
  qbank: NotePencil,
};

const stopPropagation = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

/** 字幕段反向链接胶囊：`1 导图 · 2 闪卡`；单条直接回到引用方，多条展开列表 */
const CueBacklinkPill = memo(function CueBacklinkPill({ summary }: { summary: AnchorBacklinkSummary }) {
  const { t } = useTranslation(['mediaStudio']);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const parts = backlinkCountParts(summary);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const reveal = useCallback((edge: AnchorEdgeRecord) => {
    setOpen(false);
    void getAppKernel().anchors.reveal(edge.sourceAnchorUri, { splitIfClosed: true, pulse: true });
  }, []);

  if (parts.length === 0) return null;
  const countLabel = parts.map((part) => t(`mediaStudio:interop.backlink_${part.kind}`, { count: part.count })).join(' · ');

  return (
    <div ref={rootRef} className="relative" onPointerDown={stopPropagation} onMouseDown={stopPropagation} onMouseUp={stopPropagation} onDoubleClick={stopPropagation} onClick={stopPropagation}>
      <button
        type="button"
        data-testid="cue-backlink-pill"
        aria-expanded={summary.edges.length > 1 ? open : undefined}
        onClick={() => {
          if (summary.edges.length === 1) reveal(summary.edges[0]);
          else setOpen((prev) => !prev);
        }}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-card/90 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <span className="font-mono tabular-nums">{countLabel}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[180px] max-w-[260px] rounded-lg border border-border/35 bg-card p-1.5 text-xs shadow-sm">
          <ul>
            {summary.edges.map((edge, index) => {
              const Icon = SOURCE_ICON[edge.sourceKind] ?? NotePencil;
              return (
                <li key={edge.edgeId}>
                  {index > 0 && <div className="mx-1.5 h-px bg-border/35" aria-hidden="true" />}
                  <button
                    type="button"
                    onClick={() => reveal(edge)}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.04]"
                  >
                    <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{edge.sourceLabel || countLabel}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
});

/** 手动滚动后暂停自动跟随的时长 */
export const FOLLOW_PAUSE_AFTER_USER_SCROLL_MS = 4000;

export type TranscriptTextSize = 'sm' | 'base' | 'lg';
const TEXT_SIZES: readonly TranscriptTextSize[] = ['sm', 'base', 'lg'];
const TEXT_SIZE_CLASS: Record<TranscriptTextSize, string> = {
  sm: 'text-sm leading-5',
  base: 'text-base leading-6',
  lg: 'text-lg leading-7',
};
const TEXT_SIZE_KEY = 'media-study.transcriptTextSize';

function readTextSize(): TranscriptTextSize {
  try {
    const stored = window.localStorage.getItem(TEXT_SIZE_KEY);
    return TEXT_SIZES.includes(stored as TranscriptTextSize) ? (stored as TranscriptTextSize) : 'sm';
  } catch {
    return 'sm';
  }
}

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
  textSize: TranscriptTextSize;
  /** 提供时显示拖拽把手（拖入导图 / 笔记） */
  onExcerptDragStart?: (seg: TranscriptSegment, event: React.DragEvent<HTMLButtonElement>) => void;
  onExcerptDragEnd?: () => void;
  /** 定位脉冲（anchors.reveal 命中本段） */
  pulsed: boolean;
  backlinks?: AnchorBacklinkSummary;
  branchTint?: CueBranchTint;
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
  textSize,
  onExcerptDragStart,
  onExcerptDragEnd,
  pulsed,
  backlinks,
  branchTint,
}: RowProps) {
  const { t } = useTranslation(['learningHub', 'mediaStudio']);
  const time = formatTranscriptClock(seg.startMs);
  const failed = seg.status === 'failed';
  const selectable = selecting && !failed;
  return (
    <li
      ref={(el) => registerRow(seg.idx, el)}
      className={cn(
        'group/row relative rounded-lg transition-colors duration-300 motion-reduce:transition-none',
        pulsed && 'bg-primary/12 ring-1 ring-primary/30',
      )}
      style={!pulsed && branchTint ? { backgroundColor: branchTint.tintBackground } : undefined}
      data-segment-idx={seg.idx}
      data-cue-index={seg.idx}
      data-cue-pulse={pulsed ? 'true' : undefined}
      data-cue-branch-token={branchTint?.branchColorToken}
    >
      {branchTint && (
        <span
          aria-hidden="true"
          data-testid="cue-branch-tint"
          className="pointer-events-none absolute bottom-1.5 left-0.5 top-1.5 w-[2.5px] rounded-full"
          style={{ backgroundColor: branchTint.accentColor }}
        />
      )}
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
            ? 'bg-primary/[0.08]'
            : active && !selecting
              ? 'bg-primary/[0.07] text-foreground font-medium rounded-lg'
              : 'hover:bg-foreground/[0.035]',
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
            'mt-px shrink-0 font-mono tabular-nums text-xs text-muted-foreground leading-5',
            active && 'text-primary font-medium',
          )}
        >
          {time}
        </span>
        <span
          data-cue-text=""
          className={cn(
            'min-w-0 flex-1 break-words pr-6',
            TEXT_SIZE_CLASS[textSize],
            failed ? 'italic text-muted-foreground' : active ? 'text-foreground font-medium' : 'text-foreground/85',
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
      {!failed && !selecting && onExcerptDragStart && (
        <button
          type="button"
          draggable
          onDragStart={(event) => onExcerptDragStart(seg, event)}
          onDragEnd={onExcerptDragEnd}
          aria-label={t('mediaStudio:interop.drag_cue')}
          title={t('mediaStudio:interop.drag_cue')}
          data-testid="cue-drag-handle"
          className={cn(
            'absolute right-8 top-1 flex h-6 w-6 cursor-grab items-center justify-center rounded-md text-muted-foreground',
            'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100',
            'hover:bg-[var(--interactive-hover)] hover:text-foreground active:cursor-grabbing',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            '[@media(pointer:coarse)]:hidden',
          )}
        >
          <DotsSixVertical size={13} aria-hidden="true" />
        </button>
      )}
      {backlinks && backlinks.total > 0 && (
        <div className="flex justify-end px-2.5 pb-1">
          <CueBacklinkPill summary={backlinks} />
        </div>
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
  /** 跨插件互操作：拖拽引用与「划选即入图」 */
  interop?: TranscriptInteropOptions;
  /** 各段的反向链接汇总（key = 段 idx） */
  cueBacklinks?: ReadonlyMap<number, AnchorBacklinkSummary>;
  /** 各段关联思维导图分支语义微染色（key = 段 idx） */
  cueBranchTints?: ReadonlyMap<number, CueBranchTint>;
  /** 定位脉冲请求：nonce 单调递增，新请求取消旧脉冲 */
  pulsedCue?: { startMs: number; nonce: number } | null;
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
  interop,
  cueBacklinks,
  cueBranchTints,
  pulsedCue,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [query, setQuery] = useState('');
  const canSelect = Boolean(onQuoteSelection || onMakeCardsFromSelection);
  const [textSize, setTextSize] = useState<TranscriptTextSize>(readTextSize);
  const cycleTextSize = useCallback(() => {
    setTextSize((prev) => {
      const next = TEXT_SIZES[(TEXT_SIZES.indexOf(prev) + 1) % TEXT_SIZES.length];
      try {
        window.localStorage.setItem(TEXT_SIZE_KEY, next);
      } catch {
        // 存储不可用时只在本次生效
      }
      return next;
    });
  }, []);
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
    if (followRafRef.current !== null) window.cancelAnimationFrame(followRafRef.current);
    followRafRef.current = window.requestAnimationFrame(() => {
      followRafRef.current = null;
      scrollRowIntoView(activeSegmentIdx, true);
    });
  }, [searching, activeSegmentIdx, scrollRowIntoView]);
  const followRafRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (followRafRef.current !== null) window.cancelAnimationFrame(followRafRef.current);
  }, []);

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

  // ---------------------------------------------------------------- 跨插件摘录
  const buildCuePayload = useCallback((cues: readonly TranscriptSegment[], text: string) => {
    if (!interop || cues.length === 0) return null;
    const first = cues[0];
    const anchor = buildMediaSemanticAnchor({
      resourceId: interop.resourceId,
      aliasResourceId: interop.aliasResourceId,
      startMs: first.startMs,
      endMs: Math.max(...cues.map((cue) => cue.endMs)),
      quote: text,
      mediaTitle: interop.mediaTitle,
    });
    const basePayload = buildMediaExcerptPayload({ text, anchor, mediaTitle: interop.mediaTitle });
    return enrichMediaExcerptWithKeyframe(basePayload, interop.getVideoElement?.());
  }, [interop]);

  const emitAutoExcerpt = useCallback((cues: readonly TranscriptSegment[], text: string) => {
    if (!interop?.autoExcerptActive || cues.length === 0 || cues.some((cue) => cue.status !== 'done')
      || Array.from(text.replace(/\s/g, '')).length < 2) return;
    const key = mediaAutoExcerptKey(interop.resourceId, cues[0].startMs, text);
    if (!sharedMediaExcerptGuard.shouldEmitAuto(key)) return;
    const payload = buildCuePayload(cues, text.trim());
    if (payload) getAppKernel().dnd.emitAutoExcerpt(payload);
  }, [interop, buildCuePayload]);

  const handleSeekRow = useCallback((seg: TranscriptSegment) => {
    // 点选字幕即入图：有划选文本时让划选路径接管，避免同一手势送两次
    const domSelection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (domSelection && !domSelection.isCollapsed && domSelection.toString().trim()
      && domSelection.anchorNode && listRef.current?.contains(domSelection.anchorNode)) return;
    onSeek(seg);
    emitAutoExcerpt([seg], seg.text);
  }, [onSeek, emitAutoExcerpt]);

  const endOwnedDragRef = useRef<(() => void) | null>(null);
  const handleExcerptDragStart = useCallback((seg: TranscriptSegment, event: React.DragEvent<HTMLButtonElement>) => {
    const payload = buildCuePayload([seg], seg.text.trim());
    if (!payload) {
      event.preventDefault();
      return;
    }
    endOwnedDragRef.current = sharedMediaExcerptGuard.beginDrag();
    if (!getAppKernel().dnd.startExcerptDrag(event.nativeEvent, payload)) {
      endOwnedDragRef.current?.();
      endOwnedDragRef.current = null;
      event.preventDefault();
      return;
    }
    setCompactCueDragImage(event.dataTransfer, buildCueDragLabel(formatTranscriptClock(seg.startMs), seg.text));
  }, [buildCuePayload]);

  const handleExcerptDragEnd = useCallback(() => {
    endOwnedDragRef.current?.();
    endOwnedDragRef.current = null;
  }, []);

  useEffect(() => handleExcerptDragEnd, [handleExcerptDragEnd, interop?.resourceId]);

  // 划选字幕文本：选区落在一段或连续几段内时送入（拖拽进行中不送）
  const handleListMouseUp = useCallback((event: React.MouseEvent) => {
    if (!interop?.autoExcerptActive || selecting) return;
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('[data-cue-text]')) return;
    const list = listRef.current;
    const domSelection = window.getSelection();
    if (!list || !domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) return;
    const text = domSelection.toString().trim();
    if (text.length < 2) return;
    const range = domSelection.getRangeAt(0);
    if (!list.contains(range.startContainer) || !list.contains(range.endContainer)) return;
    const idxOf = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element?.closest('[data-cue-text]')) return null;
      const raw = element?.closest('[data-cue-index]')?.getAttribute('data-cue-index');
      return raw === undefined || raw === null ? null : Number(raw);
    };
    const fromIdx = idxOf(range.startContainer);
    const toIdx = idxOf(range.endContainer);
    if (fromIdx === null || toIdx === null) return;
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    const cues = displaySegments.filter((seg) => seg.status === 'done' && seg.idx >= lo && seg.idx <= hi);
    emitAutoExcerpt(cues, text);
  }, [interop, selecting, displaySegments, emitAutoExcerpt]);

  // ---------------------------------------------------------------- 定位脉冲（anchors.reveal）
  const [pulsedIdx, setPulsedIdx] = useState<number | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const pulseTargetIdx = pulsedCue ? findCueIndexForMs(displaySegments, pulsedCue.startMs) : null;
  useEffect(() => {
    const idx = pulseTargetIdx;
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = null;
    if (idx === null) {
      setPulsedIdx(null);
      return;
    }
    // 搜索过滤掉目标段时先清空搜索，让目标行渲染出来
    if (query.trim() && !visibleSegments.some((seg) => seg.idx === idx)) setQuery('');
    setPulsedIdx(idx);
    lastUserScrollAtRef.current = 0;
    const raf = window.requestAnimationFrame(() => {
      rowsRef.current.get(idx)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
    pulseTimerRef.current = window.setTimeout(() => {
      pulseTimerRef.current = null;
      setPulsedIdx(null);
    }, CUE_PULSE_DURATION_MS);
    return () => {
      window.cancelAnimationFrame(raf);
      if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    };
    // 字幕可能晚于定位请求到达；目标 idx 到位后才启动脉冲，不因无关段更新反复闪烁。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulsedCue?.nonce, pulseTargetIdx]);

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
        bordered && (layout === 'side' ? 'border-l border-border/35' : 'border-t border-border/35'),
        className,
      )}
    >
      {/* 统一紧凑工具行：合并搜索框、段数统计与字号/选段/定位/复制操作，消除双行工具条叠加 */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 border-b border-border/25">
        {!hideTitle && (
          <h3 className="shrink-0 text-sm font-medium text-foreground">
            {t('learningHub:mediaTranscript.panelTitle')}
          </h3>
        )}
        <div className="relative flex min-w-0 flex-1 items-center">
          <MagnifyingGlass
            size={13}
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
              'h-7 w-full rounded-md border border-border/30 bg-foreground/[0.025] pl-7 pr-7 text-xs text-foreground',
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
              className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground">
          {searching
            ? t('learningHub:mediaTranscript.searchResults', { count: visibleSegments.length })
            : t('learningHub:mediaTranscript.segmentCount', { count: displaySegments.length })}
        </span>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={cycleTextSize}
          aria-label={t('learningHub:mediaTranscript.textSize', { size: t(`learningHub:mediaTranscript.textSizeLabel.${textSize}`) })}
          title={t('learningHub:mediaTranscript.textSize', { size: t(`learningHub:mediaTranscript.textSizeLabel.${textSize}`) })}
          data-transcript-text-size={textSize}
          className="h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <TextAa size={14} aria-hidden="true" />
        </DsButton>
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
              'h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
              selecting && 'bg-primary/10 text-primary',
            )}
          >
            <ListChecks size={14} aria-hidden="true" />
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
          className="h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <Crosshair size={14} aria-hidden="true" />
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={handleCopyAll}
          disabled={doneCount === 0}
          aria-label={t('learningHub:mediaTranscript.copyAll')}
          title={t('learningHub:mediaTranscript.copyAll')}
          className="h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <Copy size={14} aria-hidden="true" />
        </DsButton>
      </div>

      {/* 状态条：进行中 / 部分完成 / 失败 */}
      {running && (
        <div className="shrink-0 border-y border-border/35 bg-foreground/[0.025] px-3 py-2" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CircleNotch size={13} className="animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            <span className="truncate">
              {status === 'queued' || progress?.stage === 'queued'
                ? t('learningHub:mediaTranscript.queued')
                : t(`learningHub:mediaTranscript.stage.${stageKey}`)}
            </span>
            {progress && progress.totalSegments > 0 && (
              <span className="font-mono tabular-nums">
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
            className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-foreground/[0.06]"
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
        <div className="flex shrink-0 items-center gap-2 border-y border-border/35 bg-foreground/[0.025] px-3 py-2 text-xs" role="status">
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
        onMouseUp={interop?.autoExcerptActive ? handleListMouseUp : undefined}
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
                onSeek={interop?.autoExcerptActive ? handleSeekRow : onSeek}
                onCopy={handleCopySegment}
                registerRow={registerRow}
                selecting={selecting}
                selected={selectedIdx.has(seg.idx)}
                onToggle={handleToggle}
                textSize={textSize}
                onExcerptDragStart={interop ? handleExcerptDragStart : undefined}
                onExcerptDragEnd={interop ? handleExcerptDragEnd : undefined}
                pulsed={pulsedIdx === seg.idx}
                backlinks={cueBacklinks?.get(seg.idx)}
                branchTint={cueBranchTints?.get(seg.idx)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 选段操作条 */}
      {selecting && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/35 bg-background/90 backdrop-blur-sm px-3 py-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]"
          role="toolbar"
          aria-label={t('learningHub:mediaTranscript.selectionToolbar')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              exitSelecting();
            }
          }}
        >
          <span className="mr-auto text-xs font-mono tabular-nums text-muted-foreground" aria-live="polite">
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
