import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { BlankedText } from '../../shared/BlankedText';
import { InlineLatex } from '../../shared/InlineLatex';
import { containsLatex } from '../../../utils/renderLatex';
import type { BlankRange, MindMapImage, MindMapNodeRef } from '../../../types';
import { getMindMapPreferences } from '../../../utils/mindmapPreferences';
import { NodeRefList } from '../../shared/NodeRefCard';
import { useTextSelectionBubble } from '../../../hooks/useTextSelectionBubble';
import { useImeCompositionGuard } from '../../../hooks/useImeCompositionGuard';
import { consumePendingTypeToEditChar } from '../../../hooks/useMindMapKeyboard';
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
  nodeId?: string;
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

interface NodeTitleEditorProps {
  nodeId?: string;
  text: string;
  unnamedLabel: string;
  reciteMode: boolean;
  isBold: boolean;
  blankedRanges?: BlankRange[];
  onEmptyCommit?: () => void;
  onTextChange?: (text: string) => void;
  onCommitLiveText?: (text: string) => void;
  onEndEdit?: () => void;
  onCommitAndCreateSibling?: () => void;
  onCommitAndCreateChild?: () => void;
  onCommitAndEditNote?: () => void;
  onAddBlank?: (range: BlankRange) => void;
  onRemoveBlank?: (rangeIndex: number) => void;
  onToggleBold?: () => void;
}

const NodeTitleEditor: React.FC<NodeTitleEditorProps> = ({
  nodeId,
  text,
  unnamedLabel,
  reciteMode,
  isBold,
  blankedRanges,
  onEmptyCommit,
  onTextChange,
  onCommitLiveText,
  onEndEdit,
  onCommitAndCreateSibling,
  onCommitAndCreateChild,
  onCommitAndEditNote,
  onAddBlank,
  onRemoveBlank,
  onToggleBold,
}) => {
  const { t } = useTranslation('mindmap');
  const [editValue, setEditValue] = useState(text);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleCanceledRef = useRef(false);
  const originalTextRef = useRef(text);
  const titleIme = useImeCompositionGuard();

  const {
    handleMouseUp: handleEditSelectionMouseUp,
    bubble: editSelectionBubble,
    close: closeEditSelectionBubble,
  } = useTextSelectionBubble({
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

  useLayoutEffect(() => {
    titleCanceledRef.current = false;
    const pending = nodeId ? consumePendingTypeToEditChar(nodeId) : null;
    if (pending !== null) {
      setEditValue(pending);
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.value = pending;
        inputRef.current.setSelectionRange(pending.length, pending.length);
      }
      return;
    }
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [nodeId]);

  const commitText = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed === '') {
      setEditValue(text || '');
    } else if (trimmed !== text) {
      onTextChange?.(trimmed);
    }
  }, [editValue, text, onTextChange]);

  const handleSave = useCallback(() => {
    if (titleCanceledRef.current) return;
    // 新建后从未输入内容的空节点：失焦时交由壳层处理（通常删除空节点），
    // 壳层自带 editingNodeId 守卫，连续建点（Enter 后旧 textarea blur）不受影响
    if (editValue.trim() === '' && text.trim() === '' && onEmptyCommit) {
      onEmptyCommit();
      return;
    }
    commitText();
    onEndEdit?.();
  }, [commitText, editValue, text, onEmptyCommit, onEndEdit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // IME 组字中 Enter/Tab/Escape 属于输入法确认键，不得触发提交/建点
    if (titleIme.isComposingKeyEvent(e)) return;

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
      titleCanceledRef.current = true;
      if (editValue.trim() === '' && text.trim() === '' && onEmptyCommit) {
        onEmptyCommit();
        requestAnimationFrame(() => { titleCanceledRef.current = false; });
        return;
      }
      setEditValue(originalTextRef.current);
      onEndEdit?.();
      requestAnimationFrame(() => { titleCanceledRef.current = false; });
    }
  }, [titleIme, commitText, editValue, text, onEmptyCommit, onEndEdit, onCommitAndCreateSibling, onCommitAndCreateChild, onCommitAndEditNote]);

  // 镜像文本驱动宽高：textarea 绝对定位覆盖，彻底绕开原生 <textarea cols=20> 固定固有宽度
  const mirrorText = editValue
    ? (editValue.endsWith('\n') ? `${editValue}\u200b` : editValue)
    : (text || unnamedLabel || '\u200b');

  return (
    <>
      <div className="mm-title-editor-wrap relative grid w-full min-w-0 max-w-full">
        <span
          aria-hidden="true"
          data-testid="mm-title-editor-mirror"
          className="mm-node-text mm-title-editor-mirror col-start-1 row-start-1 invisible whitespace-pre-wrap break-words px-1 min-h-[1.2em] pointer-events-none select-none text-center"
        >
          {mirrorText}
        </span>
        <textarea
          ref={inputRef}
          rows={1}
          aria-label={t('contextMenu.edit')}
          value={editValue}
          onChange={(e) => {
            titleCanceledRef.current = false;
            closeEditSelectionBubble();
            setEditValue(e.target.value);
          }}
          onBlur={handleSave}
          onCompositionStart={titleIme.onCompositionStart}
          onCompositionEnd={titleIme.onCompositionEnd}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          onMouseUp={handleEditSelectionMouseUp}
          onTouchEnd={handleEditSelectionMouseUp}
          placeholder={text || unnamedLabel}
          className={cn(
            'mm-title-editor-input nopan nodrag absolute inset-0 block w-full h-full resize-none overflow-hidden bg-transparent px-1',
            'rounded-sm border-none outline-none ring-0 focus:ring-0',
            'whitespace-pre-wrap break-words text-inherit placeholder:[color:color-mix(in_srgb,currentColor_68%,transparent)]',
            'text-center',
          )}
          style={{ font: 'inherit', letterSpacing: 'inherit', lineHeight: 'inherit' }}
        />
      </div>
      {editSelectionBubble}
    </>
  );
};

