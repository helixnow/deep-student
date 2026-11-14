/**
 * 节点出处胶囊与复合摘录卡片内容区（Mineral 青瓷微染，W08 + C7 §3）：
 * - 单摘录胶囊：`P.218` / `14:22` / `#blk_9f8a` / `Q.q_12`；
 * - 复合卡片槽（`excerpts[]`）：支持多段引文、框选截图、视频关键帧+时间片、题库题目引用归并；
 * - 个人理解批注（`cardNote`）：可折叠内联批注编辑；
 * - 闪卡投影角标（`isFlashcard`）：`CARD` 胶囊指示。
 *
 * 交互隔离（C6 §2.1）：胶囊、摘录槽、批注区均带 `nodrag nopan`，并在 pointerdown / mousedown /
 * click / dblclick 上 stopPropagation——点击永远不会拖动节点、进入标题编辑、折叠分支或清空多选。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cards,
  CaretDown,
  CaretRight,
  FilePdf,
  LinkSimple,
  Note,
  NotePencil,
  PlayCircle,
  Question,
  X,
} from '@phosphor-icons/react';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { UiAnchorsHandle } from '@/ui-kernel/services/anchors';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import { cn } from '@/utils/cn';
import { dispatchTypedEvent } from '@/events';
import { getErrorMessage } from '@/utils/errorUtils';
import type { MindMapExcerptSlot } from '../../types';
import {
  formatMediaRangeLabel,
  formatMindMapSourcePill,
  safeSerializeAnchor,
} from '../../utils/nodeAnchors';
import { openNodeRef } from '../../utils/openNodeRef';
import '../../styles/mn5-excerpt.css';

// ============================================================================
// 出处定位
// ============================================================================

/** 内核缺席（轻量窗口 / 单测）时的事件回退 */
export function dispatchMindMapSourceFallback(anchor: SemanticAnchor): void {
  if (typeof window === 'undefined') return;
  if (anchor.kind === 'pdf') {
    dispatchTypedEvent('DSTU_FOCUS_PDF', {
          sourceId: anchor.resourceId,
          page: anchor.page,
          rect: anchor.rect,
          quote: anchor.quote,
    });
    return;
  }
  if (anchor.kind === 'media') {
    dispatchTypedEvent('DSTU_FOCUS_MEDIA', {
          resourceId: anchor.resourceId,
          seconds: anchor.startMs / 1000,
          startMs: anchor.startMs,
          endMs: anchor.endMs,
          quote: anchor.quote,
    });
    return;
  }
  void openNodeRef(anchor.resourceId, { type: anchor.kind, name: anchor.label ?? '' });
}

/**
 * 定位摘录原文：优先内核 anchors（已打开的阅读器 <50ms 直达，未打开则分屏打开），
 * 内核缺席或未处理时回退为 DSTU_FOCUS_* 事件。
 */
export async function revealMindMapSourceAnchor(
  anchor: SemanticAnchor,
  anchors: Pick<UiAnchorsHandle, 'reveal'> | null | undefined,
): Promise<boolean> {
  if (anchors) {
    try {
      const result = await anchors.reveal(anchor, { splitIfClosed: true, pulse: true });
      if (result.ok) return true;
    } catch (error) {
      console.warn('[NodeSourcePills] reveal failed:', getErrorMessage(error));
    }
  }
  dispatchMindMapSourceFallback(anchor);
  return false;
}

// ============================================================================
// 事件隔离
// ============================================================================

const stopOnly = (e: React.SyntheticEvent) => {
  e.stopPropagation();
};

/** 容器级隔离：子元素上的指针 / 点击事件不冒泡到 ReactFlow 节点与大纲行 */
const isolationHandlers = {
  onPointerDown: stopOnly,
  onMouseDown: stopOnly,
  onClick: stopOnly,
  onDoubleClick: stopOnly,
  onTouchStart: stopOnly,
} as const;

function SourceIcon({ anchor }: { anchor: SemanticAnchor }) {
  const className = 'mm-mn5-source-pill-icon';
  switch (anchor.kind) {
    case 'pdf':
      return <FilePdf size={11} weight="bold" className={className} aria-hidden />;
    case 'media':
      return <PlayCircle size={11} weight="bold" className={className} aria-hidden />;
    case 'note':
      return <Note size={11} weight="bold" className={className} aria-hidden />;
    case 'qbank':
      return <Question size={11} weight="bold" className={className} aria-hidden />;
    default:
      return <LinkSimple size={11} weight="bold" className={className} aria-hidden />;
  }
}

