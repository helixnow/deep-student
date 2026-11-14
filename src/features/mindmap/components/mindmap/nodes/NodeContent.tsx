import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { BlankedText } from '../../shared/BlankedText';
import { InlineLatex } from '../../shared/InlineLatex';
import { containsLatex } from '../../../utils/renderLatex';
import TextareaAutosize from 'react-textarea-autosize';
import type { BlankRange, MindMapImage, MindMapNodeRef } from '../../../types';
import { getMindMapPreferences } from '../../../utils/mindmapPreferences';
import { NodeRefList } from '../../shared/NodeRefCard';
import { useTextSelectionBubble } from '../../../hooks/useTextSelectionBubble';
import { isOutlineCompositionActive } from '../../../utils/outlineCaret';
import {
  CompletedCheckbox,
  NodeLinkButton,
  PriorityBadge,
  ProgressRing,
} from '../../shared/NodeDecorationBadges';
import type { NodeDecorations } from '../../../utils/nodeDecorations';
import type { NodeExcerptMeta } from '../../../utils/nodeAnchors';
import { NodeSourcePills } from '../../shared/NodeSourcePills';
import '../../../styles/node-edge-enhancements.css';

export interface NodeContentProps {
  text: string;
  note?: string;
  refs?: MindMapNodeRef[];
  /** 内嵌图片（导入内联小图）：正文上方渲染缩略图条 */
  images?: MindMapImage[];
  icon?: string;
  bgColor?: string;
  isRoot?: boolean;
  isCompleted?: boolean;
  isEditing?: boolean;
  isEditingNote?: boolean;
  blankedRanges?: BlankRange[];
  revealedIndices?: Record<number, boolean>;
  reciteMode?: boolean;
  isBold?: boolean;
  /** 装饰角标（priority / progress / href），由节点壳层从 store 读取后传入 */
  decorations?: NodeDecorations | null;
  /** 摘录出处与原文（anchors / excerptQuote），由节点壳层从 store 索引读取后传入 */
  excerpt?: NodeExcerptMeta | null;
  /** 节点是否被选中（选中时出处胶囊显示移除按钮） */
  isSelected?: boolean;
  onRemoveAnchor?: (anchorUri: string) => void;
  onRemoveExcerptSlot?: (slotId: string) => void;
  onCardNoteChange?: (cardNote: string | undefined) => void;
  onToggleExpandedCard?: () => void;
  onToggleFlashcard?: () => void;
  /** 完成态以 checkbox 视觉呈现（style.showCheckbox） */
  showCheckbox?: boolean;
  /** checkbox 点击切换 completed */
  onToggleCompleted?: () => void;
  /**
   * 新建后未输入任何内容的空节点失焦/Escape 时回调（代替静默回滚）。
   * 壳层实现需自带连续建点守卫：editingNodeId 已移至新节点时不得删除。
   */
  onEmptyCommit?: () => void;
  onTextChange?: (text: string) => void;
  /** 挖空前对齐 store 文本且保留 blankedRanges */
  onCommitLiveText?: (text: string) => void;
  onNoteChange?: (note: string | undefined) => void;
  onStartEdit?: () => void;
  onEndEdit?: () => void;
  onEndEditNote?: () => void;
  /** 编辑中 Enter：提交正文后新建同级（根则子级）并进入新节点编辑 */
  onCommitAndCreateSibling?: () => void;
  /** 编辑中 Tab：提交正文后新建子节点并进入编辑 */
  onCommitAndCreateChild?: () => void;
  /** 编辑中 Shift+Enter：提交正文后进入备注编辑（画布键位，避免把备注写进正文） */
  onCommitAndEditNote?: () => void;
  onRevealBlank?: (rangeIndex: number) => void;
  /** 背诵会话统计：遮盖态挖空实际渲染进视口时上报（透传 BlankedText） */
  onBlanksPresented?: (rangeIndices: number[]) => void;
  onAddBlank?: (range: BlankRange) => void;
  onRemoveBlank?: (rangeIndex: number) => void;
  onToggleBold?: () => void;
  onRemoveRef?: (sourceId: string) => void;
  onClickRef?: (sourceId: string) => void;
  className?: string;
}

