import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
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
  const [inputWidth, setInputWidth] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

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

  useLayoutEffect(() => {
    if (isEditing && measureRef.current) {
      const measuredWidth = measureRef.current.offsetWidth + 4;
      const containerWidth = containerRef.current?.offsetWidth || 0;
      setInputWidth(Math.max(measuredWidth, containerWidth));
    }
  }, [editValue, isEditing]);

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
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      commitText();
      if (onCommitAndCreateSibling) {
        onCommitAndCreateSibling();
      } else {
        onEndEdit?.();
      }
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && onCommitAndCreateChild) {
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
  }, [commitText, editValue, text, onEmptyCommit, onEndEdit, onCommitAndCreateSibling, onCommitAndCreateChild]);

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

  const displayWithBlanks = !isEditing && (reciteMode || !!onAddBlank);
  const hasLatex = containsLatex(text);
  const hasBlanks = (blankedRanges?.length ?? 0) > 0;
  // LaTeX 与挖空共存降级策略：
  // - 背诵模式：恒走 BlankedText（遮罩正确性优先）
  // - 已有挖空区间：走 BlankedText（挖空可见/可管理），公式显示为原文（降级）
  // - 仅 LaTeX 无挖空：走 InlineLatex 渲染公式（编辑态选区气泡仍可新增挖空）
  const useBlankedDisplay = displayWithBlanks && (reciteMode || hasBlanks || !hasLatex);
  const descriptionFirstLine = getMindMapPreferences().descriptionPreview === 'first-line';

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex flex-col min-w-[20px] max-w-[600px]",
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
        <div className="relative flex-1 min-w-0">
        {useBlankedDisplay ? (
          <BlankedText
            text={text || t('node.unnamed')}
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
              // 多行策略：展示态支持 pre-wrap（Shift+Enter 换行不再“消失”），
              // 高度变化由 ResizeObserver → setMeasuredNodeHeight 链路同步布局
              "mm-node-text inline-block whitespace-pre-wrap break-words px-1 min-h-[1.2em] rounded-sm",
              isCompleted && "line-through text-[var(--mm-text-muted)]",
            )}
            style={{ backgroundColor: bgColor ? `${bgColor}85` : undefined }}
          />
        ) : (
          <InlineLatex
            text={text || t('node.unnamed')}
            className={cn(
              "mm-node-text inline-block whitespace-pre-wrap break-words px-1 min-h-[1.2em] select-none opacity-0 rounded-sm",
              !isEditing && "opacity-100",
              isCompleted && !isEditing && "line-through text-[var(--mm-text-muted)]",
            )}
            style={{ backgroundColor: bgColor ? `${bgColor}85` : undefined }}
          />
        )}

        {isEditing && (
          <>
            {/* 测量 span：字体属性靠自然继承与展示态一致（不要加 Tailwind 字体类破坏继承） */}
            <span
              ref={measureRef}
              className="absolute invisible pointer-events-none whitespace-pre px-1"
              style={{
                fontFamily: 'inherit',
                fontSize: 'inherit',
                fontWeight: 'inherit',
                lineHeight: 'inherit',
                letterSpacing: 'inherit',
              }}
              aria-hidden="true"
            >
              {editValue || t('node.unnamed')}
            </span>

            <TextareaAutosize
            ref={inputRef as any}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown as any}
            onClick={(e) => e.stopPropagation()}
            onMouseUp={handleEditSelectionMouseUp as any}
            onTouchEnd={handleEditSelectionMouseUp as any}
            style={{
              width: inputWidth,
              left: isRoot ? '50%' : '0',
              transform: isRoot ? 'translateX(-50%)' : 'none',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              fontWeight: 'inherit',
              lineHeight: 'inherit',
              letterSpacing: 'inherit',
              backgroundColor: bgColor ? `${bgColor}85` : undefined,
            }}
              className={cn(
                "absolute top-0 h-full resize-none overflow-hidden block",
                "nopan nodrag",
                "bg-[var(--mm-bg-elevated)] shadow-[var(--mm-shadow-sm)] rounded-sm",
                "border-none outline-none ring-0 focus:ring-0",
                "text-inherit px-1",
                "placeholder:text-[var(--mm-text-muted)]",
                isRoot ? "text-center" : "text-left",
                "z-10"
              )}
              placeholder={text || t('node.unnamed')}
            />
            {editSelectionBubble}
          </>
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
