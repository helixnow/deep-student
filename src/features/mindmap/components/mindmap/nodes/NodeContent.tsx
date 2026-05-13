import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BlankedText } from '../../shared/BlankedText';
import { InlineLatex } from '../../shared/InlineLatex';
import { containsLatex } from '../../../utils/renderLatex';
import TextareaAutosize from 'react-textarea-autosize';
import type { BlankRange, MindMapNodeRef } from '../../../types';
import { NodeRefList } from '../../shared/NodeRefCard';

export interface NodeContentProps {
  text: string;
  note?: string;
  refs?: MindMapNodeRef[];
  icon?: string;
  bgColor?: string;
  isRoot?: boolean;
  isCompleted?: boolean;
  isEditing?: boolean;
  isEditingNote?: boolean;
  blankedRanges?: BlankRange[];
  revealedIndices?: Record<number, boolean>;
  reciteMode?: boolean;
  onTextChange?: (text: string) => void;
  onNoteChange?: (note: string | undefined) => void;
  onStartEdit?: () => void;
  onEndEdit?: () => void;
  onEndEditNote?: () => void;
  onRevealBlank?: (rangeIndex: number) => void;
  onAddBlank?: (range: BlankRange) => void;
  onRemoveBlank?: (rangeIndex: number) => void;
  onRemoveRef?: (sourceId: string) => void;
  onClickRef?: (sourceId: string) => void;
  className?: string;
}