interface NodeNoteEditorProps {
  note?: string;
  isRoot: boolean;
  onNoteChange?: (note: string | undefined) => void;
  onEndEditNote?: () => void;
}

const NodeNoteEditor: React.FC<NodeNoteEditorProps> = ({
  note,
  isRoot,
  onNoteChange,
  onEndEditNote,
}) => {
  const { t } = useTranslation('mindmap');
  const [editNoteValue, setEditNoteValue] = useState(note || '');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteCanceledRef = useRef(false);
  const noteIme = useImeCompositionGuard();
  const noteSavingRef = useRef(false);

  useEffect(() => {
    if (noteRef.current) {
      noteCanceledRef.current = false;
      noteRef.current.focus();
      noteRef.current.style.height = 'auto';
      noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
    }
  }, []);

  const handleNoteSave = useCallback(() => {
    if (noteCanceledRef.current || noteSavingRef.current) return;
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

  const handleNoteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (noteIme.isComposingKeyEvent(e)) return;

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      handleNoteSave();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      noteCanceledRef.current = true;
      setEditNoteValue(note || '');
      onEndEditNote?.();
      requestAnimationFrame(() => { noteCanceledRef.current = false; });
      return;
    }
    if (e.key === 'Backspace' && editNoteValue === '') {
      e.preventDefault();
      onNoteChange?.(undefined);
      onEndEditNote?.();
      return;
    }
  }, [noteIme, editNoteValue, handleNoteSave, note, onNoteChange, onEndEditNote]);

  return (
    <textarea
      ref={noteRef}
      value={editNoteValue}
      onChange={(e) => {
        noteCanceledRef.current = false;
        setEditNoteValue(e.target.value);
        if (noteRef.current) {
          noteRef.current.style.height = 'auto';
          noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
        }
      }}
      onBlur={handleNoteSave}
      onCompositionStart={noteIme.onCompositionStart}
      onCompositionEnd={noteIme.onCompositionEnd}
      onKeyDown={handleNoteKeyDown}
      onClick={(e) => e.stopPropagation()}
      placeholder={t('contextMenu.addNote')}
      className={cn(
        "text-xs px-1 mt-0.5 leading-tight resize-none",
        "nopan nodrag",
        "bg-[var(--mm-bg-elevated)] shadow-[var(--mm-shadow-sm)] rounded-sm",
        "border-none outline-none ring-0 focus:ring-0",
        "text-[var(--mm-text)] placeholder:text-[var(--mm-text-muted)]",
        "min-w-[80px] min-h-[1.5em] w-full",
        isRoot ? "text-center" : "text-left",
      )}
      rows={1}
    />
  );
};