export const NodeContent: React.FC<NodeContentProps> = ({
  text,
  note,
  refs,
  images,
  icon,
  bgColor,
  isRoot = false,
  isCompleted = false,
  isEditing = false,
  isEditingNote = false,
  blankedRanges,
  revealedIndices,
  reciteMode = false,
  isBold = false,
  decorations,
  excerpt,
  isSelected = false,
  onRemoveAnchor,
  onRemoveExcerptSlot,
  onCardNoteChange,
  onToggleExpandedCard,
  onToggleFlashcard,
  showCheckbox = false,
  onToggleCompleted,
  onEmptyCommit,
  onTextChange,
  onCommitLiveText,
  onNoteChange,
  onStartEdit,
  onEndEdit,
  onEndEditNote,
  onCommitAndCreateSibling,
  onCommitAndCreateChild,
  onCommitAndEditNote,
  onRevealBlank,
  onBlanksPresented,
  onAddBlank,
  onRemoveBlank,
  onToggleBold,
  onRemoveRef,
  onClickRef,
  className,
}) => {
  const { t } = useTranslation('mindmap');
  const [editValue, setEditValue] = useState(text);
  const [editNoteValue, setEditNoteValue] = useState(note || '');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const { handleMouseUp: handleEditSelectionMouseUp, bubble: editSelectionBubble } =
    useTextSelectionBubble({
      blankedRanges,
      isBold,
      onCommitLiveText: !reciteMode
        ? (live) => {
            setEditValue(live);
            onCommitLiveText?.(live);
          }
        : undefined,
      onAddBlank: !reciteMode ? onAddBlank : undefined,
      onRemoveBlank: !reciteMode ? onRemoveBlank : undefined,
      onToggleBold: !reciteMode ? onToggleBold : undefined,
    });

  useEffect(() => {
    if (!isEditing) {
      setEditValue(text);
    }
  }, [text, isEditing]);

  useEffect(() => {
    if (!isEditingNote) {
      setEditNoteValue(note || '');
    }
  }, [note, isEditingNote]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (isEditingNote && noteRef.current) {
      noteRef.current.focus();
      noteRef.current.style.height = 'auto';
      noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
    }
  }, [isEditingNote]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (reciteMode) return;
    onStartEdit?.();
  }, [onStartEdit, reciteMode]);

  const commitText = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed === '') {
      setEditValue(text || '');
    } else if (trimmed !== text) {
      onTextChange?.(trimmed);
    }
  }, [editValue, text, onTextChange]);

  const handleSave = useCallback(() => {
    // 新建后从未输入内容的空节点：失焦时交由壳层处理（通常删除空节点），
    // 壳层自带 editingNodeId 守卫，连续建点（Enter 后旧 textarea blur）不受影响
    if (editValue.trim() === '' && text.trim() === '' && onEmptyCommit) {
      onEmptyCommit();
      return;
    }
    commitText();
    onEndEdit?.();
  }, [commitText, editValue, text, onEmptyCommit, onEndEdit]);

  const noteSavingRef = useRef(false);
  const handleNoteSave = useCallback(() => {
    if (noteSavingRef.current) return;
    noteSavingRef.current = true;
    const trimmed = editNoteValue.trim();
    if (trimmed === '') {
      onNoteChange?.(undefined);
    } else if (trimmed !== (note || '')) {
      onNoteChange?.(trimmed);
    }
    onEndEditNote?.();
    requestAnimationFrame(() => { noteSavingRef.current = false; });
  }, [editNoteValue, note, onNoteChange, onEndEditNote]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // IME 组字中 Enter/Tab/Escape 属于输入法确认键，不得触发提交/建点
    if (isOutlineCompositionActive(e.nativeEvent)) return;

    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // 画布约定：Shift+Enter = 编辑备注（不得插入正文换行，否则备注写进标题）
        if (onCommitAndEditNote) {
          e.preventDefault();
          e.stopPropagation();
          commitText();
          onCommitAndEditNote();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!editValue.trim() && !text.trim()) return;
      commitText();
      if (onCommitAndCreateSibling) {
        onCommitAndCreateSibling();
      } else {
        onEndEdit?.();
      }
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && onCommitAndCreateChild && (editValue.trim() || text.trim())) {
      e.preventDefault();
      e.stopPropagation();
      commitText();
      onCommitAndCreateChild();
      return;
    }
    if (e.key === 'Escape') {
      // Escape 单一路径：此处恢复 draft 并结束编辑，随后阻断冒泡，
      // 防止全局监听（useMindMapKeyboard）二次清 editingNodeId / 抢跑
      e.preventDefault();
      e.stopPropagation();
      if (editValue.trim() === '' && text.trim() === '' && onEmptyCommit) {
        onEmptyCommit();
        return;
      }
      setEditValue(text);
      onEndEdit?.();
    }
  }, [commitText, editValue, text, onEmptyCommit, onEndEdit, onCommitAndCreateSibling, onCommitAndCreateChild, onCommitAndEditNote]);

  const handleNoteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isOutlineCompositionActive(e.nativeEvent)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleNoteSave();
      return;
    }
    if (e.key === 'Backspace' && editNoteValue === '') {
      e.preventDefault();
      onNoteChange?.(undefined);
      onEndEditNote?.();
      return;
    }
  }, [editNoteValue, handleNoteSave, onNoteChange, onEndEditNote]);

  const unnamedLabel = t('node.unnamed');
  const displayText = text || unnamedLabel;
  const displayWithBlanks = reciteMode || !!onAddBlank;
  const hasLatex = containsLatex(text);
  const hasBlanks = (blankedRanges?.length ?? 0) > 0;
  // LaTeX 与挖空共存降级策略：
  // - 已有挖空区间（含背诵模式）：走 BlankedText（遮罩 / 挖空管理正确性优先），公式显示为原文（降级）
  // - 仅 LaTeX 无挖空：走 InlineLatex 渲染公式——背诵模式下这类节点没有可遮的内容，
  //   此前也走 BlankedText，一进背诵整张图的公式都变回 $…$ 源码
  //   （编辑态选区气泡仍可新增挖空）
  const useBlankedDisplay = displayWithBlanks && (hasBlanks || !hasLatex);
  const descriptionFirstLine = getMindMapPreferences().descriptionPreview === 'first-line';

  return (
    <div
      className={cn(
        "relative flex w-full min-w-0 max-w-[600px] flex-col",
        className
      )}
      onDoubleClick={handleDoubleClick}
    >
      {images && images.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1 justify-start" data-testid="mm-node-images">
          {images.map((image, index) => (
            <img
              key={index}
              src={image.src}
              alt={image.name || t('node.imageAlt', { defaultValue: '节点图片' })}
              title={image.name}
              loading="lazy"
              draggable={false}
              className="rounded border border-[var(--mm-border)] object-contain select-none"
              style={{
                // 保留导入宽高比例信息但限制缩略尺寸，超限时按 max 约束等比缩放
                maxWidth: 160,
                maxHeight: 90,
                ...(image.width && image.height
                  ? { aspectRatio: `${image.width} / ${image.height}` }
                  : {}),
              }}
            />
          ))}
        </div>
      )}
      <div className="relative flex items-center gap-1">
        {showCheckbox && !isEditing && (
          <CompletedCheckbox
            completed={isCompleted}
            disabled={reciteMode || !onToggleCompleted}
            onToggle={onToggleCompleted}
          />
        )}
        {decorations?.priority != null && !isEditing && (
          <PriorityBadge priority={decorations.priority} />
        )}
        {decorations?.progress != null && !isEditing && (
          <ProgressRing progress={decorations.progress} />
        )}
        {icon && <span className="flex-shrink-0 text-base leading-none select-none">{icon}</span>}
        <div className="relative min-w-0 flex-1 text-center">
          {isEditing ? (
            <>
              <TextareaAutosize
                ref={inputRef}
                aria-label={t('contextMenu.edit')}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSave}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                onMouseUp={handleEditSelectionMouseUp}
                onTouchEnd={handleEditSelectionMouseUp}
                placeholder={text || unnamedLabel}
                className={cn(
                  'nopan nodrag block w-full resize-none overflow-hidden bg-transparent px-1',
                  'rounded-sm border-none outline-none ring-0 focus:ring-0',
                  'text-inherit placeholder:text-[var(--mm-text-muted)]',
                  'text-center',
                )}
                style={{ font: 'inherit', letterSpacing: 'inherit' }}
              />
              {editSelectionBubble}
            </>
          ) : useBlankedDisplay ? (
            <BlankedText
              text={displayText}
              blankedRanges={blankedRanges || []}
              revealedIndices={revealedIndices}
              reciteMode={reciteMode}
              allowSelectionActions={!reciteMode}
              isBold={isBold}
              onRevealBlank={onRevealBlank}
              onBlanksPresented={onBlanksPresented}
              onAddBlank={text.length > 0 ? onAddBlank : undefined}
              onRemoveBlank={onRemoveBlank}
              onToggleBold={onToggleBold}
              className={cn(
                'mm-node-text inline-block whitespace-pre-wrap break-words px-1 min-h-[1.2em] rounded-sm',
                !text && 'text-[var(--mm-text-muted)]',
                isCompleted && 'line-through text-[var(--mm-text-muted)]',
              )}
            />
          ) : (
            <InlineLatex
              text={displayText}
              className={cn(
                'mm-node-text inline-block whitespace-pre-wrap break-words px-1 min-h-[1.2em] select-none rounded-sm',
                !text && 'text-[var(--mm-text-muted)]',
                isCompleted && 'line-through text-[var(--mm-text-muted)]',
              )}
            />
          )}
        </div>
      {decorations?.href && !isEditing && <NodeLinkButton href={decorations.href} />}
      </div>

      {isEditingNote ? (
        <textarea
          ref={noteRef}
          value={editNoteValue}
          onChange={(e) => {
            setEditNoteValue(e.target.value);
            if (noteRef.current) {
              noteRef.current.style.height = 'auto';
              noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
            }
          }}
          onBlur={handleNoteSave}
          onKeyDown={handleNoteKeyDown}
          onClick={(e) => e.stopPropagation()}
          placeholder={t('contextMenu.addNote')}
          className={cn(
            "text-xs px-1 mt-0.5 leading-tight resize-none",
            "nopan nodrag",
            "bg-[var(--mm-bg-elevated)] shadow-[var(--mm-shadow-sm)] rounded-sm",
            "border-none outline-none ring-0 focus:ring-0",
            "text-[var(--mm-text-muted)] placeholder:text-[var(--mm-text-muted)]/50",
            "min-w-[80px] min-h-[1.5em] w-full",
            isRoot ? "text-center" : "text-left",
          )}
          rows={1}
        />
      ) : note ? (
        <InlineLatex
          text={note}
          className={cn(
            "text-xs text-[var(--mm-text-muted)] px-1 mt-0.5 whitespace-pre-wrap leading-tight",
            descriptionFirstLine && "mm-note-first-line",
            isRoot ? "text-center" : "text-left",
            isCompleted && "line-through opacity-70"
          )}
        />
      ) : null}

      {excerpt && !isEditing && (
        <NodeSourcePills
          anchors={excerpt.anchors}
          excerptQuote={excerpt.excerptQuote}
          excerpts={excerpt.excerpts}
          cardNote={excerpt.cardNote}
          isExpandedCard={excerpt.isExpandedCard}
          isFlashcard={excerpt.isFlashcard}
          readonly={reciteMode || !onRemoveAnchor}
          selected={isSelected}
          onRemoveAnchor={onRemoveAnchor}
          onRemoveExcerptSlot={onRemoveExcerptSlot}
          onCardNoteChange={onCardNoteChange}
          onToggleExpandedCard={onToggleExpandedCard}
          onToggleFlashcard={onToggleFlashcard}
          className={isRoot ? 'items-center' : 'items-start'}
        />
      )}

      {refs && refs.length > 0 && (
        <NodeRefList
          refs={refs}
          onRemove={onRemoveRef}
          onClick={onClickRef}
          readonly={reciteMode}
        />
      )}
    </div>
  );
};