// ============================================================================
// Props 定义
// ============================================================================

export interface NodeSourcePillsProps {
  anchors: readonly SemanticAnchor[];
  excerptQuote?: string;
  /** 复合摘录槽列表（2 条以上或含时间片关键帧 / 题库引用时展示结构化卡片槽） */
  excerpts?: readonly MindMapExcerptSlot[];
  /** 复合卡片个人理解批注 */
  cardNote?: string;
  /** 复合卡片是否展开 */
  isExpandedCard?: boolean;
  /** 节点是否已开启 FSRS 闪卡投影 */
  isFlashcard?: boolean;
  /** 大纲行内联紧凑模式（只渲染胶囊与角标，不渲染多行卡片槽） */
  compact?: boolean;
  /** 只读（背诵 / 嵌入预览）：隐藏编辑与移除按钮 */
  readonly?: boolean;
  /** 节点选中时显示移除与添加批注入口 */
  selected?: boolean;
  onRemoveAnchor?: (anchorUri: string) => void;
  onRemoveExcerptSlot?: (slotId: string) => void;
  onCardNoteChange?: (cardNote: string | undefined) => void;
  onToggleExpandedCard?: () => void;
  onToggleFlashcard?: () => void;
  /** 测试 / 宿主注入：覆盖内核 anchors（null 表示强制走事件回退） */
  anchorsService?: Pick<UiAnchorsHandle, 'reveal'> | null;
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

export const NodeSourcePills: React.FC<NodeSourcePillsProps> = ({
  anchors,
  excerptQuote,
  excerpts,
  cardNote,
  isExpandedCard,
  isFlashcard = false,
  compact = false,
  readonly = false,
  selected = false,
  onRemoveAnchor,
  onRemoveExcerptSlot,
  onCardNoteChange,
  onToggleExpandedCard,
  onToggleFlashcard,
  anchorsService,
  className,
}) => {
  const { t } = useTranslation('mindmap');
  const kernel = useOptionalUiKernel();
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [localSlotsExpanded, setLocalSlotsExpanded] = useState(true);
  const [editingCardNote, setEditingCardNote] = useState(false);
  const [cardNoteDraft, setCardNoteDraft] = useState(cardNote ?? '');
  const cardNoteInputRef = useRef<HTMLTextAreaElement>(null);

  const service = anchorsService !== undefined ? anchorsService : (kernel?.anchors ?? null);

  useEffect(() => {
    if (!editingCardNote) {
      setCardNoteDraft(cardNote ?? '');
    }
  }, [cardNote, editingCardNote]);

  useEffect(() => {
    if (editingCardNote && cardNoteInputRef.current) {
      cardNoteInputRef.current.focus();
    }
  }, [editingCardNote]);

  const handlePillClick = useCallback(
    (e: React.MouseEvent, anchor: SemanticAnchor) => {
      e.stopPropagation();
      e.preventDefault();
      void revealMindMapSourceAnchor(anchor, service);
    },
    [service],
  );

  const removeAnchor = useCallback(
    (anchor: SemanticAnchor) => {
      const uri = safeSerializeAnchor(anchor);
      if (uri) onRemoveAnchor?.(uri);
    },
    [onRemoveAnchor],
  );

  const handleQuoteToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setQuoteExpanded((prev) => !prev);
  }, []);

  const commitCardNote = useCallback(() => {
    const trimmed = cardNoteDraft.trim();
    onCardNoteChange?.(trimmed || undefined);
    setEditingCardNote(false);
  }, [cardNoteDraft, onCardNoteChange]);

  const slotList = excerpts ?? [];
  const hasCompoundSlots =
    !compact &&
    (slotList.length >= 2 ||
      slotList.some(
        (slot) =>
          slot.kind === 'qbank' ||
          (slot.kind === 'media' && (slot.imageDataUrl || slot.endMs !== undefined)),
      ));
  const slotsExpanded = isExpandedCard ?? localSlotsExpanded;
  const showSingleQuote =
    !compact &&
    !hasCompoundSlots &&
    typeof excerptQuote === 'string' &&
    excerptQuote.trim().length > 0;
  const hasCardNote = !compact && typeof cardNote === 'string' && cardNote.trim().length > 0;
  const canEditCardNote = !compact && !readonly && Boolean(onCardNoteChange);

  if (
    anchors.length === 0 &&
    !showSingleQuote &&
    !hasCompoundSlots &&
    !hasCardNote &&
    !editingCardNote &&
    !isFlashcard
  ) {
    return null;
  }

  const canRemove = !readonly && selected && !!onRemoveAnchor;
  const expandedSlotAnchorUris =
    hasCompoundSlots && slotsExpanded
      ? new Set(
          slotList
            .map((slot) => safeSerializeAnchor(slot.anchor))
            .filter((uri): uri is string => Boolean(uri)),
        )
      : null;
  const bottomAnchors = expandedSlotAnchorUris
    ? anchors.filter((anchor) => {
        const uri = safeSerializeAnchor(anchor);
        return !uri || !expandedSlotAnchorUris.has(uri);
      })
    : anchors;
  const showAddCardNotePill =
    canEditCardNote && !hasCompoundSlots && !hasCardNote && !editingCardNote && selected;

  return (
    <div
      className={cn(
        'mm-mn5-excerpt nodrag nopan',
        compact ? 'inline-flex items-center gap-1' : 'flex flex-col',
        className,
      )}
      data-testid="mm-node-source-pills"
      {...isolationHandlers}
    >
      {/* 单摘录原文条 */}
      {showSingleQuote && (
        <button
          type="button"
          className="mm-mn5-quote nodrag nopan"
          data-expanded={quoteExpanded ? 'true' : 'false'}
          aria-expanded={quoteExpanded}
          title={quoteExpanded ? t('mn5.collapseQuote') : t('mn5.expandQuote')}
          onPointerDown={stopOnly}
          onMouseDown={stopOnly}
          onDoubleClick={stopOnly}
          onClick={handleQuoteToggle}
          data-testid="mm-node-excerpt-quote"
        >
          {excerptQuote}
        </button>
      )}

      {/* 复合卡片多源摘录槽（C7 §3.2） */}
      {hasCompoundSlots && (
        <div className="mm-mn5-compound-card nodrag nopan" data-testid="mm-compound-card">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]"
              onClick={(e) => {
                e.stopPropagation();
                if (onToggleExpandedCard) onToggleExpandedCard();
                else setLocalSlotsExpanded((prev) => !prev);
              }}
              aria-expanded={slotsExpanded}
              title={slotsExpanded ? t('mn5.collapseCardSlots') : t('mn5.expandCardSlots')}
              data-testid="mm-compound-card-toggle"
            >
              {slotsExpanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
              <span>{t('mn5.compoundSlotsCount', { count: slotList.length })}</span>
            </button>
            {canEditCardNote && !hasCardNote && !editingCardNote && selected && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[10px] text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingCardNote(true);
                }}
                data-testid="mm-add-card-note-btn"
              >
                <NotePencil size={10} />
                <span>{t('mn5.addCardNote')}</span>
              </button>
            )}
          </div>

          {slotsExpanded && (
            <div className="flex flex-col gap-1.5" data-testid="mm-compound-slots">
              {slotList.map((slot) => {
                const slotLocator =
                  slot.anchor.kind === 'media'
                    ? formatMediaRangeLabel(
                        slot.startMs ?? slot.anchor.startMs,
                        slot.endMs ?? slot.anchor.endMs,
                      )
                    : formatMindMapSourcePill(slot.anchor);
                const showSlotThumb =
                  typeof slot.imageDataUrl === 'string' &&
                  slot.imageDataUrl.startsWith('data:image/');
                return (
                  <div
                    key={slot.id}
                    className="mm-mn5-slot-item nodrag nopan"
                    data-slot-kind={slot.kind}
                    data-testid="mm-compound-slot"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-[var(--mm-celadon-pill-fg)] hover:underline"
                        onClick={(e) => handlePillClick(e, slot.anchor)}
                        title={t('mn5.revealSourceHint', { locator: slotLocator })}
                      >
                        <SourceIcon anchor={slot.anchor} />
                        <span>{slotLocator}</span>
                      </button>
                      {!readonly && selected && onRemoveExcerptSlot && (
                        <button
                          type="button"
                          className="inline-flex items-center justify-center w-4 h-4 rounded text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveExcerptSlot(slot.id);
                          }}
                          aria-label={t('mn5.removeExcerptSlot')}
                          title={t('mn5.removeExcerptSlot')}
                          data-testid="mm-remove-slot-btn"
                        >
                          <X size={9} weight="bold" />
                        </button>
                      )}
                    </div>
                    {showSlotThumb && (
                      <img
                        src={slot.imageDataUrl}
                        alt={slot.sourceTitle ?? slotLocator}
                        draggable={false}
                        className="max-h-24 max-w-[200px] rounded border border-border/35 object-contain"
                      />
                    )}
                    {slot.text && (
                      <div className="text-[11px] leading-snug text-[var(--mm-text-secondary,var(--mm-text-muted))] whitespace-pre-wrap break-words line-clamp-3">
                        {slot.text}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 个人理解批注（cardNote） */}
      {!compact && (editingCardNote || hasCardNote) && (
        <div className="mm-mn5-card-note nodrag nopan" data-testid="mm-node-card-note">
          {editingCardNote && !readonly ? (
            <textarea
              ref={cardNoteInputRef}
              value={cardNoteDraft}
              rows={2}
              placeholder={t('mn5.cardNotePlaceholder')}
              onChange={(e) => setCardNoteDraft(e.target.value)}
              onBlur={commitCardNote}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitCardNote();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCardNoteDraft(cardNote ?? '');
                  setEditingCardNote(false);
                }
              }}
              className="w-full bg-transparent text-[11px] leading-relaxed outline-none resize-none"
              data-testid="mm-node-card-note-input"
            />
          ) : (
            <div
              role={canEditCardNote ? 'button' : undefined}
              tabIndex={canEditCardNote ? 0 : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (canEditCardNote) setEditingCardNote(true);
              }}
              onKeyDown={(e) => {
                if (canEditCardNote && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingCardNote(true);
                }
              }}
              title={canEditCardNote ? t('mn5.editCardNote') : undefined}
              className={cn('whitespace-pre-wrap break-words', canEditCardNote && 'cursor-text')}
            >
              {cardNote}
            </div>
          )}
        </div>
      )}

      {/* 出处胶囊条 + 闪卡投影角标（复合槽展开时隐藏已在槽头展示的同源胶囊，收起时完整回显） */}
      {(bottomAnchors.length > 0 || isFlashcard || showAddCardNotePill) && (
        <div className="mm-mn5-sources" data-compact={compact ? 'true' : 'false'}>
          {isFlashcard && (
            <button
              type="button"
              className="mm-mn5-flashcard-badge font-mono tabular-nums nodrag nopan"
              title={t('mn5.flashcardBadgeHint')}
              onClick={(e) => {
                e.stopPropagation();
                if (!readonly && onToggleFlashcard) onToggleFlashcard();
              }}
              data-testid="mm-node-flashcard-badge"
            >
              <span className="mm-mn5-status-dot" aria-hidden="true" />
              <Cards size={10} weight="bold" aria-hidden />
              <span>{t('mn5.flashcardBadgeLabel')}</span>
            </button>
          )}
          {bottomAnchors.map((anchor, index) => {
            const locator = formatMindMapSourcePill(anchor);
            const quote = 'quote' in anchor && anchor.quote ? `\n${anchor.quote}` : '';
            const title = `${anchor.label ? `${anchor.label} \u00b7 ` : ''}${locator}${quote}`;
            return (
              <span
                key={`${safeSerializeAnchor(anchor) ?? anchor.resourceId}:${index}`}
                className="mm-mn5-source-pill nodrag nopan"
                data-anchor-kind={anchor.kind}
              >
                <button
                  type="button"
                  className="inline-flex items-center gap-[3px] nodrag nopan"
                  title={title}
                  aria-label={t('mn5.revealSourceHint', { locator })}
                  onPointerDown={stopOnly}
                  onMouseDown={stopOnly}
                  onDoubleClick={stopOnly}
                  onClick={(e) => handlePillClick(e, anchor)}
                  data-testid="mm-node-source-pill"
                >
                  <SourceIcon anchor={anchor} />
                  <span className="mm-mn5-source-pill-label font-mono tabular-nums text-[10px] font-medium tracking-tight">
                    {locator}
                  </span>
                </button>
                {canRemove && (
                  <button
                    type="button"
                    className="mm-mn5-source-remove nodrag nopan"
                    title={t('mn5.removeSourceAnchor')}
                    aria-label={t('mn5.removeSourceAnchor')}
                    onPointerDown={stopOnly}
                    onMouseDown={stopOnly}
                    onDoubleClick={stopOnly}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      removeAnchor(anchor);
                    }}
                  >
                    <X size={8} weight="bold" aria-hidden />
                  </button>
                )}
              </span>
            );
          })}
          {showAddCardNotePill && (
            <button
              type="button"
              className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full border border-border/35 text-[10px] text-[var(--mm-text-muted)] hover:text-[var(--mm-text)] nodrag nopan"
              onClick={(e) => {
                e.stopPropagation();
                setEditingCardNote(true);
              }}
              data-testid="mm-add-card-note-pill"
            >
              <NotePencil size={10} />
              <span>{t('mn5.addCardNote')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default NodeSourcePills;
