import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
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
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMindMapStore } from '../store';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { 
  ChevronRight, 
  ChevronDown, 
  Plus,
  MoreHorizontal,
  Trash2,
  Bold,
  Pencil,
  CheckCircle2,
  Circle,
  Palette,
  Highlighter,
  Home,
  GripVertical,
  ZoomIn,
  StickyNote,
  Copy,
  Scissors,
  ClipboardPaste,
  X,
} from 'lucide-react';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import type { MindMapNode, BlankRange } from '../types';
import { NodeRefList } from '../components/shared/NodeRefCard';
import { findNodeById, isDescendantOf } from '../utils/node/find';
import { BlankedText } from '../components/shared/BlankedText';
import { InlineLatex } from '../components/shared/InlineLatex';
import { containsLatex } from '../utils/renderLatex';
import { QUICK_TEXT_COLORS, QUICK_BG_COLORS } from '../constants';
import { getAncestors } from '../utils/node/traverse';

const LEVEL_INDENT = 28; // Increased indent for better hierarchy
const BASE_PADDING = 12;

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.4' } },
  }),
};

type DropPosition = 'before' | 'after' | 'inside';

interface FlatNode {
  id: string;
  node: MindMapNode;
  level: number;
  parentId: string | null;
  indexInParent: number;
}

