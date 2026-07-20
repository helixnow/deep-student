/**
 * 大纲可排序行组件（从 OutlineView 拆出）。
 *
 * 性能契约：
 * - React.memo + 自定义比较器：flatNode 按字段比较（node 引用依赖 store 的
 *   结构共享），其余 props 要求父组件传稳定引用/原始值；
 * - store 只做细粒度订阅（isFocused / reciteMode / 本节点 revealedBlanks），
 *   actions 走 useOutlineStoreActions 的稳定引用，避免每行 ~25 个 selector。
 *
 * 交互契约（对齐 Workflowy/幕布）：
 * - 六点手柄专职拖拽；bullet 单击=选中聚焦，Mod+单击=聚焦缩放（zoom in）；
 * - Esc 第一次只退出编辑保留行焦点，再按 Esc 才清焦点；
 * - commit 保留用户首尾空格，仅纯空白视为空行；
 * - IME 组字期间所有结构性按键直接放行给输入法。
 */

import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'framer-motion';
import TextareaAutosize from 'react-textarea-autosize';
import { DotsSixVertical, MagnifyingGlassPlus, Plus } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { motionSafe } from '@/styles/motion-springs';
import { useMindMapStore, useMindMapStoreApi } from '../../store';
import type { MindMapDescriptionPreview, MindMapKeymap } from '../../utils/mindmapPreferences';
import { NodeRefList } from '../../components/shared/NodeRefCard';
import { BlankedText } from '../../components/shared/BlankedText';
import { InlineLatex } from '../../components/shared/InlineLatex';
import { containsLatex } from '../../utils/renderLatex';
import { findNodeById } from '../../utils/node/find';
import { getAncestors } from '../../utils/node/traverse';
import { shouldHideCompletedNode } from '../../utils/hideCompleted';
import { openNodeRef } from '../../utils/openNodeRef';
import { useTextSelectionBubble } from '../../hooks/useTextSelectionBubble';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import {
  createOutlineCaretController,
  getOutlineElementFont,
  measureOutlineTextWidth,
  shouldNavigateAcrossOutlineNode,
  isOutlineCompositionActive,
  countDescendants,
} from '../../utils/outlineCaret';
import {
  htmlOutlineToMarkdown,
  looksLikeMarkdownList,
} from '../../utils/pasteMarkdown';
import {
  BASE_PADDING,
  LEVEL_INDENT,
  SearchHighlightedText,
  useOutlineStoreActions,
  type DropPosition,
  type FlatNode,
} from './outlineShared';
import { OutlineNodeMenu } from './OutlineNodeMenu';
import {
  animateOutlineCollapse,
  animateOutlineRowsExit,
  collectVisibleSubtreeIds,
} from './collapseMotion';

export type OutlineNavigateDirection = 'up' | 'down' | 'prevEnd' | 'nextStart';

export interface SortableOutlineNodeProps {
  flatNode: FlatNode;
  isRoot: boolean;
  /** 当前节点是否为拖拽悬停目标（父组件由 overId 换算成布尔，利于 memo） */
  isDropTarget: boolean;
  dropPosition: DropPosition;
  isBeingDragged: boolean;
  projectedLevel: number | null;
  isEntering: boolean;
  /** ACR 4.0 A4：Agent delete 退场动画（driver 删除前短暂标记） */
  isExiting?: boolean;
  /** ACR 4.0 A4：Agent update 内容更新高亮（背景一次渐隐 flash） */
  isUpdated?: boolean;
  isSelected: boolean;
  isMultiSelectActive: boolean;
  isSearchMatch: boolean;
  isCurrentSearchMatch: boolean;
  searchQuery: string;
  nextVisibleNodeId: string | null;
  /** 可见列表中的上一行（行首 Backspace 合并目标；null=本行是首行） */
  prevVisibleNodeId: string | null;
  /** 焦点节点子树内的行：需要高亮的缩进线序号（=焦点节点 level），其余 null */
  focusGuideIndex: number | null;
  keymap: MindMapKeymap;
  descriptionPreview: MindMapDescriptionPreview;
  onRowSelect: (nodeId: string, e: React.MouseEvent) => void;
  onNavigate: (nodeId: string, direction: OutlineNavigateDirection, caretHint?: number) => void;
  onZoomIn: (nodeId: string) => void;
  onZoomOut: () => void;
  onOpenResourcePicker: (nodeId: string) => void;
  onBatchIndent: () => void;
  onBatchOutdent: () => void;
  onBatchDelete: () => void;
}

