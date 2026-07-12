import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  DndContext,
  closestCenter,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  DragMoveEvent,
  DragOverlay,
  MeasuringStrategy,
  UniqueIdentifier,
  defaultDropAnimationSideEffects,
  DropAnimation,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { useTouchFriendlyDndSensors } from '@/hooks/useTouchFriendlyDndSensors';
import { CSS } from '@dnd-kit/utilities';
import { useMindMapStore, useMindMapStoreApi } from '../store';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { 
  CaretRight, 
  CaretDown, 
  Plus,
  DotsThree,
  Trash,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextT,
  Smiley,
  Link,
  Link as LinkIcon,
  Pencil,
  CheckCircle,
  Circle,
  Palette,
  Highlighter,
  House,
  DotsSixVertical,
  MagnifyingGlassPlus,
  Note,
  Copy,
  Scissors,
  ClipboardText,
  X,
} from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import type { MindMapNode, BlankRange } from '../types';
import { NodeRefList } from '../components/shared/NodeRefCard';
import { MindMapResourcePicker } from '../components/mindmap/MindMapResourcePicker';
import { findNodeById, isDescendantOf } from '../utils/node/find';
import { requestOutlineCaret, takeOutlineCaret } from '../utils/outlineCaret';
import { BlankedText } from '../components/shared/BlankedText';
import { InlineLatex } from '../components/shared/InlineLatex';
import { containsLatex } from '../utils/renderLatex';
import { QUICK_TEXT_COLORS, QUICK_BG_COLORS } from '../constants';
import { collectTopLevelNodeIds, getAncestors } from '../utils/node/traverse';
import { openNodeRef } from '../utils/openNodeRef';
import { useTextSelectionBubble } from '../hooks/useTextSelectionBubble';
import {
  flattenOutlineTree,
  resolveSearchPathIds,
  splitSearchHighlights,
  type OutlineFlatNode,
} from '../utils/searchFilter';
import { resolveVisibleFocusId } from '../utils/hideCompleted';
import TextareaAutosize from 'react-textarea-autosize';
import { CustomScrollArea } from '@/components/custom-scroll-area';

const LEVEL_INDENT = 28; // Increased indent for better hierarchy
const BASE_PADDING = 12;

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.4' } },
  }),
};

type DropPosition = 'before' | 'after' | 'inside';

type FlatNode = OutlineFlatNode;