const NodeImageLightbox: React.FC<{ image: MindMapImage; onClose: () => void }> = ({
  image,
  onClose,
}) => {
  const { t } = useTranslation('mindmap');

  useEffect(() => {
    const handleLightboxKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleLightboxKeyDown, true);
    return () => window.removeEventListener('keydown', handleLightboxKeyDown, true);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name || t('node.imageAlt', { defaultValue: '节点图片' })}
      data-testid="mm-image-lightbox"
      className="mindmap-container fixed inset-0 z-modal flex flex-col items-center justify-center bg-[hsl(var(--shadow-base)/0.72)] p-6"
      style={{ background: 'hsl(var(--shadow-base) / 0.72)' }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      <button
        type="button"
        data-testid="mm-image-lightbox-close"
        aria-label={t('actions.close', { defaultValue: '关闭' })}
        className="fixed top-4 right-4 inline-flex items-center justify-center w-9 h-9 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:min-h-11 rounded-full bg-[var(--mm-bg-elevated)] text-[var(--mm-text)] border border-[var(--mm-border)] shadow-[0_4px_16px_hsl(var(--shadow-base)/0.28)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))]"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X size={18} weight="bold" aria-hidden="true" />
      </button>
      <div
        className="relative flex flex-col items-center max-w-[92vw] max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={image.src}
          alt={image.name || t('node.imageAlt', { defaultValue: '节点图片' })}
          draggable={false}
          className="max-w-[90vw] max-h-[82vh] object-contain rounded-lg shadow-[0_12px_36px_hsl(var(--shadow-base)/0.38)]"
        />
        {image.name && (
          <div className="mt-2 px-3 py-1 rounded-full bg-[var(--mm-bg-elevated)] text-xs text-[var(--mm-text)] border border-[var(--mm-border)] max-w-[80vw] truncate">
            {image.name}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

const NodeContentComponent: React.FC<NodeContentProps> = ({
  nodeId,
  text,
  note,
  refs,
  images,
  icon,
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
  const [previewImage, setPreviewImage] = useState<MindMapImage | null>(null);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (reciteMode) return;
    onStartEdit?.();
  }, [onStartEdit, reciteMode]);

  const handleClosePreview = useCallback(() => setPreviewImage(null), []);

  const unnamedLabel = !text || isEditing ? t('node.unnamed') : '';
  const displayText = text || unnamedLabel;
  const hasLatex = containsLatex(text);
  const hasBlanks = (blankedRanges?.length ?? 0) > 0;
  const usePlainText = !reciteMode && !hasBlanks && !hasLatex;
  const displayWithBlanks = reciteMode || !!onAddBlank;
  // LaTeX 与挖空共存降级策略：
  // - 已有挖空区间（含背诵模式）：走 BlankedText（遮罩 / 挖空管理正确性优先），公式显示为原文（降级）
  // - 仅 LaTeX 无挖空：走 InlineLatex 渲染公式——背诵模式下这类节点没有可遮的内容，
  //   此前也走 BlankedText，一进背诵整张图的公式都变回 $…$ 源码
  //   （编辑态选区气泡仍可新增挖空）
  const useBlankedDisplay = !usePlainText && displayWithBlanks && (hasBlanks || !hasLatex);
  const titleTextClassName = cn(
    'mm-node-text inline-block whitespace-pre-wrap break-words px-1 min-h-[1.2em] rounded-sm',
    !text && '[color:color-mix(in_srgb,currentColor_68%,transparent)]',
    isCompleted && 'line-through [color:color-mix(in_srgb,currentColor_68%,transparent)]',
  );

  const noteClassName = !isEditingNote && note
    ? cn(
        "text-xs [color:color-mix(in_srgb,currentColor_68%,transparent)] px-1 mt-0.5 whitespace-pre-wrap leading-tight",
        getMindMapPreferences().descriptionPreview === 'first-line' && "mm-note-first-line",
        isRoot ? "text-center" : "text-left",
        isCompleted && "line-through opacity-70",
      )
    : undefined;

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
            <button
              key={index}
              type="button"
              className="nodrag nopan inline-flex rounded overflow-hidden cursor-zoom-in border border-[var(--mm-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[hsl(var(--ring))]"
              aria-label={t('node.previewImage', {
                name: image.name || t('node.imageAlt', { defaultValue: '节点图片' }),
                defaultValue: '预览图片',
              })}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPreviewImage(image);
              }}
            >
              <img
                src={image.src}
                alt={image.name || t('node.imageAlt', { defaultValue: '节点图片' })}
                title={image.name}
                loading="lazy"
                draggable={false}
                className="block object-contain select-none"
                style={{
                  // 保留导入宽高比例信息但限制缩略尺寸，超限时按 max 约束等比缩放
                  maxWidth: 160,
                  maxHeight: 90,
                  ...(image.width && image.height
                    ? { aspectRatio: `${image.width} / ${image.height}` }
                    : {}),
                }}
              />
            </button>
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
            <NodeTitleEditor
              nodeId={nodeId}
              text={text}
              unnamedLabel={unnamedLabel}
              reciteMode={reciteMode}
              isBold={isBold}
              blankedRanges={blankedRanges}
              onEmptyCommit={onEmptyCommit}
              onTextChange={onTextChange}
              onCommitLiveText={onCommitLiveText}
              onEndEdit={onEndEdit}
              onCommitAndCreateSibling={onCommitAndCreateSibling}
              onCommitAndCreateChild={onCommitAndCreateChild}
              onCommitAndEditNote={onCommitAndEditNote}
              onAddBlank={onAddBlank}
              onRemoveBlank={onRemoveBlank}
              onToggleBold={onToggleBold}
            />
          ) : usePlainText ? (
            <span
              className={titleTextClassName}
              style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
            >
              {displayText}
            </span>
          ) : useBlankedDisplay ? (
            <BlankedText
              text={displayText}
              blankedRanges={blankedRanges || []}
              revealedIndices={revealedIndices}
              reciteMode={reciteMode}
              allowSelectionActions={false}
              isBold={isBold}
              onRevealBlank={onRevealBlank}
              onBlanksPresented={onBlanksPresented}
              onAddBlank={text.length > 0 ? onAddBlank : undefined}
              onRemoveBlank={onRemoveBlank}
              onToggleBold={onToggleBold}
              className={titleTextClassName}
            />
          ) : (
            <InlineLatex
              text={displayText}
              className={cn(titleTextClassName, 'select-none')}
            />
          )}
        </div>
      {decorations?.href && !isEditing && <NodeLinkButton href={decorations.href} />}
      </div>

      {isEditingNote ? (
        <NodeNoteEditor
          note={note}
          isRoot={isRoot}
          onNoteChange={onNoteChange}
          onEndEditNote={onEndEditNote}
        />
      ) : note ? (
        containsLatex(note) ? (
          <InlineLatex text={note} className={noteClassName} />
        ) : (
          <span className={noteClassName}>{note}</span>
        )
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

      {previewImage && (
        <NodeImageLightbox image={previewImage} onClose={handleClosePreview} />
      )}
    </div>
  );
};

export const NodeContent = React.memo(NodeContentComponent);
NodeContent.displayName = 'NodeContent';
