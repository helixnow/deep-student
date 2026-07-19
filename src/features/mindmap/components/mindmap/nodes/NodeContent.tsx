import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BlankedText } from '../../shared/BlankedText';
import { InlineLatex } from '../../shared/InlineLatex';
import { containsLatex } from '../../../utils/renderLatex';
import TextareaAutosize from 'react-textarea-autosize';
import type { BlankRange, MindMapNodeRef } from '../../../types';
import { getMindMapPreferences } from '../../../utils/mindmapPreferences';
import { NodeRefList } from '../../shared/NodeRefCard';
import { useTextSelectionBubble } from '../../../hooks/useTextSelectionBubble';

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
  isBold?: boolean;
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
  onTextChange,
  onCommitLiveText,
  onNoteChange,
  onStartEdit,
  onEndEdit,
  onEndEditNote,
  onCommitAndCreateSibling,
  onCommitAndCreateChild,
  onRevealBlank,
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
    commitText();
    onEndEdit?.();
  }, [commitText, onEndEdit]);

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
      setEditValue(text);
      onEndEdit?.();
    }
  }, [commitText, text, onEndEdit, onCommitAndCreateSibling, onCommitAndCreateChild]);

  const handleNoteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      <div className="relative flex items-center gap-1">
        {icon && <span className="flex-shrink-0 text-base leading-none select-none">{icon}</span>}
        <div className="relative flex-1 min-w-0">
        {displayWithBlanks && !(hasLatex && !reciteMode) ? (
          <BlankedText
            text={text || t('node.unnamed')}
            blankedRanges={blankedRanges || []}
            revealedIndices={revealedIndices}
            reciteMode={reciteMode}
            allowSelectionActions={!reciteMode}
            isBold={isBold}
            onRevealBlank={onRevealBlank}
            onAddBlank={text.length > 0 ? onAddBlank : undefined}
            onRemoveBlank={onRemoveBlank}
            onToggleBold={onToggleBold}
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
              !hasLatex && "whitespace-nowrap",
              !isEditing && "opacity-100",
              isCompleted && !isEditing && "line-through text-[var(--mm-text-muted)]",
            )}
            style={{ backgroundColor: bgColor ? `${bgColor}85` : undefined }}
          />
        )}

        {isEditing && (
          <>
            <span
              ref={measureRef}
              className="absolute invisible pointer-events-none whitespace-pre px-1 font-inherit text-inherit"
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