const SearchHighlightedText: React.FC<{
  text: string;
  query: string;
  enabled?: boolean;
}> = ({ text, query, enabled = true }) => {
  if (!enabled || !query.trim()) return <>{text}</>;
  const parts = splitSearchHighlights(text, query);
  return (
    <>
      {parts.map((part, i) =>
        part.match ? (
          <mark key={i} className="search-text-match">{part.text}</mark>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
};

/** 基于当前可见 flat 列表做 Shift 范围选 */
function getVisibleRangeIds(
  flatNodes: FlatNode[],
  fromId: string,
  toId: string,
  options?: { excludeRoot?: boolean; indexById?: ReadonlyMap<string, number> }
): string[] {
  const fromIdx = options?.indexById?.get(fromId) ?? flatNodes.findIndex((n) => n.id === fromId);
  const toIdx = options?.indexById?.get(toId) ?? flatNodes.findIndex((n) => n.id === toId);
  if (fromIdx < 0 || toIdx < 0) return [toId];
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  return flatNodes
    .slice(start, end + 1)
    .filter((n) => !(options?.excludeRoot && n.level === 0))
    .map((n) => n.id);
}

// 扁平化节点树（含层级信息，专用于大纲视图）
function flattenTree(
  root: MindMapNode,
  options: { hideCompleted?: boolean; pathIds?: Set<string> | null } = {}
): FlatNode[] {
  return flattenOutlineTree(root, options);
}

// 获取从根节点到目标节点的路径（含目标节点自身）
function getPathToNode(root: MindMapNode, targetId: string): MindMapNode[] {
  const ancestors = getAncestors(root, targetId);
  const target = findNodeById(root, targetId);
  return target ? [...ancestors, target] : ancestors;
}

// 可排序节点组件
const SortableOutlineNode: React.FC<{
  flatNode: FlatNode;
  isRoot: boolean;
  overId: UniqueIdentifier | null;
  dropPosition: DropPosition;
  activeId: UniqueIdentifier | null;
  projectedLevel?: number | null;
  isEntering?: boolean;
  isSelected?: boolean;
  isMultiSelectActive?: boolean;
  onRowSelect?: (nodeId: string, e: React.MouseEvent) => void;
  onNavigate?: (direction: 'up' | 'down') => void;
  onZoomIn?: (nodeId: string) => void;
  onOpenResourcePicker?: (nodeId: string) => void;
  onBatchIndent?: () => void;
  onBatchOutdent?: () => void;
  onBatchDelete?: () => void;
  searchResultIds: ReadonlySet<string>;
  currentSearchResultId: string | null;
  searchQuery: string;
}> = ({
  flatNode,
  isRoot,
  overId,
  dropPosition,
  activeId,
  projectedLevel,
  isEntering,
  isSelected,
  isMultiSelectActive,
  onRowSelect,
  onNavigate,
  onZoomIn,
  onOpenResourcePicker,
  onBatchIndent,
  onBatchOutdent,
  onBatchDelete,
  searchResultIds,
  currentSearchResultId,
  searchQuery,
}) => {
  const { t } = useTranslation('mindmap');
  const { node, level, parentId, indexInParent } = flatNode;
  
  const updateNode = useMindMapStore(state => state.updateNode);
  const addNode = useMindMapStore(state => state.addNode);
  const deleteNode = useMindMapStore(state => state.deleteNode);
  const moveNode = useMindMapStore(state => state.moveNode);
  const toggleCollapse = useMindMapStore(state => state.toggleCollapse);
  const focusedNodeId = useMindMapStore(state => state.focusedNodeId);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  const indentNode = useMindMapStore(state => state.indentNode);
  const outdentNode = useMindMapStore(state => state.outdentNode);
  const splitNode = useMindMapStore(state => state.splitNode);
  const mergeWithPrevious = useMindMapStore(state => state.mergeWithPrevious);
  const copyNodes = useMindMapStore(state => state.copyNodes);
  const cutNodes = useMindMapStore(state => state.cutNodes);
  const pasteNodes = useMindMapStore(state => state.pasteNodes);
  const clipboard = useMindMapStore(state => state.clipboard);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  const revealedBlanks = useMindMapStore(state => state.revealedBlanks);
  const revealBlank = useMindMapStore(state => state.revealBlank);
  const addBlankRange = useMindMapStore(state => state.addBlankRange);
  const removeBlankRange = useMindMapStore(state => state.removeBlankRange);
  const removeNodeRef = useMindMapStore(state => state.removeNodeRef);

  const toggleBold = useCallback(() => {
    updateNode(node.id, {
      style: {
        ...node.style,
        fontWeight: node.style?.fontWeight === 'bold' ? undefined : 'bold',
      },
    });
  }, [node.id, node.style, updateNode]);

  const inputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [localText, setLocalText] = useState(node.text || '');
  const [localNote, setLocalNote] = useState(node.note || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingNote, setIsEditingNote] = useState(false);
  const localTextRef = useRef(localText);
  localTextRef.current = localText;
  const skipNextBlurCommitRef = useRef(false);

  const { handleMouseUp: handleEditSelectionMouseUp, bubble: editSelectionBubble } =
    useTextSelectionBubble({
      blankedRanges: node.blankedRanges,
      isBold: node.style?.fontWeight === 'bold',
      onCommitLiveText: !reciteMode
        ? (text) => {
            localTextRef.current = text;
            setLocalText(text);
            if (text !== (node.text || '')) {
              updateNode(node.id, { text }, { preserveBlankedRanges: true, skipHistory: true });
            }
          }
        : undefined,
      onAddBlank: !reciteMode ? (range) => addBlankRange(node.id, range) : undefined,
      onRemoveBlank: !reciteMode ? (rangeIndex) => removeBlankRange(node.id, rangeIndex) : undefined,
      onToggleBold: !reciteMode ? toggleBold : undefined,
    });
  
  const isFocused = focusedNodeId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const isCollapsed = node.collapsed;
  const isSearchMatch = searchResultIds.has(node.id);
  const isCurrentSearchMatch = isSearchMatch && currentSearchResultId === node.id;
  const showTextHighlight = isSearchMatch && !!searchQuery.trim() && !reciteMode;
  const isOver = overId === node.id;
  const isBeingDragged = activeId === node.id;
  const multiSelectBlocksEdit = !!isMultiSelectActive;
  
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: node.id,
    disabled: isRoot,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  useEffect(() => {
    if (isFocused && !isEditingNote && !reciteMode && !multiSelectBlocksEdit) {
      if (inputRef.current) {
        inputRef.current.focus();
        const caret = takeOutlineCaret(node.id);
        if (caret !== null) {
          const el = inputRef.current;
          const pos = Math.max(0, Math.min(caret, el.value.length));
          el.setSelectionRange(pos, pos);
        }
        // ★ 空间锚定：确保焦点节点在可视区域内
        inputRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (!isEditing) {
        // ★ 非编辑态渲染为静态 div（纯文本/LaTeX 均无 input 可聚焦）。
        // 进入编辑态让 input 挂载，下一轮 effect 完成聚焦。
        // 否则 ArrowUp/Down 导航到该节点时 DOM 焦点仍滞留在旧 input，
        // 后续按键继续由旧节点处理，键盘导航在第二个节点处断裂。
        //
        // 仅当焦点空闲或在另一个大纲节点输入框（键盘导航中）时才接管，
        // 避免抢走搜索框/备注框等其它输入控件的焦点。
        const active = globalThis.document.activeElement as HTMLElement | null;
        const isOtherInputFocused =
          !!active &&
          active !== globalThis.document.body &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) &&
          active.dataset.mmOutlineInput !== 'true';
        if (!isOtherInputFocused) {
          setIsEditing(true);
        }
      }
    }
  }, [isFocused, isEditingNote, isEditing, reciteMode, multiSelectBlocksEdit, node.id]);

  useEffect(() => {
    if (isEditingNote && noteRef.current) {
      noteRef.current.focus();
      // Auto-resize height
      noteRef.current.style.height = 'auto';
      noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
    }
  }, [isEditingNote]);

  useEffect(() => {
    if (!isEditing && localText !== (node.text || '')) {
      setLocalText(node.text || '');
    }
  }, [node.text, isEditing, localText]);

  useEffect(() => {
    if (!isEditingNote && localNote !== (node.note || '')) {
      setLocalNote(node.note || '');
    }
  }, [node.note, isEditingNote, localNote]);

  const commitText = useCallback((nextText?: string) => {
    // 用 ref：拆分后 blur 时闭包里的 localText 可能仍是拆分前全文
    const trimmed = (nextText ?? localTextRef.current ?? '').trim();
    if (trimmed !== (node.text || '')) {
      updateNode(node.id, { text: trimmed });
    }
  }, [node.id, node.text, updateNode]);

  const commitNote = useCallback((nextNote?: string) => {
    const val = nextNote ?? localNote;
    if (val !== (node.note || '')) {
      updateNode(node.id, { note: val });
    }
  }, [localNote, node.id, node.note, updateNode]);

  // 多选时退出标题/备注编辑，避免与批量快捷键冲突
  useEffect(() => {
    if (multiSelectBlocksEdit && isEditing) {
      commitText();
      setIsEditing(false);
    }
    if (multiSelectBlocksEdit && isEditingNote) {
      commitNote();
      setIsEditingNote(false);
    }
  }, [multiSelectBlocksEdit, isEditing, isEditingNote, commitText, commitNote]);

  const handleRowMouseDown = useCallback((e: React.MouseEvent) => {
    // 修饰键多选在行容器上处理；编辑态内普通点击不劫持文本选区
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
    }
  }, []);

  const handleRowClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      onRowSelect?.(node.id, e);
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('textarea, input, [contenteditable="true"]')) {
      return;
    }
    onRowSelect?.(node.id, e);
  }, [node.id, onRowSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // 多选时：批量删 / 缩进 / 反缩进
    if (multiSelectBlocksEdit) {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        onBatchIndent?.();
        return;
      }
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        onBatchOutdent?.();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        onBatchDelete?.();
        return;
      }
    }

    // Add/Edit Note: Shift + Mod + Enter（须先于 Mod+Enter）
    if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      setIsEditingNote(true);
      return;
    }

    // Internal Newline: Shift + Enter
    if (e.shiftKey && e.key === 'Enter') {
      // 允许 react-textarea-autosize 默认行为（换行）
      return;
    }

    // Add Child: Mod + Enter
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      commitText();
      const newId = addNode(node.id, 0);
      if (node.collapsed) toggleCollapse(node.id);
      setTimeout(() => setFocusedNodeId(newId), 0);
      return;
    }

    // Enter（无 mod/shift）：行中拆分 / 行末新建同级 / 行首拆出上方空节点
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart ?? localText.length;
      const end = target.selectionEnd ?? start;
      const offset = start === end ? start : localText.length;
      const textLen = localText.length;

      // 末尾（或有选区）：保持现有「新建同级」
      if (offset >= textLen) {
        commitText();
        if (isRoot) {
          const newId = addNode(node.id, 0);
          setTimeout(() => setFocusedNodeId(newId), 0);
        } else if (parentId) {
          const newId = addNode(parentId, indexInParent + 1);
          setTimeout(() => setFocusedNodeId(newId), 0);
        }
        return;
      }

      // 行中 / 行首：splitNode（传 localText 避免未 commit 丢字）
      const leftText = localText.slice(0, offset);
      localTextRef.current = leftText;
      setLocalText(leftText);
      skipNextBlurCommitRef.current = true;
      setIsEditing(false);
      const newId = splitNode(node.id, offset, localText);
      if (!newId) return;

      // 行首：原节点变空并保持焦点（上方空行手感）；否则焦点到新节点开头
      if (offset === 0) {
        requestOutlineCaret(node.id, 0);
        setFocusedNodeId(node.id);
        setIsEditing(true);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(0, 0);
          takeOutlineCaret(node.id);
        });
      } else {
        requestOutlineCaret(newId, 0);
        setTimeout(() => setFocusedNodeId(newId), 0);
      }
      return;
    }
    
    // Indent: Tab
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      commitText();
      if (!isRoot) indentNode(node.id);
      return;
    }
    
    // Outdent: Shift + Tab
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      commitText();
      if (!isRoot) outdentNode(node.id);
      return;
    }
    
    // Delete: Backspace（空文本删节点；非空且光标在 0 则合并上一节点）
    if (e.key === 'Backspace' && !isRoot) {
      const target = e.currentTarget;
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      if (localText === '') {
        e.preventDefault();
        deleteNode(node.id);
        return;
      }
      if (start === 0 && end === 0) {
        e.preventDefault();
        skipNextBlurCommitRef.current = true;
        setIsEditing(false);
        const result = mergeWithPrevious(node.id, localText);
        if (!result) return;
        requestOutlineCaret(result.mergedIntoId, result.cursorOffset);
        setTimeout(() => setFocusedNodeId(result.mergedIntoId), 0);
        return;
      }
    }

    // Move Up: Mod + ArrowUp
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
      e.preventDefault();
      if (parentId) {
        moveNode(node.id, parentId, Math.max(0, indexInParent - 1));
      }
      return;
    }

    // Move Down: Mod + ArrowDown
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
      e.preventDefault();
      if (parentId) {
        moveNode(node.id, parentId, indexInParent + 1);
      }
      return;
    }

    // Collapse: Mod + [
    if ((e.metaKey || e.ctrlKey) && e.key === '[') {
      e.preventDefault();
      if (!node.collapsed && hasChildren) toggleCollapse(node.id);
      return;
    }

    // Expand: Mod + ]
    if ((e.metaKey || e.ctrlKey) && e.key === ']') {
      e.preventDefault();
      if (node.collapsed && hasChildren) toggleCollapse(node.id);
      return;
    }

    // Navigate Up
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      commitText();
      onNavigate?.('up');
      return;
    }

    // Navigate Down
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      commitText();
      onNavigate?.('down');
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setLocalText(node.text);
      setIsEditing(false);
      // ★ 同时清除聚焦：否则 isFocused 仍为 true，focus-effect 会立即
      // 重新进入编辑态，Esc 永远退不出（LaTeX 节点旧有问题，现统一修复）
      setFocusedNodeId(null);
      inputRef.current?.blur();
    }
  }, [isRoot, parentId, indexInParent, node.id, node.text, node.collapsed, hasChildren, localText, addNode, setFocusedNodeId, indentNode, outdentNode, deleteNode, commitText, moveNode, toggleCollapse, onNavigate, multiSelectBlocksEdit, onBatchIndent, onBatchOutdent, onBatchDelete, splitNode, mergeWithPrevious]);

  const handleNoteKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setIsEditingNote(false);
      inputRef.current?.focus();
      return;
    }
    
    // Backspace on empty note -> Delete note
    if (e.key === 'Backspace' && localNote === '') {
      e.preventDefault();
      setIsEditingNote(false);
      updateNode(node.id, { note: undefined });
      inputRef.current?.focus();
      return;
    }

    // Arrow Up at start of note -> Focus title
    if (e.key === 'ArrowUp' && noteRef.current?.selectionStart === 0) {
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  const indentLevel = isRoot ? 0 : level;
  const paddingLeft = BASE_PADDING + indentLevel * LEVEL_INDENT;

  return (
    <div 
      ref={setNodeRef} 
      style={style} 
      data-node-id={node.id} 
      className={cn(
        "outline-node-row group",
        isFocused && "focused",
        isSelected && "selected",
        isSearchMatch && "search-match",
        isCurrentSearchMatch && "search-match-current",
        isRoot && "root",
        isDragging && "is-dragging",
        isEntering && "entering"
      )}
      onMouseDown={handleRowMouseDown}
      onClick={handleRowClick}
    >
      {/* 缩进参考线 - 常驻弱显示，悬停或焦点路径上加深 */}
      {!isRoot && indentLevel > 0 && Array.from({ length: indentLevel }).map((_, i) => {
        return (
          <div 
            key={i}
            className="indent-guide"
            style={{ left: `${BASE_PADDING + i * LEVEL_INDENT + 9}px` }}
          />
        );
      })}
      
      {/* 拖拽指示器 */}
      {isOver && dropPosition === 'before' && !isBeingDragged && (
        <>
          <div 
            className="drop-indicator"
            style={{ 
              left: `${BASE_PADDING + (projectedLevel ?? level) * LEVEL_INDENT + 9}px` 
            }}
          />
          {projectedLevel !== null && projectedLevel > level && (
            <div 
              className="drop-indicator-vertical"
              style={{
                left: `${BASE_PADDING + (projectedLevel) * LEVEL_INDENT + 9}px`,
                bottom: '0',
                height: '100%',
              }}
            />
          )}
        </>
      )}
      
      {/* 左侧控制区容器 - 包含展开三角和 Bullet */}
      <div 
        className="node-left-controls"
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        <div className="w-[18px] h-[18px] flex items-center justify-center -ml-[18px]">
          {/* 展开/折叠三角 */}
          {!isRoot && hasChildren && (
            <div 
              className={cn(
                "collapse-toggle",
                isCollapsed && "is-collapsed"
              )}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(node.id);
              }}
              title={isCollapsed ? t('actions.expand') : t('actions.collapse')}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" className="transition-transform">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          )}
        </div>

        {/* 节点 Bullet (兼作拖拽手柄) */}
        {!isRoot && (
          <div 
            className={cn("node-bullet-container", !reciteMode && "cursor-grab active:cursor-grabbing")}
            {...(!reciteMode ? attributes : {})}
            {...(!reciteMode ? listeners : {})}
            onClick={(e) => {
              e.stopPropagation();
              onZoomIn?.(node.id);
            }}
            title={`${t('outline.dragToMove')} · ${t('outline.zoomIn')}`}
          >
            <div className={cn(
              "node-bullet",
              hasChildren && "has-children",
              hasChildren && isCollapsed && "collapsed"
            )} />
          </div>
        )}
      </div>

      {/* 节点图标 */}
      {node.style?.icon && (
        <span className="flex-shrink-0 text-base leading-none pt-[5px]">{node.style.icon}</span>
      )}

      {/* 内容区域 */}
      <div
        className="flex-1 flex flex-col min-w-0 pr-2 pl-1.5 justify-center"
        onClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          setFocusedNodeId(node.id);
        }}
      >
        {reciteMode ? (
          <BlankedText
            text={node.text || (isRoot ? t('placeholder.root') : t('placeholder.node'))}
            blankedRanges={node.blankedRanges || []}
            revealedIndices={revealedBlanks[node.id]}
            reciteMode={reciteMode}
            onRevealBlank={(rangeIndex) => revealBlank(node.id, rangeIndex)}
            onAddBlank={(range) => addBlankRange(node.id, range)}
            onRemoveBlank={(rangeIndex) => removeBlankRange(node.id, rangeIndex)}
            className={cn(
              "node-input cursor-default select-text",
              isRoot && "root",
              node.completed && "line-through text-muted-foreground"
            )}
            style={{
              color: node.style?.textColor,
              fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
              fontStyle: node.style?.fontStyle === 'italic' ? 'italic' : undefined,
              textDecoration: node.style?.textDecoration && node.style.textDecoration !== 'none' ? node.style.textDecoration : undefined,
              fontSize: node.style?.headingLevel === 'h1' ? '22px' : node.style?.headingLevel === 'h2' ? '18px' : node.style?.headingLevel === 'h3' ? '16px' : undefined,
            }}
          />
        ) : isEditing ? (
        <>
        <TextareaAutosize
          ref={inputRef as any}
          data-mm-outline-input="true"
          className={cn(
            "node-input resize-none overflow-hidden block w-full",
            isRoot && "root",
            node.completed && "line-through text-muted-foreground"
          )}
          style={{
            color: node.style?.textColor,
            fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
            fontStyle: node.style?.fontStyle === 'italic' ? 'italic' : undefined,
            textDecoration: node.style?.textDecoration && node.style.textDecoration !== 'none' ? node.style.textDecoration : undefined,
            fontSize: node.style?.headingLevel === 'h1' ? '22px' : node.style?.headingLevel === 'h2' ? '18px' : node.style?.headingLevel === 'h3' ? '16px' : undefined,
          }}
          minRows={1}
          value={localText}
          onChange={(e) => setLocalText(e.target.value)}
          placeholder={isRoot ? t('placeholder.root') : t('placeholder.node')}
          onKeyDown={handleKeyDown as any}
          onFocus={() => setIsEditing(true)}
          onMouseUp={handleEditSelectionMouseUp as any}
          onBlur={() => {
            setIsEditing(false);
            if (skipNextBlurCommitRef.current) {
              skipNextBlurCommitRef.current = false;
              return;
            }
            commitText();
          }}
        />
        {editSelectionBubble}
        </>
        ) : !containsLatex(localText || '') && !showTextHighlight ? (
          <div
            className={cn(
              "node-input cursor-text",
              isRoot && "root",
              node.completed && "line-through text-muted-foreground"
            )}
            style={{
              color: node.style?.textColor,
              fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
              fontStyle: node.style?.fontStyle === 'italic' ? 'italic' : undefined,
              textDecoration: node.style?.textDecoration && node.style.textDecoration !== 'none' ? node.style.textDecoration : undefined,
              fontSize: node.style?.headingLevel === 'h1' ? '22px' : node.style?.headingLevel === 'h2' ? '18px' : node.style?.headingLevel === 'h3' ? '16px' : undefined,
            }}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) return;
              e.stopPropagation();
              onRowSelect?.(node.id, e);
              if (!isMultiSelectActive) {
                setIsEditing(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }
            }}
          >
            <BlankedText
              text={localText || (isRoot ? t('placeholder.root') : t('placeholder.node'))}
              blankedRanges={node.blankedRanges || []}
              revealedIndices={revealedBlanks[node.id]}
              reciteMode={false}
              allowSelectionActions
              isBold={node.style?.fontWeight === 'bold'}
              onAddBlank={(range) => addBlankRange(node.id, range)}
              onRemoveBlank={(rangeIndex) => removeBlankRange(node.id, rangeIndex)}
              onToggleBold={toggleBold}
              className="select-text"
              style={{
                backgroundColor: node.style?.bgColor ? `${node.style.bgColor}85` : undefined,
              }}
            />
          </div>
        ) : (
          <div
            className={cn(
              "node-input cursor-text",
              isRoot && "root",
              node.completed && "line-through text-muted-foreground"
            )}
            style={{
              color: node.style?.textColor,
              fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
              fontStyle: node.style?.fontStyle === 'italic' ? 'italic' : undefined,
              textDecoration: node.style?.textDecoration && node.style.textDecoration !== 'none' ? node.style.textDecoration : undefined,
              fontSize: node.style?.headingLevel === 'h1' ? '22px' : node.style?.headingLevel === 'h2' ? '18px' : node.style?.headingLevel === 'h3' ? '16px' : undefined,
            }}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) return;
              e.stopPropagation();
              onRowSelect?.(node.id, e);
              if (!isMultiSelectActive) {
                setIsEditing(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }
            }}
          >
            <span
              className="outline-text-highlight"
              style={{
                backgroundColor: node.style?.bgColor ? `${node.style.bgColor}85` : undefined,
              }}
            >
              {containsLatex(localText) ? (
                <InlineLatex text={localText || (isRoot ? t('placeholder.root') : t('placeholder.node'))} />
              ) : localText ? (
                <SearchHighlightedText text={localText} query={searchQuery} enabled={showTextHighlight} />
              ) : (
                <span className="text-[var(--mm-text-muted)] opacity-60">{isRoot ? t('placeholder.root') : t('placeholder.node')}</span>
              )}
            </span>
          </div>
        )}
        {node.note && !isEditingNote && (
          <div className="node-note px-[6px] pb-1 text-[13px] text-[var(--mm-text-secondary)] whitespace-pre-wrap cursor-text" onClick={() => !reciteMode && setIsEditingNote(true)}>
            {containsLatex(node.note) || !showTextHighlight ? (
              <InlineLatex text={node.note} />
            ) : (
              <SearchHighlightedText text={node.note} query={searchQuery} enabled />
            )}
          </div>
        )}
        {isEditingNote && !reciteMode && (
          <TextareaAutosize
            ref={noteRef as any}
            className="node-note-input"
            value={localNote}
            onChange={(e) => setLocalNote(e.target.value)}
            onKeyDown={handleNoteKeyDown as any}
            onBlur={() => {
              commitNote();
              setIsEditingNote(false);
            }}
            placeholder={t('placeholder.note')}
            minRows={1}
          />
        )}
        {node.refs && node.refs.length > 0 && (
          <NodeRefList
            refs={node.refs}
            onRemove={reciteMode ? undefined : (sourceId) => removeNodeRef(node.id, sourceId)}
            onClick={(sourceId) => {
              const ref = node.refs?.find((r) => r.sourceId === sourceId);
              void openNodeRef(sourceId, { type: ref?.type, name: ref?.name });
            }}
            readonly={reciteMode}
          />
        )}
      </div>

      {/* 悬停操作栏 - hidden in recite mode */}
      {!reciteMode && (
      <div className="node-actions">
        {!isRoot && (
          <>
            <NotionButton variant="ghost"
              className="action-btn"
              onClick={(e) => {
                e.stopPropagation();
                const newNodeId = addNode(node.id, 0);
                setFocusedNodeId(newNodeId);
              }}
              title={t('actions.addChild')}
            >
              <Plus className="w-4 h-4" />
            </NotionButton>
            <NotionButton variant="ghost"
              className="action-btn"
              onClick={(e) => {
                e.stopPropagation();
                onZoomIn?.(node.id);
              }}
              title={t('outline.enterFocusMode')}
            >
              <MagnifyingGlassPlus size={16} />
            </NotionButton>
            <AppMenu>
              <AppMenuTrigger asChild>
                <NotionButton variant="ghost"
                  className="action-btn"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DotsThree size={16} />
                </NotionButton>
              </AppMenuTrigger>
              <AppMenuContent align="end" className="min-w-[180px]">
                <AppMenuItem
                  icon={<Plus className="w-4 h-4" />}
                  shortcut="Tab"
                  onClick={() => {
                    const newId = addNode(node.id, 0);
                    if (node.collapsed) toggleCollapse(node.id);
                    setTimeout(() => setFocusedNodeId(newId), 0);
                  }}
                >
                  {t('actions.addChild')}
                </AppMenuItem>
                {!isRoot && parentId && (
                  <AppMenuItem
                    icon={<Plus className="w-4 h-4" />}
                    shortcut="Enter"
                    onClick={() => {
                      const newId = addNode(parentId, indexInParent + 1);
                      setTimeout(() => setFocusedNodeId(newId), 0);
                    }}
                  >
                    {t('contextMenu.addSibling')}
                  </AppMenuItem>
                )}
                <AppMenuItem
                  icon={<Note size={16} />}
                  shortcut="⇧Enter"
                  onClick={() => setIsEditingNote(true)}
                >
                  {node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<LinkIcon size={16} />}
                  onClick={() => onOpenResourcePicker?.(node.id)}
                >
                  {t('contextMenu.linkResource')}
                </AppMenuItem>
                <AppMenuSeparator />
                <AppMenuItem
                  icon={node.completed
                    ? <Circle size={16} />
                    : <CheckCircle size={16} />}
                  onClick={() => updateNode(node.id, { completed: !node.completed })}
                >
                  {node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
                </AppMenuItem>
                {/* 文本格式 B / I / U / S */}
                <div className="flex items-center gap-1 px-2 py-1">
                  <NotionButton variant="ghost"
                    className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.fontWeight === 'bold' && "bg-accent")}
                    onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, fontWeight: node.style?.fontWeight === 'bold' ? undefined : 'bold' } }); }}
                    title={t('contextMenu.bold')}
                  ><TextB size={16} /></NotionButton>
                  <NotionButton variant="ghost"
                    className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.fontStyle === 'italic' && "bg-accent")}
                    onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, fontStyle: node.style?.fontStyle === 'italic' ? undefined : 'italic' } }); }}
                    title={t('contextMenu.italic')}
                  ><TextItalic size={16} /></NotionButton>
                  <NotionButton variant="ghost"
                    className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.textDecoration === 'underline' && "bg-accent")}
                    onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, textDecoration: node.style?.textDecoration === 'underline' ? undefined : 'underline' } }); }}
                    title={t('contextMenu.underline')}
                  ><TextUnderline size={16} /></NotionButton>
                  <NotionButton variant="ghost"
                    className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.textDecoration === 'line-through' && "bg-accent")}
                    onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, textDecoration: node.style?.textDecoration === 'line-through' ? undefined : 'line-through' } }); }}
                    title={t('contextMenu.strikethrough')}
                  ><TextStrikethrough size={16} /></NotionButton>
                  <div className="w-px h-4 bg-border mx-0.5" />
                  {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
                    <NotionButton variant="ghost" key={level}
                      className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.headingLevel === level && "bg-accent")}
                      onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, headingLevel: node.style?.headingLevel === level ? undefined : level } }); }}
                      title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
                    ><Icon size={16} /></NotionButton>
                  ))}
                  <NotionButton variant="ghost"
                    className={cn("w-7 h-7 flex items-center justify-center rounded", !node.style?.headingLevel && "bg-accent")}
                    onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, headingLevel: undefined } }); }}
                    title={t('contextMenu.normalText')}
                  ><TextT size={16} /></NotionButton>
                </div>
                <AppMenuSeparator />
                <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
                  <Palette size={16} className="flex-shrink-0" />
                  <span>{t('contextMenu.textColor')}</span>
                </div>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  {QUICK_TEXT_COLORS.map(color => (
                    <NotionButton variant="ghost"
                      key={color}
                      className={cn(
                        "w-[18px] h-[18px] rounded-full border-2 transition-transform hover:scale-125 flex-shrink-0",
                        node.style?.textColor === color ? "border-primary scale-110" : "border-transparent"
                      )}
                      style={{ backgroundColor: color }}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateNode(node.id, { style: { ...node.style, textColor: color } });
                      }}
                    />
                  ))}
                  <NotionButton variant="ghost"
                    className="w-[18px] h-[18px] rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-[var(--interactive-hover)] flex-shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateNode(node.id, { style: { ...node.style, textColor: undefined } });
                    }}
                  >
                    <X className="w-2.5 h-2.5" />
                  </NotionButton>
                </div>
                <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
                  <Highlighter size={16} className="flex-shrink-0" />
                  <span>{t('contextMenu.highlight')}</span>
                </div>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  {QUICK_BG_COLORS.map(color => (
                    <NotionButton variant="ghost"
                      key={color}
                      className={cn(
                        "w-[18px] h-[18px] rounded-full border-2 transition-transform hover:scale-125 flex-shrink-0",
                        node.style?.bgColor === color ? "border-primary scale-110" : "border-transparent"
                      )}
                      style={{ backgroundColor: color }}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateNode(node.id, { style: { ...node.style, bgColor: color } });
                      }}
                    />
                  ))}
                  <NotionButton variant="ghost"
                    className="w-[18px] h-[18px] rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-[var(--interactive-hover)] flex-shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateNode(node.id, { style: { ...node.style, bgColor: undefined } });
                    }}
                  >
                    <X className="w-2.5 h-2.5" />
                  </NotionButton>
                </div>
                <AppMenuSeparator />
                <AppMenuItem
                  icon={<Copy className="w-4 h-4" />}
                  shortcut="⌘C"
                  onClick={() => copyNodes([node.id])}
                >
                  {t('contextMenu.copy')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<Scissors className="w-4 h-4" />}
                  shortcut="⌘X"
                  disabled={isRoot}
                  onClick={() => cutNodes([node.id])}
                >
                  {t('contextMenu.cut')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<ClipboardText size={16} />}
                  shortcut="⌘V"
                  disabled={!clipboard}
                  onClick={() => pasteNodes(node.id)}
                >
                  {t('contextMenu.pasteAsChild')}
                </AppMenuItem>
                {hasChildren && (
                  <>
                    <AppMenuSeparator />
                    <AppMenuItem
                      icon={isCollapsed
                        ? <CaretRight size={16} />
                        : <CaretDown size={16} />}
                      shortcut={isCollapsed ? '⌘]' : '⌘['}
                      onClick={() => toggleCollapse(node.id)}
                    >
                      {isCollapsed ? t('actions.expand') : t('actions.collapse')}
                    </AppMenuItem>
                  </>
                )}
                {!isRoot && (
                  <>
                    <AppMenuSeparator />
                    <AppMenuItem
                      icon={<Trash size={16} />}
                      shortcut="Del"
                      destructive
                      onClick={() => deleteNode(node.id)}
                    >
                      {t('actions.delete')}
                    </AppMenuItem>
                  </>
                )}
              </AppMenuContent>
            </AppMenu>
          </>
        )}
      </div>
      )}

      {/* 下方拖拽指示器 */}
      {isOver && dropPosition === 'after' && !isBeingDragged && (
        <>
          <div 
            className="drop-indicator"
            style={{ 
              bottom: 0,
              top: 'auto',
              left: `${BASE_PADDING + (projectedLevel ?? level) * LEVEL_INDENT + 9}px` 
            }}
          />
          {projectedLevel !== null && projectedLevel > level && (
            <div 
              className="drop-indicator-vertical"
              style={{
                left: `${BASE_PADDING + (projectedLevel) * LEVEL_INDENT + 9}px`,
                bottom: '0',
                height: '100%',
              }}
            />
          )}
        </>
      )}
    </div>
  );
};