// 扁平化节点树（含层级信息，专用于大纲视图）
function flattenTree(root: MindMapNode): FlatNode[] {
  const result: FlatNode[] = [];
  
  const traverse = (node: MindMapNode, level: number, parentId: string | null, indexInParent: number) => {
    result.push({ id: node.id, node, level, parentId, indexInParent });
    
    if (!node.collapsed && node.children && node.children.length > 0) {
      node.children.forEach((child, idx) => {
        traverse(child, level + 1, node.id, idx);
      });
    }
  };
  
  traverse(root, 0, null, 0);
  return result;
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
  onNavigate?: (direction: 'up' | 'down') => void;
  onZoomIn?: (nodeId: string) => void;
}> = ({ flatNode, isRoot, overId, dropPosition, activeId, projectedLevel, onNavigate, onZoomIn }) => {
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
  const searchResults = useMindMapStore(state => state.searchResults);
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
  
  const inputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [localText, setLocalText] = useState(node.text || '');
  const [localNote, setLocalNote] = useState(node.note || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingNote, setIsEditingNote] = useState(false);
  
  const isFocused = focusedNodeId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const isCollapsed = node.collapsed;
  const isSearchMatch = searchResults.includes(node.id);
  const isOver = overId === node.id;
  const isBeingDragged = activeId === node.id;
  
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
    if (isFocused && !isEditingNote) {
      if (inputRef.current) {
        inputRef.current.focus();
      } else if (!isEditing && containsLatex(localText)) {
        // LaTeX 渲染态下 input 未挂载，需先进入编辑模式
        setIsEditing(true);
      }
    }
  }, [isFocused, isEditingNote, isEditing, localText]);

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
    const trimmed = (nextText ?? localText ?? '').trim();
    if (trimmed !== (node.text || '')) {
      updateNode(node.id, { text: trimmed });
    }
  }, [localText, node.id, node.text, updateNode]);

  const commitNote = useCallback((nextNote?: string) => {
    const val = nextNote ?? localNote;
    if (val !== (node.note || '')) {
      updateNode(node.id, { note: val });
    }
  }, [localNote, node.id, node.note, updateNode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Add Sibling: Enter
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
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
    
    // Add Child: Mod + Enter
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      commitText();
      const newId = addNode(node.id, 0);
      if (node.collapsed) toggleCollapse(node.id);
      setTimeout(() => setFocusedNodeId(newId), 0);
      return;
    }

    // Add/Edit Note: Shift + Enter
    if (e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      setIsEditingNote(true);
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
    
    // Delete: Backspace (if empty)
    if (e.key === 'Backspace' && localText === '' && !isRoot) {
      e.preventDefault();
      deleteNode(node.id);
      return;
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
      inputRef.current?.blur();
    }
  }, [isRoot, parentId, indexInParent, node.id, node.text, node.collapsed, hasChildren, localText, addNode, setFocusedNodeId, indentNode, outdentNode, deleteNode, commitText, moveNode, toggleCollapse, onNavigate]);

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
        isSearchMatch && "search-match",
        isRoot && "root",
        isDragging && "is-dragging"
      )}
    >
      {/* 缩进参考线 - 仅在 hover 时显示 */}
      {!isRoot && indentLevel > 0 && Array.from({ length: indentLevel }).map((_, i) => (
        <div 
          key={i}
          className="indent-guide"
          style={{ left: `${BASE_PADDING + i * LEVEL_INDENT + 12}px` }}
        />
      ))}
      
      {/* 拖拽指示器 */}
      {isOver && dropPosition === 'before' && !isBeingDragged && (
        <>
          <div 
            className="drop-indicator"
            style={{ 
              left: `${BASE_PADDING + (projectedLevel ?? level) * LEVEL_INDENT}px` 
            }}
          />
          {projectedLevel !== null && projectedLevel > level && (
            <div 
              className="drop-indicator-vertical"
              style={{
                left: `${BASE_PADDING + (projectedLevel) * LEVEL_INDENT}px`,
                bottom: '0',
                height: '100%',
              }}
            />
          )}
        </>
      )}
      
      {/* 左侧控制区容器 - 包含拖拽手柄和Bullet */}
      <div 
        className="node-left-controls"
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        {/* 拖拽把手 - Notion Style (6 dots) - hidden in recite mode */}
        {!isRoot && !reciteMode && (
          <div
            className="node-drag-handle"
            {...attributes}
            {...listeners}
            title={t('outline.dragToMove')}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </div>
        )}

        {/* 节点 Bullet / Toggle */}
        {!isRoot && (
          <div 
            className="node-bullet-container"
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) {
                toggleCollapse(node.id);
              } else {
                setFocusedNodeId(node.id);
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onZoomIn?.(node.id);
            }}
            title={hasChildren ? (isCollapsed ? t('actions.expand') : t('actions.collapse')) : t('outline.doubleClickFocus')}
          >
            <div className={cn(
              "node-bullet",
              hasChildren && "has-children",
              hasChildren && isCollapsed && "collapsed"
            )} />
          </div>
        )}
      </div>

      {/* 内容区域 */}
      <div className="flex-1 flex flex-col min-w-0 pr-2" onClick={() => setFocusedNodeId(node.id)}>
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
              backgroundColor: node.style?.bgColor ? `${node.style.bgColor}20` : undefined,
              fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
            }}
          />
        ) : !isEditing && containsLatex(localText) ? (
          <div
            className={cn(
              "node-input node-input-latex",
              isRoot && "root",
              node.completed && "line-through text-muted-foreground"
            )}
            style={{
              color: node.style?.textColor,
              backgroundColor: node.style?.bgColor ? `${node.style.bgColor}20` : undefined,
              fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
              cursor: 'text',
            }}
            onClick={(e) => {
              e.stopPropagation();
              setFocusedNodeId(node.id);
              setIsEditing(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            <InlineLatex text={localText} />
          </div>
        ) : (
        <input
          ref={inputRef}
          className={cn(
            "node-input",
            isRoot && "root",
            node.completed && "line-through text-muted-foreground"
          )}
          style={{
            color: node.style?.textColor,
            backgroundColor: node.style?.bgColor ? `${node.style.bgColor}20` : undefined,
            fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
          }}
          value={localText}
          onChange={(e) => setLocalText(e.target.value)}
          placeholder={isRoot ? t('placeholder.root') : t('placeholder.node')}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsEditing(true)}
          onBlur={() => {
            setIsEditing(false);
            commitText();
          }}
        />
        )}
        {node.note && !isEditingNote && (
          <div className="node-note" onClick={() => !reciteMode && setIsEditingNote(true)}>
            <InlineLatex text={node.note} />
          </div>
        )}
        {isEditingNote && !reciteMode && (
          <textarea
            ref={noteRef}
            className="node-note-input"
            value={localNote}
            onChange={(e) => {
              setLocalNote(e.target.value);
              if (noteRef.current) {
                noteRef.current.style.height = 'auto';
                noteRef.current.style.height = noteRef.current.scrollHeight + 'px';
              }
            }}
            onKeyDown={handleNoteKeyDown}
            onBlur={() => {
              commitNote();
              setIsEditingNote(false);
            }}
            placeholder={t('placeholder.note')}
          />
        )}
        {node.refs && node.refs.length > 0 && (
          <NodeRefList
            refs={node.refs}
            onRemove={reciteMode ? undefined : (sourceId) => removeNodeRef(node.id, sourceId)}
            onClick={(sourceId) => {
              const dstuPath = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;
              window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
                detail: { view: 'learning-hub', openResource: dstuPath },
              }));
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
              <ZoomIn className="w-4 h-4" />
            </NotionButton>
            <AppMenu>
              <AppMenuTrigger asChild>
                <NotionButton variant="ghost"
                  className="action-btn"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="w-4 h-4" />
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
                  icon={<Pencil className="w-4 h-4" />}
                  shortcut="F2"
                  onClick={() => {
                    setFocusedNodeId(node.id);
                    setIsEditing(true);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  {t('contextMenu.edit')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<StickyNote className="w-4 h-4" />}
                  shortcut="⇧Enter"
                  onClick={() => setIsEditingNote(true)}
                >
                  {node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
                </AppMenuItem>
                <AppMenuSeparator />
                <AppMenuItem
                  icon={node.completed
                    ? <Circle className="w-4 h-4" />
                    : <CheckCircle2 className="w-4 h-4" />}
                  onClick={() => updateNode(node.id, { completed: !node.completed })}
                >
                  {node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<Bold className="w-4 h-4" />}
                  shortcut="⌘B"
                  onClick={() => {
                    const currentWeight = node.style?.fontWeight;
                    updateNode(node.id, {
                      style: {
                        ...node.style,
                        fontWeight: currentWeight === 'bold' ? 'normal' : 'bold'
                      }
                    });
                  }}
                >
                  {t('contextMenu.bold')}
                </AppMenuItem>
                <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
                  <Palette className="w-4 h-4 flex-shrink-0" />
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
                    className="w-[18px] h-[18px] rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-accent flex-shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateNode(node.id, { style: { ...node.style, textColor: undefined } });
                    }}
                  >
                    <X className="w-2.5 h-2.5" />
                  </NotionButton>
                </div>
                <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
                  <Highlighter className="w-4 h-4 flex-shrink-0" />
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
                    className="w-[18px] h-[18px] rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-accent flex-shrink-0"
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
                  icon={<ClipboardPaste className="w-4 h-4" />}
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
                        ? <ChevronRight className="w-4 h-4" />
                        : <ChevronDown className="w-4 h-4" />}
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
                      icon={<Trash2 className="w-4 h-4" />}
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
              left: `${BASE_PADDING + (projectedLevel ?? level) * LEVEL_INDENT}px` 
            }}
          />
          {projectedLevel !== null && projectedLevel > level && (
            <div 
              className="drop-indicator-vertical"
              style={{
                left: `${BASE_PADDING + (projectedLevel) * LEVEL_INDENT}px`,
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

/** 拖拽预览：显示被拖节点及其子树缩略 */
const DragOverlayContent: React.FC<{ node: MindMapNode }> = ({ node }) => {
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
    <div className="drag-overlay-item !items-start !flex-col !py-2 !px-3 min-w-[120px] max-w-[300px]">
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
    <div className="flex items-center gap-1 px-4 py-2 text-sm text-[var(--mm-text-secondary)] select-none sticky top-0 bg-[var(--mm-bg)] z-10">
      <NotionButton variant="ghost"
        onClick={() => onNavigate(null)}
        className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] transition-colors"
      >
        <Home className="w-3.5 h-3.5" />
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

export const OutlineView: React.FC = () => {
  const { t } = useTranslation('mindmap');
  const document = useMindMapStore(state => state.document);
  const moveNode = useMindMapStore(state => state.moveNode);
  const addNode = useMindMapStore(state => state.addNode);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<DropPosition>('inside');
  const [focusedRootId, setFocusedRootId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const displayRoot = useMemo(() => {
    if (!focusedRootId) return document.root;
    return findNodeById(document.root, focusedRootId) || document.root;
  }, [document.root, focusedRootId]);

  const breadcrumbPath = useMemo(() => {
    if (!focusedRootId) return [];
    return getPathToNode(document.root, focusedRootId);
  }, [document.root, focusedRootId]);

  const allFlatNodes = useMemo(() => flattenTree(displayRoot), [displayRoot]);

  // 拖拽时收集被拖节点的所有后代 ID，用于隐藏子树
  const dragDescendantIds = useMemo(() => {
    if (!activeId) return new Set<string>();
    const node = findNodeById(document.root, String(activeId));
    if (!node) return new Set<string>();
    const ids = new Set<string>();
    const collect = (n: MindMapNode) => {
      n.children?.forEach(child => { ids.add(child.id); collect(child); });
    };
    collect(node);
    return ids;
  }, [activeId, document.root]);

  // 拖拽期间过滤掉后代节点，使子树跟随父节点一起移动
  const flatNodes = useMemo(() => {
    if (dragDescendantIds.size === 0) return allFlatNodes;
    return allFlatNodes.filter(fn => !dragDescendantIds.has(fn.id));
  }, [allFlatNodes, dragDescendantIds]);

  const nodeIds = useMemo(() => flatNodes.map(n => n.id), [flatNodes]);

  const activeNode = useMemo(() => {
    if (!activeId) return null;
    return findNodeById(document.root, String(activeId));
  }, [activeId, document.root]);

  // 计算当前拖拽的预期层级，用于 UI 展示
  const activeFlatNode = useMemo(() => 
    flatNodes.find(n => n.id === activeId), 
  [activeId, flatNodes]);
  
  const overFlatNode = useMemo(() => 
    flatNodes.find(n => n.id === overId), 
  [overId, flatNodes]);

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
      const overIndex = flatNodes.findIndex(n => n.id === overNode.id);
      if (overIndex > 0) {
        anchorNode = flatNodes[overIndex - 1];
      }
    }
    
    // 如果没有锚点（比如插在第一个节点之前），只能是 level 0
    if (!anchorNode) return 0;
    
    const maxLevel = anchorNode.level + 1;
    const minLevel = 0; // 实际上可以更灵活，但 0 是安全的下限
    
    return Math.max(minLevel, Math.min(maxLevel, projectedDepth));
  }, [flatNodes]);

  const currentProjectedLevel = useMemo(() => {
    if (!activeFlatNode || !overFlatNode) return null;
    return getProjectedLevel(activeFlatNode.level, overFlatNode, dropPosition, offsetLeft);
  }, [activeFlatNode, overFlatNode, dropPosition, offsetLeft, getProjectedLevel]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
    setOffsetLeft(0);
  }, []);

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

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    
    if (!over || active.id === over.id) return;
    
    const sourceId = String(active.id);
    const targetId = String(over.id);
    
    if (isDescendantOf(document.root, sourceId, targetId)) {
      return;
    }
    
    const targetFlatNode = flatNodes.find(n => n.id === targetId);
    const sourceFlatNode = flatNodes.find(n => n.id === sourceId);
    if (!targetFlatNode || !sourceFlatNode) return;
    
    // 计算目标层级
    const projectedLevel = getProjectedLevel(
      sourceFlatNode.level,
      targetFlatNode,
      dropPosition,
      offsetLeft
    );
    
    // 寻找目标父节点
    // 逻辑：
    // 1. 确定锚点节点 (Anchor)
    // 2. 根据 projectedLevel 与 Anchor.level 的关系决定插入位置
    
    let anchorNode: FlatNode | null = null;
    if (dropPosition === 'after') {
      anchorNode = targetFlatNode;
    } else {
      const targetIndex = flatNodes.findIndex(n => n.id === targetId);
      if (targetIndex > 0) {
        anchorNode = flatNodes[targetIndex - 1];
      }
    }
    
    if (!anchorNode) {
      // 插在最前面，作为 root 的第一个子节点
      moveNode(sourceId, document.root.id, 0);
      return;
    }
    
    if (projectedLevel === anchorNode.level + 1) {
      // 成为 anchor 的子节点（第一个）
      // 注意：如果 anchor 已经有子节点且展开了，通常我们应该插在它的子节点列表最后
      // 但由于我们是视觉上插在 anchor 下方，所以如果是 after anchor，且 indent 增加，就是 anchor 的第一个子节点
      moveNode(sourceId, anchorNode.id, 0);
    } else if (projectedLevel === anchorNode.level) {
      // 成为 anchor 的兄弟（下一个）
      if (anchorNode.parentId) {
        moveNode(sourceId, anchorNode.parentId, anchorNode.indexInParent + 1);
      }
    } else {
      // projectedLevel < anchorNode.level
      // 向上寻找匹配层级的祖先
      let current: FlatNode | undefined = anchorNode;
      while (current && current.level > projectedLevel) {
        // 找父级
        const parent = flatNodes.find(n => n.id === current?.parentId);
        current = parent;
      }
      
      if (current && current.parentId) {
        // 插在这个祖先的后面
        moveNode(sourceId, current.parentId, current.indexInParent + 1);
      } else if (current && current.level === 0) {
        // 已经是 root 的子节点了
        moveNode(sourceId, document.root.id, current.indexInParent + 1);
      }
    }
  }, [document.root, flatNodes, dropPosition, moveNode, offsetLeft, getProjectedLevel]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
  }, []);

  // Empty state handling
  const hasOnlyRoot = document.root.children.length === 0;

  return (
    <div 
      ref={containerRef}
      className="h-full w-full flex flex-col bg-[var(--mm-bg)]"
    >
      <OutlineBreadcrumb 
        path={breadcrumbPath} 
        onNavigate={setFocusedRootId} 
      />
      
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:px-12 md:py-8">
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
            <div className="max-w-4xl mx-auto pb-32">
              {flatNodes.map((flatNode, index) => (
                <SortableOutlineNode
                  key={flatNode.id}
                  flatNode={flatNode}
                  isRoot={flatNode.level === 0}
                  overId={overId}
                  dropPosition={dropPosition}
                  activeId={activeId}
                  projectedLevel={overId === flatNode.id ? currentProjectedLevel : null}
                  onNavigate={(direction) => {
                    if (direction === 'up') {
                      const prev = flatNodes[index - 1];
                      if (prev) setFocusedNodeId(prev.id);
                    } else {
                      const next = flatNodes[index + 1];
                      if (next) setFocusedNodeId(next.id);
                    }
                  }}
                  onZoomIn={(nodeId) => setFocusedRootId(nodeId)}
                />
              ))}
              
              {/* Click empty area to add node if empty */}
              {hasOnlyRoot && (
                <div
                  className="mt-8 text-center text-[var(--mm-text-muted)] cursor-pointer"
                  onClick={() => {
                    const newNodeId = addNode(document.root.id, 0);
                    if (newNodeId) {
                      setFocusedNodeId(newNodeId);
                    }
                  }}
                >
                  <p>{t('outline.emptyHint')}</p>
                </div>
              )}
            </div>
          </SortableContext>

          {createPortal(
            <DragOverlay dropAnimation={dropAnimationConfig}>
              {activeNode && <DragOverlayContent node={activeNode} />}
            </DragOverlay>,
            globalThis.document.body
          )}
        </DndContext>
      </div>
    </div>
  );
};