const SortableOutlineNodeImpl: React.FC<SortableOutlineNodeProps> = ({
  flatNode,
  isRoot,
  isDropTarget,
  dropPosition,
  isBeingDragged,
  projectedLevel,
  isEntering,
  isExiting = false,
  isUpdated = false,
  isSelected,
  isMultiSelectActive,
  isSearchMatch,
  isCurrentSearchMatch,
  searchQuery,
  nextVisibleNodeId,
  prevVisibleNodeId,
  focusGuideIndex,
  keymap,
  descriptionPreview,
  onRowSelect,
  onNavigate,
  onZoomIn,
  onZoomOut,
  onOpenResourcePicker,
  onBatchIndent,
  onBatchOutdent,
  onBatchDelete,
}) => {
  const { t } = useTranslation('mindmap');
  const { node, level, parentId, indexInParent } = flatNode;

  const storeApi = useMindMapStoreApi();
  // E01 B1：caret / goal column 按 store 实例隔离，多份导图并存不串扰
  const {
    requestOutlineCaret,
    takeOutlineCaret,
    setOutlineGoalColumn,
    getOutlineGoalColumn,
    setOutlineGoalVisual,
    clearOutlineGoalColumn,
  } = useMemo(() => createOutlineCaretController(storeApi), [storeApi]);
  const {
    updateNode,
    addNode,
    deleteNode,
    toggleCollapse,
    collapseAll,
    expandAll,
    collapseSubtree,
    expandSubtree,
    setFocusedNodeId,
    indentNode,
    outdentNode,
    splitNode,
    mergeWithPrevious,
    mergeNextIntoCurrent,
    revealBlank,
    addBlankRange,
    removeBlankRange,
    removeNodeRef,
    pasteMarkdownChildren,
  } = useOutlineStoreActions();

  // 细粒度订阅：焦点变化只重渲染新旧两行，而非整个列表
  const isFocused = useMindMapStore(state => state.focusedNodeId === node.id);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  const revealedForNode = useMindMapStore(state => state.revealedBlanks[node.id]);

  const toggleBold = useCallback(() => {
    updateNode(node.id, {
      style: {
        ...node.style,
        fontWeight: node.style?.fontWeight === 'bold' ? undefined : 'bold',
      },
    });
  }, [node.id, node.style, updateNode]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [localText, setLocalText] = useState(node.text || '');
  const [localNote, setLocalNote] = useState(node.note || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingNote, setIsEditingNote] = useState(false);
  /** Esc 后的「行聚焦但不编辑」态（Workflowy 两段式 Esc） */
  const [isEscaped, setIsEscaped] = useState(false);
  const localTextRef = useRef(localText);
  localTextRef.current = localText;
  const skipNextBlurCommitRef = useRef(false);
  /** IME 护栏：compositionend 后延一帧复位，挡住 Safari 尾随的确认 keydown */
  const composingRef = useRef(false);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    requestAnimationFrame(() => {
      composingRef.current = false;
    });
  }, []);

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

  const hasChildren = node.children && node.children.length > 0;
  const isCollapsed = node.collapsed;
  const showTextHighlight = isSearchMatch && !!searchQuery.trim() && !reciteMode;
  const multiSelectBlocksEdit = !!isMultiSelectActive;

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: node.id,
    disabled: isRoot || reciteMode,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // 触屏没有 hover 手柄，保留 bullet 作为拖拽表面（长按激活）
  // useCoarsePointer 订阅 change 事件：外接/断开鼠标、二合一设备旋转后实时更新
  const isCoarsePointer = useCoarsePointer();

  useEffect(() => {
    if (isFocused && !isEditingNote && !reciteMode && !multiSelectBlocksEdit && !isEscaped) {
      if (inputRef.current) {
        inputRef.current.focus();
        const caret = takeOutlineCaret(node.id);
        if (caret !== null) {
          const el = inputRef.current;
          const pos = Math.max(0, Math.min(caret, el.value.length));
          el.setSelectionRange(pos, pos);
        } else {
          // 非 ↑↓/←→ 导航进入（点击等）：重置 goal column
          clearOutlineGoalColumn();
        }
        // ★ 空间锚定：确保焦点节点在可视区域内
        const prefersReduced =
          typeof window !== 'undefined' &&
          !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        inputRef.current.scrollIntoView({
          block: 'nearest',
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
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
  }, [isFocused, isEditingNote, isEditing, reciteMode, multiSelectBlocksEdit, isEscaped, node.id, takeOutlineCaret, clearOutlineGoalColumn]);

  // 焦点离开本行时退出「Esc 保持焦点」态
  useEffect(() => {
    if (!isFocused && isEscaped) setIsEscaped(false);
  }, [isFocused, isEscaped]);

  // Esc 保持焦点态：Enter 恢复编辑、再 Esc 清焦点、↑↓ 继续行间导航
  useEffect(() => {
    if (!isEscaped || !isFocused || reciteMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsEscaped(false);
        setFocusedNodeId(null);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        requestOutlineCaret(node.id, (node.text || '').length);
        setIsEscaped(false);
        return;
      }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setIsEscaped(false);
        onNavigate(node.id, e.key === 'ArrowUp' ? 'up' : 'down');
      }
    };
    globalThis.document.addEventListener('keydown', onKeyDown);
    return () => globalThis.document.removeEventListener('keydown', onKeyDown);
  }, [isEscaped, isFocused, reciteMode, node.id, node.text, setFocusedNodeId, onNavigate, requestOutlineCaret]);

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
    const value = nextText ?? localTextRef.current ?? '';
    // 仅纯空白按空行处理；用户显式输入的首尾空格保留（对齐 Workflowy）
    const committed = value.trim() === '' ? '' : value;
    if (committed !== (node.text || '')) {
      updateNode(node.id, { text: committed });
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
      onRowSelect(node.id, e);
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('textarea, input, [contenteditable="true"]')) {
      return;
    }
    onRowSelect(node.id, e);
  }, [node.id, onRowSelect]);

  /**
   * 统一合并后的 caret 恢复：目标即本节点且输入框仍挂载时就地恢复；
   * 否则写入 pending caret 交给目标行的聚焦 effect 消费。
   */
  const restoreCaretAfterMerge = useCallback((targetId: string, offset: number) => {
    requestOutlineCaret(targetId, offset);
    if (targetId === node.id && inputRef.current) {
      setFocusedNodeId(targetId);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return; // 输入框已卸载：pending 留给聚焦 effect
        const pos = Math.max(0, Math.min(offset, el.value.length));
        el.focus();
        el.setSelectionRange(pos, pos);
        takeOutlineCaret(targetId);
      });
    } else {
      setTimeout(() => setFocusedNodeId(targetId), 0);
    }
  }, [node.id, setFocusedNodeId, requestOutlineCaret, takeOutlineCaret]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组字期间 Enter/Backspace/方向键等必须完全交给输入法。
    if (composingRef.current || isOutlineCompositionActive(e.nativeEvent)) return;

    const isMod = e.metaKey || e.ctrlKey;
    const undoKey = e.key.toLowerCase() === 'z';
    const redoKey = (undoKey && e.shiftKey) || e.key.toLowerCase() === 'y';
    if (isMod && (undoKey || redoKey)) {
      e.preventDefault();
      e.stopPropagation();
      clearOutlineGoalColumn();
      const caret = e.currentTarget.selectionStart ?? localText.length;
      // A pending draft is a new document mutation. Commit it before history
      // navigation so redo cannot silently replace uncommitted text.
      const committedDraft = localText.trim() === '' ? '' : localText;
      const hasUncommittedText = committedDraft !== (node.text || '');
      if (hasUncommittedText) {
        commitText(localText);
      }
      skipNextBlurCommitRef.current = true;
      setIsEditing(false);
      // U1 修复：commit 后仍继续执行对应方向的历史操作。
      // redo 时若草稿提交清空了 future，canRedo() 自然为 false（标准编辑器语义）。
      const store = storeApi.getState();
      if (redoKey) {
        if (store.canRedo()) store.redo();
      } else if (store.canUndo()) {
        store.undo();
      }
      requestOutlineCaret(node.id, caret);
      setTimeout(() => setFocusedNodeId(node.id), 0);
      return;
    }

    // 多选时：批量删 / 缩进 / 反缩进
    if (multiSelectBlocksEdit) {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        onBatchIndent();
        return;
      }
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        onBatchOutdent();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        onBatchDelete();
        return;
      }
    }

    // DS: Mod+Shift+Enter opens description. Mubu: it creates a child.
    if (e.shiftKey && isMod && e.key === 'Enter') {
      e.preventDefault();
      clearOutlineGoalColumn();
      if (keymap === 'mubu') {
        commitText();
        const newId = addNode(node.id, 0);
        if (node.collapsed) toggleCollapse(node.id);
        setTimeout(() => setFocusedNodeId(newId), 0);
      } else {
        setIsEditingNote(true);
      }
      return;
    }

    // Mubu: Shift+Enter opens description. DS: insert an internal newline.
    if (e.shiftKey && e.key === 'Enter') {
      clearOutlineGoalColumn();
      if (keymap === 'mubu') {
        e.preventDefault();
        setIsEditingNote(true);
      }
      return;
    }

    // Mubu: Mod+Enter toggles completion. DS: add child.
    if (isMod && e.key === 'Enter') {
      e.preventDefault();
      clearOutlineGoalColumn();
      if (keymap === 'mubu') {
        updateNode(node.id, { completed: !node.completed });
        return;
      }
      commitText();
      const newId = addNode(node.id, 0);
      if (node.collapsed) toggleCollapse(node.id);
      setTimeout(() => setFocusedNodeId(newId), 0);
      return;
    }

    // Enter（无 mod/shift）：行中拆分 / 行末新建同级 / 行首拆出上方空节点
    if (e.key === 'Enter') {
      e.preventDefault();
      clearOutlineGoalColumn();
      const target = e.currentTarget;
      const start = target.selectionStart ?? localText.length;
      const end = target.selectionEnd ?? start;
      // E01 B11：非空选区先删除选中文本，再在选区起点拆分（标准编辑器语义）
      const effectiveText =
        start === end ? localText : localText.slice(0, start) + localText.slice(end);
      const offset = start;
      const textLen = effectiveText.length;

      // 末尾：新建下方同级
      if (offset >= textLen) {
        if (effectiveText !== localText) {
          localTextRef.current = effectiveText;
          setLocalText(effectiveText);
        }
        commitText(effectiveText);
        if (isRoot) {
          const newId = addNode(node.id, 0);
          setTimeout(() => setFocusedNodeId(newId), 0);
        } else if (parentId) {
          const newId = addNode(parentId, indexInParent + 1);
          setTimeout(() => setFocusedNodeId(newId), 0);
        }
        return;
      }

      // 行首（非根）：上方插入空同级，本行文本与子树原地不动（Workflowy 语义）。
      // 旧实现走 splitNode 把全文移入下方新节点，子树却留在原节点——
      // 表现为「子树挂在上方空行下」，层级被打断且光标行为不可预期。
      if (offset === 0 && !isRoot && parentId) {
        if (effectiveText !== localText) {
          localTextRef.current = effectiveText;
          setLocalText(effectiveText);
        }
        commitText(effectiveText);
        addNode(parentId, indexInParent);
        // addNode 默认聚焦新节点；拉回本行，光标零跳动地停在行首
        setFocusedNodeId(node.id);
        return;
      }

      // 行中 / 根行首：splitNode（传 effectiveText 避免未 commit 丢字）
      const leftText = effectiveText.slice(0, offset);
      localTextRef.current = leftText;
      setLocalText(leftText);
      skipNextBlurCommitRef.current = true;
      setIsEditing(false);
      const newId = splitNode(node.id, offset, effectiveText);
      if (!newId) return;

      // 根行首：原节点变空并保持焦点（上方空行手感）；否则焦点到新节点开头
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
      clearOutlineGoalColumn();
      commitText();
      if (!isRoot) indentNode(node.id);
      return;
    }

    // Outdent: Shift + Tab
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      clearOutlineGoalColumn();
      commitText();
      if (!isRoot) outdentNode(node.id);
      return;
    }

    // Delete: empty non-root nodes are removed; line boundaries merge nodes.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const target = e.currentTarget;
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      if (!isRoot && localText === '') {
        e.preventDefault();
        clearOutlineGoalColumn();
        // 光标连续性：Backspace 删空行回上一可见行行尾，Delete 落到下一行行首
        //（而非旧行为的跳到父节点）。目标行在删除后依然存在（上/下方行不受影响）。
        const continuityTargetId =
          e.key === 'Backspace'
            ? prevVisibleNodeId
            : nextVisibleNodeId ?? prevVisibleNodeId;
        deleteNode(node.id);
        if (continuityTargetId) {
          const targetNode = findNodeById(
            storeApi.getState().document.root,
            continuityTargetId,
          );
          if (targetNode) {
            requestOutlineCaret(
              continuityTargetId,
              e.key === 'Backspace' ? (targetNode.text || '').length : 0,
            );
            setFocusedNodeId(continuityTargetId);
          }
        }
        return;
      }
      if (!isRoot && e.key === 'Backspace' && start === 0 && end === 0) {
        e.preventDefault();
        clearOutlineGoalColumn();
        skipNextBlurCommitRef.current = true;
        setIsEditing(false);
        // E01 B7：专注模式下以 viewRoot 为界解析「上一可见」，不并到范围外节点；
        // C：传入可见列表的上一行（尊重 hideCompleted / 搜索过滤 / 折叠），
        // 保证合并目标就是视觉上方那一行，而不是被隐藏的上一同级。
        const result = mergeWithPrevious(
          node.id,
          localText,
          storeApi.getState().viewRootId ?? undefined,
          prevVisibleNodeId,
        );
        if (!result) return;
        restoreCaretAfterMerge(result.mergedIntoId, result.cursorOffset);
        return;
      }
      if (e.key === 'Delete' && start === localText.length && end === start) {
        e.preventDefault();
        clearOutlineGoalColumn();
        const result = mergeNextIntoCurrent(node.id, localText, nextVisibleNodeId);
        if (!result) return;
        const mergedText = findNodeById(storeApi.getState().document.root, node.id)?.text ?? localText;
        localTextRef.current = mergedText;
        setLocalText(mergedText);
        restoreCaretAfterMerge(result.mergedIntoId, result.cursorOffset);
        return;
      }
    }

    // Move Up: Mod + ArrowUp
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
      e.preventDefault();
      clearOutlineGoalColumn();
      if (parentId) {
        storeApi.getState().moveNode(node.id, parentId, Math.max(0, indexInParent - 1));
      }
      return;
    }

    // Move Down: Mod + ArrowDown
    // E08 B1：moveNodes 会按「已移除的原位置」回调 index，同父下移需传 +2
    //（+1 经调整后等于原位，表现为无效），与画布快捷键实现一致。
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
      e.preventDefault();
      clearOutlineGoalColumn();
      if (parentId) {
        storeApi.getState().moveNode(node.id, parentId, indexInParent + 2);
      }
      return;
    }

    // Mubu reserves Mod+[/] for zoom. Alt+[/] is the independent fold shortcut.
    if (keymap === 'mubu' && isMod && e.key === '[') {
      e.preventDefault();
      onZoomOut();
      return;
    }
    if (keymap === 'mubu' && isMod && e.key === ']') {
      e.preventDefault();
      onZoomIn(node.id);
      return;
    }

    // Collapse all / single. DS retains Mod+[/]; both modes support Alt+[/].
    if (((keymap === 'deep-student' && isMod) || e.altKey) && e.key === '[') {
      e.preventDefault();
      if (e.shiftKey) {
        const { document: doc, viewRootId } = storeApi.getState();
        if (!viewRootId || viewRootId === doc.root.id) {
          collapseAll();
        } else {
          // 单 history 步折叠专注子树；随后无痕展开专注根本身，保持范围可见
          collapseSubtree(viewRootId);
          const liveRoot = findNodeById(storeApi.getState().document.root, viewRootId);
          if (liveRoot?.collapsed) {
            toggleCollapse(viewRootId, { skipHistory: true });
          }
        }
        return;
      }
      if (!node.collapsed && hasChildren) {
        const rowEl = inputRef.current?.closest<HTMLElement>('[data-node-id]') ?? null;
        animateOutlineCollapse(rowEl, node, () => toggleCollapse(node.id));
      }
      return;
    }

    // Expand all / single: Mod+]
    if (((keymap === 'deep-student' && isMod) || e.altKey) && e.key === ']') {
      e.preventDefault();
      if (e.shiftKey) {
        const { document: doc, viewRootId } = storeApi.getState();
        if (!viewRootId || viewRootId === doc.root.id) {
          expandAll();
        } else {
          expandSubtree(viewRootId);
        }
        return;
      }
      if (node.collapsed && hasChildren) toggleCollapse(node.id);
      return;
    }

    // ← 行首 → 上一节点末尾
    if (e.key === 'ArrowLeft' && !(e.metaKey || e.ctrlKey || e.altKey)) {
      const target = e.currentTarget;
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      if (start === 0 && end === 0) {
        e.preventDefault();
        clearOutlineGoalColumn();
        commitText();
        onNavigate(node.id, 'prevEnd');
        return;
      }
      clearOutlineGoalColumn();
      return;
    }

    // → 行尾 → 下一节点行首
    if (e.key === 'ArrowRight' && !(e.metaKey || e.ctrlKey || e.altKey)) {
      const target = e.currentTarget;
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      const len = target.value.length;
      if (start === len && end === len) {
        e.preventDefault();
        clearOutlineGoalColumn();
        commitText();
        onNavigate(node.id, 'nextStart');
        return;
      }
      clearOutlineGoalColumn();
      return;
    }

    // Navigate Up（保持 goal column；视觉列对 CJK 混排更准）
    if (e.key === 'ArrowUp' && !(e.metaKey || e.ctrlKey)) {
      const start = e.currentTarget.selectionStart ?? 0;
      if (!shouldNavigateAcrossOutlineNode(localText, start, 'up')) return;
      const target = e.currentTarget;
      // The first logical line can still contain several visual lines due to
      // textarea wrapping. Let the browser move first; cross nodes only when
      // it reports no caret movement (the true visual boundary).
      requestAnimationFrame(() => {
        if (!target.isConnected || globalThis.document.activeElement !== target) return;
        if ((target.selectionStart ?? 0) !== start) return;
        commitText();
        let goal = getOutlineGoalColumn();
        if (goal === null) {
          const lineStart = start === 0 ? 0 : localText.lastIndexOf('\n', start - 1) + 1;
          goal = start - lineStart;
          setOutlineGoalColumn(goal);
          const font = getOutlineElementFont(target);
          setOutlineGoalVisual(
            measureOutlineTextWidth(localText.slice(lineStart, start), font),
            font,
          );
        }
        onNavigate(node.id, 'up', goal);
      });
      return;
    }

    // Navigate Down
    if (e.key === 'ArrowDown' && !(e.metaKey || e.ctrlKey)) {
      const start = e.currentTarget.selectionStart ?? 0;
      if (!shouldNavigateAcrossOutlineNode(localText, start, 'down')) return;
      const target = e.currentTarget;
      requestAnimationFrame(() => {
        if (!target.isConnected || globalThis.document.activeElement !== target) return;
        if ((target.selectionStart ?? 0) !== start) return;
        commitText();
        let goal = getOutlineGoalColumn();
        if (goal === null) {
          const lineStart = start === 0 ? 0 : localText.lastIndexOf('\n', start - 1) + 1;
          goal = start - lineStart;
          setOutlineGoalColumn(goal);
          const font = getOutlineElementFont(target);
          setOutlineGoalVisual(
            measureOutlineTextWidth(localText.slice(lineStart, start), font),
            font,
          );
        }
        onNavigate(node.id, 'down', goal);
      });
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      clearOutlineGoalColumn();
      // 两段式 Esc（对齐 Workflowy）：第一次仅退出编辑、保留行焦点；
      // isEscaped 同时挡住聚焦 effect 的自动回编辑，再按 Esc 才清焦点。
      setLocalText(node.text || '');
      localTextRef.current = node.text || '';
      skipNextBlurCommitRef.current = true;
      setIsEscaped(true);
      setIsEditing(false);
      inputRef.current?.blur();
      return;
    }

    // 修饰键 ←→ / Home / End 等水平移动（无 mod 的 ←→ 已在上方 return）
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Home' ||
      e.key === 'End'
    ) {
      clearOutlineGoalColumn();
      return;
    }

    // 普通输入 / 其它按键：重置 goal column
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      clearOutlineGoalColumn();
    }
  }, [isRoot, parentId, indexInParent, node, hasChildren, localText, addNode, setFocusedNodeId, indentNode, outdentNode, deleteNode, commitText, toggleCollapse, collapseAll, expandAll, collapseSubtree, expandSubtree, onNavigate, onZoomIn, onZoomOut, multiSelectBlocksEdit, onBatchIndent, onBatchOutdent, onBatchDelete, nextVisibleNodeId, prevVisibleNodeId, splitNode, mergeWithPrevious, mergeNextIntoCurrent, restoreCaretAfterMerge, storeApi, keymap, updateNode, clearOutlineGoalColumn, requestOutlineCaret, takeOutlineCaret, getOutlineGoalColumn, setOutlineGoalColumn, setOutlineGoalVisual]);

  /**
   * 粘贴语义（E01 C0.2，对齐幕布/Workflowy）：
   * - 结构化列表：光标处拆分当前行（选区被替换），森林以同级插到当前节点之后；
   * - 无结构多行文本：首行并入光标处，其余行按「每行一同级节点」粘贴；
   * - 单行普通文本：走 textarea 原生粘贴；
   * - 「粘贴为子节点」保留在 ⋯ 菜单（内部剪贴板 pasteNodes）。
   */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const plainText = e.clipboardData.getData('text/plain');
    const htmlText = e.clipboardData.getData('text/html');
    const structuredText = looksLikeMarkdownList(plainText)
      ? plainText
      : htmlOutlineToMarkdown(htmlText);

    const target = e.currentTarget;
    const start = target.selectionStart ?? localText.length;
    const end = target.selectionEnd ?? start;
    const left = localText.slice(0, start);
    const right = localText.slice(end);

    // 无结构：多行按行拆同级；单行交给原生粘贴
    let forestMarkdown = structuredText;
    let currentTextOverride: string | null = null;
    if (!structuredText) {
      const lines = plainText.replace(/\r\n?/g, '\n').split('\n');
      const nonEmpty = lines.filter((l) => l.trim().length > 0);
      if (nonEmpty.length <= 1) return;
      // 首行并入光标处，其余行成为同级森林（plain 行解析为扁平节点）
      currentTextOverride = left + nonEmpty[0];
      forestMarkdown = nonEmpty
        .slice(1)
        .map((l) => l.trim())
        .join('\n');
    }
    if (!forestMarkdown) return;

    e.preventDefault();
    clearOutlineGoalColumn();
    skipNextBlurCommitRef.current = true;
    setIsEditing(false);

    // 根节点无法有同级：store 对 root 自动回退为 child，此处直接透传
    if (right.length > 0) {
      // 光标后仍有文本：先按标准语义在光标处拆分（选区被替换、右半成为下方
      // 同级、子树随右半），再把森林插到当前节点与右半之间。
      const leftPart = currentTextOverride ?? left;
      const baseText = leftPart + right;
      localTextRef.current = leftPart;
      setLocalText(leftPart);
      splitNode(node.id, leftPart.length, baseText);
      pasteMarkdownChildren(node.id, forestMarkdown, { position: 'sibling-after' });
    } else {
      const committed = currentTextOverride ?? left;
      localTextRef.current = committed;
      setLocalText(committed);
      pasteMarkdownChildren(node.id, forestMarkdown, {
        position: 'sibling-after',
        currentText: committed,
      });
    }
  }, [localText, node.id, pasteMarkdownChildren, splitNode, clearOutlineGoalColumn]);

  const handleNoteKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 备注区同样需要 IME 护栏，避免组字确认键误触发退出/删除
    if (composingRef.current || isOutlineCompositionActive(e.nativeEvent)) return;

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
  const isTaskNode = node.completed !== undefined;
  const collapsedDescendantCount =
    !isRoot && hasChildren && isCollapsed ? countDescendants(node) : 0;

  // 不显式标注为 React.CSSProperties：用 satisfies 保留推断出的具体属性类型，
  // 使其同时兼容普通元素 style 与 react-textarea-autosize 的 Style
  //（后者 Omit 了 maxHeight/minHeight 且要求 height 为 number）。
  const textStyle = {
    color: node.style?.textColor,
    fontWeight: node.style?.fontWeight === 'bold' ? 'bold' : 'normal',
    fontStyle: node.style?.fontStyle === 'italic' ? 'italic' : undefined,
    textDecoration: node.style?.textDecoration && node.style.textDecoration !== 'none' ? node.style.textDecoration : undefined,
    fontSize: node.style?.headingLevel === 'h1' ? '22px' : node.style?.headingLevel === 'h2' ? '18px' : node.style?.headingLevel === 'h3' ? '16px' : undefined,
  } satisfies React.CSSProperties;

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
        isEntering && "entering",
        isExiting && "agent-exiting",
        isUpdated && "agent-updated"
      )}
      onMouseDown={handleRowMouseDown}
      onClick={handleRowClick}
    >
      {/* 缩进参考线 - 常驻弱显示，悬停加深；焦点节点子树的那条参考线高亮成焦点路径 */}
      {!isRoot && indentLevel > 0 && Array.from({ length: indentLevel }).map((_, i) => {
        return (
          <div
            key={i}
            className={cn('indent-guide', focusGuideIndex === i && 'focus-path')}
            style={{ left: `${BASE_PADDING + i * LEVEL_INDENT + 9}px` }}
          />
        );
      })}

      {/* 拖拽指示器 */}
      {isDropTarget && dropPosition === 'before' && !isBeingDragged && (
        <>
          <div
            className="drop-indicator"
            style={{
              left: `${BASE_PADDING + (projectedLevel ?? level) * LEVEL_INDENT + 9}px`
            }}
          >
            {projectedLevel !== null && (
              <span className="drop-indicator-level" aria-hidden="true">
                {t('outline.dropLevelBadge', {
                  level: projectedLevel,
                  defaultValue: 'L{{level}}',
                })}
              </span>
            )}
          </div>
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

      {/* 左侧控制区容器 - 六点拖拽手柄 + 展开三角 + Bullet */}
      <div
        className="node-left-controls"
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        {/* 独立拖拽手柄（hover 淡入）：与 zoom/选中彻底解耦 */}
        {!isRoot && !reciteMode && (
          <div className="w-[18px] h-[18px] -ml-[36px] flex items-center justify-center">
            <button
              type="button"
              ref={setActivatorNodeRef}
              className="outline-drag-handle"
              {...attributes}
              {...listeners}
              tabIndex={-1}
              aria-label={t('outline.dragToMove')}
              title={t('outline.dragToMove')}
              onClick={(e) => e.stopPropagation()}
            >
              <DotsSixVertical size={14} weight="bold" />
            </button>
          </div>
        )}
        <div
          className={cn(
            "w-[18px] h-[18px] flex items-center justify-center",
            (isRoot || reciteMode) && "-ml-[18px]"
          )}
        >
          {/* 展开/折叠三角：单击切换；⌥ 整个子树；⌘ 全图折叠到此层级 */}
          {!isRoot && hasChildren && (
            <button
              type="button"
              className={cn(
                "collapse-toggle",
                isCollapsed && "is-collapsed"
              )}
              tabIndex={-1}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
              onClick={(e) => {
                e.stopPropagation();
                const rowEl = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-node-id]');
                // ⌘/Ctrl+点击：整图折叠到本行所在层级（对标 Workflowy 的层级折叠）
                if (e.metaKey || e.ctrlKey) {
                  const state = storeApi.getState();
                  const depth = getAncestors(state.document.root, node.id).length;
                  state.collapseToDepth(depth);
                  return;
                }
                // ⌥+点击：折叠/展开整个子树
                if (e.altKey) {
                  if (isCollapsed) {
                    expandSubtree(node.id);
                  } else {
                    animateOutlineCollapse(rowEl, node, () => collapseSubtree(node.id));
                  }
                  return;
                }
                if (isCollapsed) {
                  toggleCollapse(node.id);
                } else {
                  animateOutlineCollapse(rowEl, node, () => toggleCollapse(node.id));
                }
              }}
              title={`${isCollapsed ? t('actions.expand') : t('actions.collapse')} · ${t('outlineV2.collapseToggleHint', { defaultValue: '⌥ 子树 · ⌘ 折叠到此层级' })}`}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" className="transition-transform">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </button>
          )}
        </div>

        {/* 节点 Bullet / 任务 checkbox：单击=选中聚焦，Mod+单击=聚焦缩放 */}
        {!isRoot && (
          <div
            className="node-bullet-container"
            {...(!reciteMode && isCoarsePointer ? { ...attributes, ...listeners } : {})}
            onClick={(e) => {
              e.stopPropagation();
              if (reciteMode) return;
              if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
                onZoomIn(node.id);
                return;
              }
              onRowSelect(node.id, e);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (reciteMode) return;
              onZoomIn(node.id);
            }}
            title={t('mindmap:outline.bulletHint', {
              defaultValue: '单击选中 · 双击聚焦 · ⌘单击聚焦',
            })}
          >
            {isTaskNode ? (
              <motion.span
                className="inline-flex items-center justify-center"
                // 勾选一次「弹一下」：多关键帧只能走 tween，spring 不支持
                animate={node.completed ? { scale: [1, 1.3, 1] } : { scale: 1 }}
                transition={motionSafe({ type: 'tween', duration: 0.25, ease: [0.22, 1, 0.36, 1] })}
              >
                <input
                  type="checkbox"
                  className="outline-task-checkbox"
                  checked={!!node.completed}
                  aria-checked={!!node.completed}
                  aria-label={
                    node.completed
                      ? t('contextMenu.unmarkComplete', { defaultValue: '取消完成' })
                      : t('contextMenu.markComplete', { defaultValue: '标记完成' })
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  onChange={(e) => {
                    e.stopPropagation();
                    if (reciteMode) return;
                    const checked = e.target.checked;
                    const state = storeApi.getState();
                    // hideCompleted 下勾选即隐藏：先播行退场过渡再提交，
                    // 避免整枝瞬间消失（搜索过滤模式优先级更高时不预测）
                    const searchFilterActive =
                      state.searchFilterMode && !!state.searchQuery.trim();
                    const willHide =
                      checked &&
                      state.hideCompleted &&
                      !searchFilterActive &&
                      shouldHideCompletedNode({ ...node, completed: true });
                    if (willHide) {
                      const rowEl =
                        e.currentTarget.closest<HTMLElement>('[data-node-id]');
                      animateOutlineRowsExit(
                        rowEl?.parentElement ?? null,
                        collectVisibleSubtreeIds(node, { includeSelf: true }),
                        () => updateNode(node.id, { completed: true }),
                      );
                      return;
                    }
                    updateNode(node.id, { completed: checked });
                  }}
                />
              </motion.span>
            ) : (
              <div className={cn(
                "node-bullet",
                hasChildren && "has-children",
                hasChildren && isCollapsed && "collapsed"
              )} />
            )}
          </div>
        )}
        {!isRoot && hasChildren && isCollapsed && collapsedDescendantCount > 0 && (
          <span
            className="outline-collapse-count"
            role="button"
            tabIndex={0}
            title={t('actions.expand', { defaultValue: '展开' })}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                toggleCollapse(node.id);
              }
            }}
          >
            +{collapsedDescendantCount}
          </span>
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
          setIsEscaped(false);
          setFocusedNodeId(node.id);
        }}
      >
        {reciteMode ? (
          <BlankedText
            text={node.text || (isRoot ? t('placeholder.root') : t('placeholder.node'))}
            blankedRanges={node.blankedRanges || []}
            revealedIndices={revealedForNode}
            reciteMode={reciteMode}
            onRevealBlank={(rangeIndex) => revealBlank(node.id, rangeIndex)}
            onAddBlank={(range) => addBlankRange(node.id, range)}
            onRemoveBlank={(rangeIndex) => removeBlankRange(node.id, rangeIndex)}
            className={cn(
              "node-input cursor-default select-text",
              isRoot && "root",
              "transition-colors duration-200",
            node.completed && "line-through text-muted-foreground"
            )}
            style={textStyle}
          />
        ) : isEditing ? (
        <>
        <TextareaAutosize
          ref={inputRef}
          data-mm-outline-input="true"
          className={cn(
            "node-input resize-none overflow-hidden block w-full",
            isRoot && "root",
            "transition-colors duration-200",
            node.completed && "line-through text-muted-foreground"
          )}
          style={textStyle}
          minRows={1}
          value={localText}
          onChange={(e) => {
            clearOutlineGoalColumn();
            setLocalText(e.target.value);
          }}
          placeholder={isRoot ? t('placeholder.root') : t('placeholder.node')}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onFocus={() => setIsEditing(true)}
          onMouseDown={() => {
            // 鼠标改光标后不应继续沿用旧 goal column
            clearOutlineGoalColumn();
          }}
          onMouseUp={handleEditSelectionMouseUp}
          onTouchEnd={handleEditSelectionMouseUp}
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
              "transition-colors duration-200",
            node.completed && "line-through text-muted-foreground"
            )}
            style={textStyle}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) return;
              e.stopPropagation();
              onRowSelect(node.id, e);
              if (!isMultiSelectActive) {
                setIsEscaped(false);
                setIsEditing(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }
            }}
          >
            <BlankedText
              text={localText || (isRoot ? t('placeholder.root') : t('placeholder.node'))}
              blankedRanges={node.blankedRanges || []}
              revealedIndices={revealedForNode}
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
              "transition-colors duration-200",
            node.completed && "line-through text-muted-foreground"
            )}
            style={textStyle}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) return;
              e.stopPropagation();
              onRowSelect(node.id, e);
              if (!isMultiSelectActive) {
                setIsEscaped(false);
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
          <div
            className={cn(
              "node-note px-[6px] pb-1 text-[13px] text-[var(--mm-text-secondary)] whitespace-pre-wrap cursor-text",
              descriptionPreview === 'first-line' && 'node-note-first-line',
            )}
            onClick={() => !reciteMode && setIsEditingNote(true)}
            title={descriptionPreview === 'first-line' ? node.note : undefined}
          >
            {containsLatex(node.note) || !showTextHighlight ? (
              <InlineLatex text={node.note} />
            ) : (
              <SearchHighlightedText text={node.note} query={searchQuery} enabled />
            )}
          </div>
        )}
        {isEditingNote && !reciteMode && (
          <TextareaAutosize
            ref={noteRef}
            className="node-note-input"
            value={localNote}
            onChange={(e) => setLocalNote(e.target.value)}
            onKeyDown={handleNoteKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
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
                onZoomIn(node.id);
              }}
              title={t('outline.enterFocusMode')}
            >
              <MagnifyingGlassPlus size={16} />
            </NotionButton>
            <OutlineNodeMenu
              node={node}
              isRoot={isRoot}
              parentId={parentId}
              indexInParent={indexInParent}
              keymap={keymap}
              onEditNote={() => setIsEditingNote(true)}
              onOpenResourcePicker={onOpenResourcePicker}
            />
          </>
        )}
      </div>
      )}

      {/* 下方拖拽指示器 */}
      {isDropTarget && dropPosition === 'after' && !isBeingDragged && (
        <>
          <div
            className="drop-indicator"
            style={{
              bottom: 0,
              top: 'auto',
              left: `${BASE_PADDING + (projectedLevel ?? level) * LEVEL_INDENT + 9}px`
            }}
          >
            {projectedLevel !== null && (
              <span className="drop-indicator-level" aria-hidden="true">
                {t('outline.dropLevelBadge', {
                  level: projectedLevel,
                  defaultValue: 'L{{level}}',
                })}
              </span>
            )}
          </div>
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

/**
 * flatNode 每次 flatten 都是新包装对象，按字段比较；
 * node 引用依赖 store immer 的结构共享，未变更子树保持同一引用。
 * dropPosition 仅在拖拽悬停到本行时才有意义，其余情况忽略其抖动。
 */
function areRowPropsEqual(
  prev: Readonly<SortableOutlineNodeProps>,
  next: Readonly<SortableOutlineNodeProps>,
): boolean {
  const a = prev.flatNode;
  const b = next.flatNode;
  if (
    a.node !== b.node ||
    a.level !== b.level ||
    a.parentId !== b.parentId ||
    a.indexInParent !== b.indexInParent
  ) {
    return false;
  }
  for (const key of Object.keys(next) as (keyof SortableOutlineNodeProps)[]) {
    if (key === 'flatNode') continue;
    if (key === 'dropPosition' && !prev.isDropTarget && !next.isDropTarget) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

export const SortableOutlineNode = React.memo(SortableOutlineNodeImpl, areRowPropsEqual);
SortableOutlineNode.displayName = 'SortableOutlineNode';