/** 拖拽预览：显示被拖节点及其子树缩略；多选时显示数量徽章 */
const DragOverlayContent: React.FC<{ node: MindMapNode; dragCount?: number }> = ({ node, dragCount = 1 }) => {
  const { t } = useTranslation('mindmap');
  const MAX_PREVIEW_DEPTH = 3;   // 最多展示 3 层
  const MAX_CHILDREN_SHOW = 4;   // 每层最多展示 4 个子节点

  const countDescendants = (n: MindMapNode): number => {
    if (!n.children || n.children.length === 0) return 0;
    return n.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
  };

  const renderNode = (n: MindMapNode, depth: number) => {
    const hasChildren = n.children && n.children.length > 0;
    const childrenToShow = hasChildren ? n.children!.slice(0, MAX_CHILDREN_SHOW) : [];
    const hiddenCount = hasChildren ? n.children!.length - childrenToShow.length : 0;

    return (
      <div key={n.id} style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
        <div className="flex items-center gap-1.5 py-[2px]">
          <div className={cn(
            "w-[5px] h-[5px] rounded-full flex-shrink-0",
            depth === 0 ? "bg-foreground/70" : "bg-foreground/30"
          )} />
          <span className={cn(
            "truncate",
            depth === 0 ? "font-medium text-[13px] max-w-[240px]" : "text-[12px] text-muted-foreground max-w-[200px]"
          )}>
            {n.text || t('outline.unnamedNode')}
          </span>
        </div>
        {depth < MAX_PREVIEW_DEPTH && childrenToShow.map(child => renderNode(child, depth + 1))}
        {(hiddenCount > 0 || (depth >= MAX_PREVIEW_DEPTH && hasChildren)) && (
          <div style={{ paddingLeft: 16 }} className="text-[11px] text-muted-foreground/60 py-[1px]">
            ⋯ {depth >= MAX_PREVIEW_DEPTH
              ? `${countDescendants(n)} 项`
              : `${hiddenCount} 项`
            }
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="drag-overlay-item !items-start !flex-col !py-2 !px-3 min-w-[120px] max-w-[300px] relative">
      {dragCount > 1 && (
        <span className="outline-drag-count-badge">{dragCount}</span>
      )}
      {renderNode(node, 0)}
    </div>
  );
};

// 面包屑导航组件 - Notion Style
const OutlineBreadcrumb: React.FC<{
  path: MindMapNode[];
  onNavigate: (nodeId: string | null) => void;
}> = ({ path, onNavigate }) => {
  const { t } = useTranslation('mindmap');
  if (path.length <= 1) return null;
  
  return (
    <div
      className="outline-breadcrumb flex items-center gap-1 px-4 py-2 text-sm text-[var(--mm-text-secondary)] select-none sticky top-0 bg-[var(--mm-bg)] z-10"
    >
      <NotionButton variant="ghost"
        onClick={() => onNavigate(null)}
        className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] transition-colors"
        title={t('outline.exitFocusMode')}
      >
        <House size={14} />
      </NotionButton>
      {path.map((node, index) => (
        <React.Fragment key={node.id}>
          <span className="text-[var(--mm-text-muted)]">/</span>
          <NotionButton variant="ghost"
            onClick={() => onNavigate(node.id)}
            className={cn(
              "px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] transition-colors truncate max-w-[120px]",
              index === path.length - 1 
                ? "text-[var(--mm-text)] font-medium"
                : ""
            )}
          >
            {node.text || t('outline.untitled')}
          </NotionButton>
        </React.Fragment>
      ))}
    </div>
  );
};

export interface OutlineViewHandle {
  getScrollTop: () => number;
  setScrollTop: (top: number) => void;
  scrollFocusedIntoView: () => void;
}

export interface OutlineViewProps {
  /** 切回大纲时恢复的 scrollTop；随后再把焦点行滚到中部 */
  initialScrollTop?: number | null;
}

export const OutlineView = React.forwardRef<OutlineViewHandle, OutlineViewProps>(
  function OutlineView({ initialScrollTop = null }, ref) {
  const { t } = useTranslation('mindmap');
  const storeApi = useMindMapStoreApi();
  const document = useMindMapStore(state => state.document);
  const hideCompleted = useMindMapStore(state => state.hideCompleted);
  const searchResults = useMindMapStore(state => state.searchResults);
  const searchQuery = useMindMapStore(state => state.searchQuery);
  const currentSearchIndex = useMindMapStore(state => state.currentSearchIndex);
  const searchFilterMode = useMindMapStore(state => state.searchFilterMode);
  const moveNodes = useMindMapStore(state => state.moveNodes);
  const addNode = useMindMapStore(state => state.addNode);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  const addNodeRef = useMindMapStore(state => state.addNodeRef);
  const selection = useMindMapStore(state => state.selection);
  const setSelection = useMindMapStore(state => state.setSelection);
  const deleteNodes = useMindMapStore(state => state.deleteNodes);
  const indentNodes = useMindMapStore(state => state.indentNodes);
  const outdentNodes = useMindMapStore(state => state.outdentNodes);
  const toggleCompleted = useMindMapStore(state => state.toggleCompleted);
  const focusedNodeId = useMindMapStore(state => state.focusedNodeId);
  const viewRootId = useMindMapStore(state => state.viewRootId);
  const setViewRootId = useMindMapStore(state => state.setViewRootId);
  /** ACR R2-02：与画布共用 agentEnteringIds，保证大纲同步入场动画 */
  const agentEnteringIds = useMindMapStore(state => state.agentEnteringIds);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [dragGroupIds, setDragGroupIds] = useState<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<DropPosition>('inside');
  const [resourcePickerNodeId, setResourcePickerNodeId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollRef = useRef(false);
  const pendingScrollTopRef = useRef<number | null>(
    initialScrollTop != null && initialScrollTop >= 0 ? initialScrollTop : null,
  );

  const sensors = useTouchFriendlyDndSensors();

  const scrollFocusedRowIntoView = useCallback(() => {
    const root = containerRef.current;
    const id = storeApi.getState().focusedNodeId;
    if (!root || !id) return;
    const escaped =
      typeof globalThis.CSS?.escape === 'function'
        ? globalThis.CSS.escape(id)
        : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const row = root.querySelector(
      `[data-node-id="${escaped}"]`,
    ) as HTMLElement | null;
    row?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [storeApi]);

  const restoreScrollIfNeeded = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || restoredScrollRef.current) return;
      restoredScrollRef.current = true;
      const top = pendingScrollTopRef.current;
      pendingScrollTopRef.current = null;
      if (top != null) el.scrollTop = top;
      // 仅当焦点行完全在视口外时再滚入，避免冲掉双模滚动保真
      requestAnimationFrame(() => {
        const id = storeApi.getState().focusedNodeId;
        if (!id || !containerRef.current) return;
        const escaped =
          typeof globalThis.CSS?.escape === 'function'
            ? globalThis.CSS.escape(id)
            : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const row = containerRef.current.querySelector(
          `[data-node-id="${escaped}"]`,
        ) as HTMLElement | null;
        if (!row) return;
        const rowRect = row.getBoundingClientRect();
        const viewRect = el.getBoundingClientRect();
        const fullyOutside =
          rowRect.bottom < viewRect.top || rowRect.top > viewRect.bottom;
        if (fullyOutside) {
          row.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      });
    },
    [storeApi],
  );

  const setScrollViewport = useCallback(
    (el: HTMLDivElement | null) => {
      scrollViewportRef.current = el;
      restoreScrollIfNeeded(el);
    },
    [restoreScrollIfNeeded],
  );

  React.useImperativeHandle(ref, () => ({
    getScrollTop: () => scrollViewportRef.current?.scrollTop ?? 0,
    setScrollTop: (top: number) => {
      const el = scrollViewportRef.current;
      if (el) el.scrollTop = top;
    },
    scrollFocusedIntoView: scrollFocusedRowIntoView,
  }), [scrollFocusedRowIntoView]);

  // 兜底：viewport 已就绪时再恢复一次（native ScrollArea 同步挂载路径）
  useEffect(() => {
    restoreScrollIfNeeded(scrollViewportRef.current);
  }, [restoreScrollIfNeeded]);

  // ★ 移动端虚拟键盘：键盘弹起（visualViewport 缩小）后，把正在编辑的
  // 输入框滚回可视区中部，避免被键盘遮挡
  useEffect(() => {
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      const active = globalThis.document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') &&
        containerRef.current?.contains(active)
      ) {
        active.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  const displayRoot = useMemo(() => {
    if (!viewRootId) return document.root;
    return findNodeById(document.root, viewRootId) || document.root;
  }, [document.root, viewRootId]);

  const breadcrumbPath = useMemo(() => {
    if (!viewRootId) return [];
    return getPathToNode(document.root, viewRootId);
  }, [document.root, viewRootId]);

  const searchPathIds = useMemo(() => {
    return resolveSearchPathIds(displayRoot, {
      enabled: searchFilterMode,
      query: searchQuery,
      matchIds: searchResults,
    });
  }, [searchFilterMode, searchQuery, searchResults, displayRoot]);

  const allFlatNodes = useMemo(
    () =>
      flattenTree(displayRoot, {
        hideCompleted,
        pathIds: searchPathIds,
      }),
    [displayRoot, hideCompleted, searchPathIds]
  );
  const allFlatNodeById = useMemo(
    () => new Map(allFlatNodes.map((node) => [node.id, node])),
    [allFlatNodes],
  );
  const allFlatNodeIndexById = useMemo(
    () => new Map(allFlatNodes.map((node, index) => [node.id, index])),
    [allFlatNodes],
  );

  // 焦点落在被隐藏的已完成节点时，上移到可见祖先
  useEffect(() => {
    if (!hideCompleted || searchPathIds !== null || !focusedNodeId) return;
    const next = resolveVisibleFocusId(document.root, focusedNodeId, true);
    if (next && next !== focusedNodeId) {
      setFocusedNodeId(next);
    }
  }, [hideCompleted, searchPathIds, focusedNodeId, document.root, setFocusedNodeId]);

  // 追踪新出现的节点（展开动画）+ ACR agentEnteringIds（R2-02 大纲同步）
  const isInitialRender = useRef(true);
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  const enteringNodeIds = useMemo(() => {
    const entering = new Set<string>();
    if (!isInitialRender.current) {
      const prev = prevNodeIdsRef.current;
      allFlatNodes.forEach(fn => {
        if (!prev.has(fn.id)) entering.add(fn.id);
      });
    }
    // Agent 演出：即使差分未命中（如 update/move），也播 entering
    agentEnteringIds.forEach(id => entering.add(id));
    return entering;
  }, [allFlatNodes, agentEnteringIds]);

  useEffect(() => {
    isInitialRender.current = false;
    prevNodeIdsRef.current = new Set(allFlatNodes.map(fn => fn.id));
  }, [allFlatNodes]);

  // 拖拽时收集被拖节点（及多选组其它成员）的后代 ID，用于隐藏子树
  const dragHiddenIds = useMemo(() => {
    if (!activeId) return new Set<string>();
    const ids = new Set<string>();
    const collect = (n: MindMapNode) => {
      n.children?.forEach(child => { ids.add(child.id); collect(child); });
    };
    const group = dragGroupIds.length > 0 ? dragGroupIds : [String(activeId)];
    for (const gid of group) {
      const node = allFlatNodeById.get(gid)?.node;
      if (!node) continue;
      if (gid !== String(activeId)) ids.add(gid); // 隐藏组内其它顶层项
      collect(node);
    }
    return ids;
  }, [activeId, dragGroupIds, allFlatNodeById]);

  // 拖拽期间过滤掉后代/组内其它节点，使子树跟随父节点一起移动
  const flatNodes = useMemo(() => {
    if (dragHiddenIds.size === 0) return allFlatNodes;
    return allFlatNodes.filter(fn => !dragHiddenIds.has(fn.id));
  }, [allFlatNodes, dragHiddenIds]);

  const nodeIds = useMemo(() => flatNodes.map(n => n.id), [flatNodes]);
  const flatNodeById = useMemo(
    () => new Map(flatNodes.map((node) => [node.id, node])),
    [flatNodes],
  );
  const flatNodeIndexById = useMemo(
    () => new Map(flatNodes.map((node, index) => [node.id, index])),
    [flatNodes],
  );

  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const searchResultSet = useMemo(() => new Set(searchResults), [searchResults]);
  const currentSearchResultId =
    currentSearchIndex >= 0 ? (searchResults[currentSearchIndex] ?? null) : null;
  const isMultiSelectActive = selection.length > 1;

  const topLevelSelectedIds = useMemo(
    () => collectTopLevelNodeIds(document.root, selection, { excludeRoot: true }),
    [document.root, selection]
  );

  const handleRowSelect = useCallback((nodeId: string, e: React.MouseEvent) => {
    const flat = allFlatNodes;
    const isRootRow = allFlatNodeById.get(nodeId)?.level === 0;

    if (e.shiftKey) {
      const anchor = selectionAnchorRef.current || focusedNodeId || nodeId;
      const rangeIds = getVisibleRangeIds(flat, anchor, nodeId, {
        excludeRoot: true,
        indexById: allFlatNodeIndexById,
      });
      setSelection(rangeIds.length > 0 ? rangeIds : (isRootRow ? [] : [nodeId]));
      setFocusedNodeId(nodeId);
      return;
    }

    if (e.metaKey || e.ctrlKey) {
      if (isRootRow) {
        setFocusedNodeId(nodeId);
        return;
      }
      const next = selectionSet.has(nodeId)
        ? selection.filter((id) => id !== nodeId)
        : [...selection.filter((id) => id !== document.root.id), nodeId];
      setSelection(next);
      selectionAnchorRef.current = nodeId;
      setFocusedNodeId(nodeId);
      return;
    }

    // 单击：单选并聚焦（保持可编辑）
    setSelection(isRootRow ? [] : [nodeId]);
    selectionAnchorRef.current = nodeId;
    setFocusedNodeId(nodeId);
  }, [allFlatNodes, allFlatNodeById, allFlatNodeIndexById, focusedNodeId, selection, selectionSet, setFocusedNodeId, setSelection, document.root.id]);

  const handleBatchDelete = useCallback(() => {
    if (topLevelSelectedIds.length === 0) return;
    deleteNodes(topLevelSelectedIds);
    setSelection([]);
  }, [topLevelSelectedIds, deleteNodes, setSelection]);

  const handleBatchIndent = useCallback(() => {
    indentNodes(topLevelSelectedIds);
  }, [topLevelSelectedIds, indentNodes]);

  const handleBatchOutdent = useCallback(() => {
    outdentNodes(topLevelSelectedIds);
  }, [topLevelSelectedIds, outdentNodes]);

  const handleBatchComplete = useCallback(() => {
    toggleCompleted(selection);
  }, [selection, toggleCompleted]);

  // 多选时 document 级快捷键（退出编辑后焦点可能不在行内）
  useEffect(() => {
    if (!isMultiSelectActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;
      const isOutlineInput = target.dataset?.mmOutlineInput === 'true';
      // 搜索框等其它输入不劫持；大纲行内 input 仍走批量
      if (inEditable && !isOutlineInput) return;
      // 仅当事件来自大纲容器内，或焦点已离开可编辑区时处理
      const root = containerRef.current;
      if (root && inEditable && isOutlineInput && !root.contains(target)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSelection([]);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleBatchIndent();
        return;
      }
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleBatchOutdent();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        handleBatchDelete();
      }
    };

    globalThis.document.addEventListener('keydown', onKeyDown, true);
    return () => globalThis.document.removeEventListener('keydown', onKeyDown, true);
  }, [isMultiSelectActive, handleBatchIndent, handleBatchOutdent, handleBatchDelete, setSelection]);

  const activeNode = useMemo(() => {
    if (!activeId) return null;
    return allFlatNodeById.get(String(activeId))?.node ?? null;
  }, [activeId, allFlatNodeById]);

  // 计算当前拖拽的预期层级，用于 UI 展示
  const activeFlatNode = useMemo(() => 
    activeId ? flatNodeById.get(String(activeId)) : undefined,
  [activeId, flatNodeById]);
  
  const overFlatNode = useMemo(() => 
    overId ? flatNodeById.get(String(overId)) : undefined,
  [overId, flatNodeById]);

  const calculateDropPosition = useCallback((event: DragOverEvent): DropPosition => {
    if (!event.over) return 'inside';
    
    const overRect = event.over.rect;
    const overTop = overRect?.top ?? 0;
    const overHeight = overRect?.height ?? 0;
    
    const activeRect = event.active.rect.current;
    const translated = (activeRect as any)?.translated;
    const pointerY = translated?.top ?? 0;
    const pointerMiddleY = pointerY + ((translated?.height ?? 0) / 2);
    
    const relativeY = pointerMiddleY - overTop;
    
    // 简化为 only before/after，通过水平拖拽决定层级
    if (relativeY < overHeight * 0.5) return 'before';
    return 'after';
  }, []);

  const [offsetLeft, setOffsetLeft] = useState(0);

  const getProjectedLevel = useCallback((
    activeNodeLevel: number,
    overNode: FlatNode,
    dropPosition: DropPosition,
    offset: number
  ) => {
    const dragDepth = Math.round(offset / LEVEL_INDENT);
    const projectedDepth = activeNodeLevel + dragDepth;
    
    // 确定“上一个节点”作为锚点
    // 如果是 after，锚点就是 overNode
    // 如果是 before，锚点是 overNode 的前一个节点
    let anchorNode: FlatNode | null = null;
    
    if (dropPosition === 'after') {
      anchorNode = overNode;
    } else {
      const overIndex = flatNodeIndexById.get(overNode.id) ?? -1;
      if (overIndex > 0) {
        anchorNode = flatNodes[overIndex - 1];
      }
    }
    
    // 如果没有锚点（比如插在第一个节点之前），只能是 level 0
    if (!anchorNode) return 0;
    
    const maxLevel = anchorNode.level + 1;
    const minLevel = 0; // 实际上可以更灵活，但 0 是安全的下限
    
    return Math.max(minLevel, Math.min(maxLevel, projectedDepth));
  }, [flatNodes, flatNodeIndexById]);

  const currentProjectedLevel = useMemo(() => {
    if (!activeFlatNode || !overFlatNode) return null;
    return getProjectedLevel(activeFlatNode.level, overFlatNode, dropPosition, offsetLeft);
  }, [activeFlatNode, overFlatNode, dropPosition, offsetLeft, getProjectedLevel]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveId(event.active.id);
    setOffsetLeft(0);
    // 若拖的是选中集之一，整组移动；按可见列表顺序（非点击序）
    if (selection.includes(id) && selection.length > 1) {
      const top = collectTopLevelNodeIds(document.root, selection, {
        excludeRoot: true,
      });
      top.sort(
        (a, b) =>
          (allFlatNodeIndexById.get(a) ?? 0) - (allFlatNodeIndexById.get(b) ?? 0),
      );
      setDragGroupIds(top);
    } else {
      setDragGroupIds([id]);
    }
  }, [selection, document.root, allFlatNodeIndexById]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setOffsetLeft(event.delta.x);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverId(over?.id ?? null);
    if (over) {
      setDropPosition(calculateDropPosition(event));
    }
  }, [calculateDropPosition]);

  const resolveDropTarget = useCallback((
    sourceId: string,
    targetId: string,
  ): { parentId: string; index: number } | null => {
    if (isDescendantOf(document.root, sourceId, targetId)) return null;

    const targetFlatNode = flatNodeById.get(targetId);
    const sourceFlatNode = flatNodeById.get(sourceId);
    if (!targetFlatNode || !sourceFlatNode) return null;

    const projectedLevel = getProjectedLevel(
      sourceFlatNode.level,
      targetFlatNode,
      dropPosition,
      offsetLeft
    );

    let anchorNode: FlatNode | null = null;
    if (dropPosition === 'after') {
      anchorNode = targetFlatNode;
    } else {
      const targetIndex = flatNodeIndexById.get(targetId) ?? -1;
      if (targetIndex > 0) {
        anchorNode = flatNodes[targetIndex - 1];
      }
    }

    // 专注模式下 level0 落点应是 displayRoot，而非整棵文档的 root
    const scopeRootId = displayRoot.id;

    if (!anchorNode) {
      return { parentId: scopeRootId, index: 0 };
    }

    if (projectedLevel === anchorNode.level + 1) {
      return { parentId: anchorNode.id, index: 0 };
    }
    if (projectedLevel === anchorNode.level) {
      if (anchorNode.parentId) {
        return { parentId: anchorNode.parentId, index: anchorNode.indexInParent + 1 };
      }
      // 锚点即专注根行：同级插入到专注根下
      if (anchorNode.id === scopeRootId || anchorNode.level === 0) {
        return { parentId: scopeRootId, index: 0 };
      }
      return null;
    }

    let current: FlatNode | undefined = anchorNode;
    while (current && current.level > projectedLevel) {
      const parent = current?.parentId ? flatNodeById.get(current.parentId) : undefined;
      current = parent;
    }

    if (current && current.parentId) {
      return { parentId: current.parentId, index: current.indexInParent + 1 };
    }
    if (current && (current.level === 0 || current.id === scopeRootId)) {
      return {
        parentId: scopeRootId,
        index: current.id === scopeRootId ? 0 : current.indexInParent + 1,
      };
    }
    return null;
  }, [document.root, displayRoot.id, flatNodes, flatNodeById, flatNodeIndexById, dropPosition, offsetLeft, getProjectedLevel]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const groupIds = dragGroupIds.length > 0 ? dragGroupIds : [String(active.id)];

    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    setDragGroupIds([]);

    if (!over || active.id === over.id) return;

    const sourceId = String(active.id);
    const targetId = String(over.id);
    const drop = resolveDropTarget(sourceId, targetId);
    if (!drop) return;

    const movingIds = groupIds.filter((id) => id !== document.root.id);
    if (movingIds.length === 0) return;

    // 若目标在移动集内，跳过
    if (movingIds.includes(targetId)) return;

    if (moveNodes(movingIds, drop.parentId, drop.index)) {
      setSelection(movingIds);
    }
  }, [dragGroupIds, resolveDropTarget, document.root, moveNodes, setSelection]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
    setDragGroupIds([]);
  }, []);

  // Empty state handling
  const hasOnlyRoot = document.root.children.length === 0;

  return (
    <div 
      ref={containerRef}
      className="h-full w-full flex flex-col bg-[var(--mm-bg)] relative"
      onClick={(e) => {
        // 点在行外空白（含 ScrollArea padding）时清多选
        const target = e.target as HTMLElement;
        if (target.closest('[data-node-id]')) return;
        if (target.closest('.outline-multiselect-bar')) return;
        if (target.closest('.outline-breadcrumb')) return;
        setSelection([]);
      }}
    >
      <OutlineBreadcrumb 
        path={breadcrumbPath} 
        onNavigate={setViewRootId} 
      />
      
      <CustomScrollArea
        className="flex-1"
        viewportClassName="p-4 md:px-12 md:py-8"
        viewportRef={setScrollViewport}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        >
          <SortableContext items={nodeIds} strategy={verticalListSortingStrategy}>
            <div
              key={viewRootId ?? 'root'}
              className="max-w-3xl mx-auto pb-32 outline-content-enter"
              onClick={(e) => {
                if (e.target === e.currentTarget) setSelection([]);
              }}
            >
              {flatNodes.map((flatNode, index) => (
                <SortableOutlineNode
                  key={flatNode.id}
                  flatNode={flatNode}
                  isRoot={flatNode.level === 0}
                  overId={overId}
                  dropPosition={dropPosition}
                  activeId={activeId}
                  projectedLevel={overId === flatNode.id ? currentProjectedLevel : null}
                  isEntering={enteringNodeIds.has(flatNode.id)}
                  isSelected={selectionSet.has(flatNode.id)}
                  isMultiSelectActive={isMultiSelectActive}
                  onRowSelect={handleRowSelect}
                  onBatchIndent={handleBatchIndent}
                  onBatchOutdent={handleBatchOutdent}
                  onBatchDelete={handleBatchDelete}
                  searchResultIds={searchResultSet}
                  currentSearchResultId={currentSearchResultId}
                  searchQuery={searchQuery}
                  onNavigate={(direction) => {
                    if (direction === 'up') {
                      const prev = flatNodes[index - 1];
                      if (prev) setFocusedNodeId(prev.id);
                    } else {
                      const next = flatNodes[index + 1];
                      if (next) setFocusedNodeId(next.id);
                    }
                  }}
                  onZoomIn={(nodeId) => setViewRootId(nodeId)}
                  onOpenResourcePicker={(nodeId) => setResourcePickerNodeId(nodeId)}
                />
              ))}
              
              {/* Click empty area to add node if empty */}
              {hasOnlyRoot && (
                <div
                  className="outline-empty-action"
                  onClick={() => {
                    const newNodeId = addNode(document.root.id, 0);
                    if (newNodeId) {
                      setFocusedNodeId(newNodeId);
                    }
                  }}
                >
                  <span className="outline-empty-plus" aria-hidden="true">+</span>
                  <p>{t('outline.emptyHint')}</p>
                </div>
              )}
            </div>
          </SortableContext>

          {createPortal(
            <DragOverlay dropAnimation={dropAnimationConfig}>
              {activeNode && (
                <DragOverlayContent
                  node={activeNode}
                  dragCount={dragGroupIds.length > 1 ? dragGroupIds.length : 1}
                />
              )}
            </DragOverlay>,
            globalThis.document.body
          )}
        </DndContext>
      </CustomScrollArea>

      {isMultiSelectActive && (
        <div className="outline-multiselect-bar" role="toolbar" aria-label={t('outline.selectedCount', { count: selection.length })}>
          <span className="outline-multiselect-count">
            {t('outline.selectedCount', { count: selection.length })}
          </span>
          <NotionButton
            variant="ghost"
            className="outline-multiselect-btn"
            onClick={handleBatchComplete}
            title={t('outline.batchComplete')}
          >
            <CheckCircle size={16} />
            <span>{t('outline.batchComplete')}</span>
          </NotionButton>
          <NotionButton
            variant="ghost"
            className="outline-multiselect-btn destructive"
            onClick={handleBatchDelete}
            title={t('actions.delete')}
          >
            <Trash size={16} />
            <span>{t('actions.delete')}</span>
          </NotionButton>
          <NotionButton
            variant="ghost"
            className="outline-multiselect-btn"
            onClick={() => setSelection([])}
            title={t('outline.clearSelection')}
          >
            <X size={16} />
          </NotionButton>
        </div>
      )}

      <MindMapResourcePicker
        isOpen={!!resourcePickerNodeId}
        nodeId={resourcePickerNodeId || ''}
        existingRefs={resourcePickerNodeId ? findNodeById(document.root, resourcePickerNodeId)?.refs : undefined}
        onSelect={(ref) => {
          if (resourcePickerNodeId) addNodeRef(resourcePickerNodeId, ref);
        }}
        onClose={() => setResourcePickerNodeId(null)}
      />
    </div>
  );
});

OutlineView.displayName = 'OutlineView';