export const NodeContent: React.FC<NodeContentProps> = ({
  text,
  note,
  refs,
  icon,
  bgColor,
  isRoot = false,
  isCompleted = false,
  isEditing = false,
  isEditingNote = false,
  blankedRanges,
  revealedIndices,
  reciteMode = false,
  onTextChange,
  onNoteChange,
  onStartEdit,
  onEndEdit,
  onEndEditNote,
  onRevealBlank,
  onAddBlank,
  onRemoveBlank,
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
      inputRef.current.select(); // 自动全选
    }
  }, [isEditing]);

  useEffect(() => {
    if (isEditingNote && noteRef.current) {
      noteRef.current.focus();
      // 自动调整高度
      noteRef.current.style.height = 'auto';
      noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
    }
  }, [isEditingNote]);

  // Measure input width whenever editValue changes
  useLayoutEffect(() => {
    if (isEditing && measureRef.current) {
      // Add a small buffer to prevent jitter
      const measuredWidth = measureRef.current.offsetWidth + 4; 
      // Ensure input is at least as wide as the container
      const containerWidth = containerRef.current?.offsetWidth || 0;
      setInputWidth(Math.max(measuredWidth, containerWidth));
    }
  }, [editValue, isEditing]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (reciteMode) return; // 背诵模式下禁止双击编辑
    onStartEdit?.();
  }, [onStartEdit, reciteMode]);

  const handleSave = useCallback(() => {
    const trimmed = editValue.trim();
    // ★ 2026-02 修复：空文本恢复为原文本，防止与后端 normalize("未命名") 不一致导致闪烁
    if (trimmed === '') {
      setEditValue(text || '');
    } else if (trimmed !== text) {
      onTextChange?.(trimmed);
    }
    onEndEdit?.();
  }, [editValue, text, onTextChange, onEndEdit]);

  const noteSavingRef = useRef(false);
  const handleNoteSave = useCallback(() => {
    if (noteSavingRef.current) return; // 防止 Escape + onBlur 双重触发
    noteSavingRef.current = true;
    const trimmed = editNoteValue.trim();
    if (trimmed === '') {
      // 空备注则删除
      onNoteChange?.(undefined);
    } else if (trimmed !== (note || '')) {
      onNoteChange?.(trimmed);
    }
    onEndEditNote?.();
    // 下一帧重置，允许后续编辑
    requestAnimationFrame(() => { noteSavingRef.current = false; });
  }, [editNoteValue, note, onNoteChange, onEndEditNote]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Shift + Enter: 允许换行，不保存
        return;
      }
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setEditValue(text);
      onEndEdit?.();
    }
  }, [handleSave, text, onEndEdit]);

  const handleNoteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleNoteSave();
      return;
    }
    // Backspace 清空备注时删除备注
    if (e.key === 'Backspace' && editNoteValue === '') {
      e.preventDefault();
      onNoteChange?.(undefined);
      onEndEditNote?.();
      return;
    }
  }, [editNoteValue, handleNoteSave, onNoteChange, onEndEditNote]);

  return (
    <div 
      ref={containerRef}
      className={cn(
        "relative flex flex-col min-w-[20px] max-w-[600px]", 
        className
      )}
      onDoubleClick={handleDoubleClick}
    >
      {/* Icon + Text Row */}
      <div className="relative flex items-center gap-1">
        {icon && <span className="flex-shrink-0 text-base leading-none select-none">{icon}</span>}
        <div className="relative flex-1 min-w-0">
        {/* Structural Anchor: Maintains layout size based on ORIGINAL text */}
        {!isEditing && reciteMode && blankedRanges && blankedRanges.length > 0 ? (
          <BlankedText
            text={text || t('node.unnamed')}
            blankedRanges={blankedRanges}
            revealedIndices={revealedIndices}
            reciteMode={reciteMode}
            onRevealBlank={onRevealBlank}
            onAddBlank={onAddBlank}
            onRemoveBlank={onRemoveBlank}
            className={cn(
              "inline-block whitespace-nowrap px-1 min-h-[1.2em] rounded-sm",
              isCompleted && "line-through text-[var(--mm-text-muted)]",
            )}
            style={{ backgroundColor: bgColor ? `${bgColor}85` : undefined }}
          />
        ) : !isEditing && reciteMode ? (
          <BlankedText
            text={text || t('node.unnamed')}
            blankedRanges={[]}
            reciteMode={reciteMode}
            onAddBlank={onAddBlank}
            className={cn(
              "inline-block whitespace-nowrap px-1 min-h-[1.2em] rounded-sm",
              isCompleted && "line-through text-[var(--mm-text-muted)]",
            )}
            style={{ backgroundColor: bgColor ? `${bgColor}85` : undefined }}
          />
        ) : (
          <InlineLatex
            text={text || t('node.unnamed')}
            className={cn(
              "inline-block px-1 min-h-[1.2em] select-none opacity-0 rounded-sm",
              !containsLatex(text) && "whitespace-nowrap",
              !isEditing && "opacity-100",
              isCompleted && !isEditing && "line-through text-[var(--mm-text-muted)]",
            )}
            style={{ backgroundColor: bgColor ? `${bgColor}85` : undefined }}
          />
        )}

        {/* Editing State */}
        {isEditing && (
          <>
            {/* Measurement Span (Hidden): Calculates dynamic width of INPUT text */}
            <span 
              ref={measureRef} 
              className="absolute invisible pointer-events-none whitespace-pre px-1 font-inherit text-inherit"
              aria-hidden="true"
            >
              {editValue || t('node.unnamed')}
            </span>

            {/* Actual Input: Absolute positioning to float over without affecting layout */}
            <TextareaAutosize
            ref={inputRef as any}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown as any}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: inputWidth,
              left: isRoot ? '50%' : '0',
              transform: isRoot ? 'translateX(-50%)' : 'none',
              // 确保样式与显示文本完全一致，避免跳动
              fontFamily: 'inherit',
              fontSize: 'inherit',
              fontWeight: 'inherit',
              lineHeight: 'inherit',
              letterSpacing: 'inherit',
              backgroundColor: bgColor ? `${bgColor}85` : undefined,
            }}  
              className={cn(
                "absolute top-0 h-full resize-none overflow-hidden block",
                "nopan nodrag",  // 阻止 ReactFlow 拖拽/平移，允许文本选择
                "bg-[var(--mm-bg-elevated)] shadow-[var(--mm-shadow-sm)] rounded-sm",
                "border-none outline-none ring-0 focus:ring-0",
                "text-inherit px-1", // 移除 font-inherit，使用 inline style 控制
                "placeholder:text-[var(--mm-text-muted)]",
                isRoot ? "text-center" : "text-left",
                "z-10"
              )}
              placeholder={text || t('node.unnamed')}
            />
          </>
        )}
      </div>
      </div>

      {/* Note Row */}
      {isEditingNote ? (
        <textarea
          ref={noteRef}
          value={editNoteValue}
          onChange={(e) => {
            setEditNoteValue(e.target.value);
            // 自动调整高度
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
            "nopan nodrag",  // 阻止 ReactFlow 拖拽/平移，允许文本选择
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
            isRoot ? "text-center" : "text-left",
            isCompleted && "line-through opacity-70"
          )}
        />
      ) : null}

      {/* Refs Row */}
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

