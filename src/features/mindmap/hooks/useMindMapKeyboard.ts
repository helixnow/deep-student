/**
 * 思维导图画布键盘导航与操作 Hook
 *
 * 当节点被选中（focusedNodeId != null）且不在编辑模式时，
 * 处理方向键导航、节点增删、折叠展开等快捷键。
 */

import { useEffect, useCallback, type RefObject } from 'react';
import { useMindMapStore } from '../store';
import { useMindMapIsActive } from '../MindMapActiveContext';
import { collectTopLevelNodeIds, flattenVisibleNodes } from '../utils/node/traverse';
import { findNodeById, findParentNode } from '../utils/node/find';
import type { MindMapNode, NodeStyle } from '../types';
import { findNextUnrevealedBlank } from '../utils/reciteNavigation';
import {
  findSpatialMindMapNeighbor,
  getMindMapPreferences,
} from '../utils/mindmapPreferences';
import { eventMatchesShortcut } from '../constants/shortcuts';

// ============================================================================
// Hook
// ============================================================================

export interface UseMindMapKeyboardOptions {
  /**
   * 空间导航的 DOM 查询范围。分屏/多实例同时挂载多套画布时，
   * 必须限定在本实例容器内，否则 `.react-flow__node` 全局查询会把
   * 相邻画布的节点当成空间邻居（跨实例串扰）。
   */
  containerRef?: RefObject<HTMLElement | null>;
}

export function useMindMapKeyboard(options?: UseMindMapKeyboardOptions): void {
  const containerRef = options?.containerRef;
  // ★ 标签页保活：非活跃实例不得响应全局按键，否则每个挂载实例都会处理一次。
  const isActive = useMindMapIsActive();
  const focusedNodeId = useMindMapStore(s => s.focusedNodeId);
  const editingNodeId = useMindMapStore(s => s.editingNodeId);
  const editingNoteNodeId = useMindMapStore(s => s.editingNoteNodeId);
  const selection = useMindMapStore(s => s.selection);
  const document = useMindMapStore(s => s.document);
  const setFocusedNodeId = useMindMapStore(s => s.setFocusedNodeId);
  const setEditingNodeId = useMindMapStore(s => s.setEditingNodeId);
  const setSelection = useMindMapStore(s => s.setSelection);
  const addNode = useMindMapStore(s => s.addNode);
  const deleteNodes = useMindMapStore(s => s.deleteNodes);
  // moveNode 单节点版已由 moveNodes 批量版覆盖（Cmd+↑↓ 支持整选中集移动）
  const moveNodes = useMindMapStore(s => s.moveNodes);
  const indentNodes = useMindMapStore(s => s.indentNodes);
  const outdentNodes = useMindMapStore(s => s.outdentNodes);
  // store 并行迭代中的新 action：存在则优先使用，不存在则本地回退计算
  const selectAllVisible = useMindMapStore(
    s => (s as unknown as { selectAllVisible?: () => void }).selectAllVisible,
  );
  // store 并行迭代中的新 action（W01）：duplicateNodes(nodeIds) → 新节点 id 数组 | null
  const duplicateNodes = useMindMapStore(
    s => (s as unknown as { duplicateNodes?: (nodeIds: string[]) => string[] | null }).duplicateNodes,
  );
  const toggleCollapse = useMindMapStore(s => s.toggleCollapse);
  const collapseAll = useMindMapStore(s => s.collapseAll);
  const expandAll = useMindMapStore(s => s.expandAll);
  const updateNode = useMindMapStore(s => s.updateNode);
  const setEditingNoteNodeId = useMindMapStore(s => s.setEditingNoteNodeId);
  const undo = useMindMapStore(s => s.undo);
  const redo = useMindMapStore(s => s.redo);
  const save = useMindMapStore(s => s.save);
  const reciteMode = useMindMapStore(s => s.reciteMode);
  const revealedBlanks = useMindMapStore(s => s.revealedBlanks);
  const revealBlank = useMindMapStore(s => s.revealBlank);
  const setReciteMode = useMindMapStore(s => s.setReciteMode);
  const viewRootId = useMindMapStore(s => s.viewRootId);
  const setViewRootId = useMindMapStore(s => s.setViewRootId);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const tagName = target.tagName;
    const isMod = e.metaKey || e.ctrlKey;
    const lowerKey = e.key.toLowerCase();
    const isTextInputContext = tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;

    // 辅助：处理快捷键后阻止冒泡，防止命令系统重复处理
    const handled = () => { e.stopPropagation(); };

    // ── 全局快捷键（即使在编辑模式也生效） ──

    // Cmd+S → 保存（用 lowerKey，避免 Caps Lock 下失效）
    if (isMod && lowerKey === 's') {
      e.preventDefault();
      handled();
      void save();
      return;
    }

    // Cmd/Ctrl+Z / Shift+Z / Y → 全局撤销重做（不依赖节点焦点）
    if (isMod && lowerKey === 'z') {
      if (isTextInputContext || editingNodeId || editingNoteNodeId) {
        return;
      }
      e.preventDefault();
      handled();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }

    if (isMod && lowerKey === 'y') {
      if (isTextInputContext || editingNodeId || editingNoteNodeId) {
        return;
      }
      e.preventDefault();
      handled();
      redo();
      return;
    }

    // Escape → 退出编辑 / 退出背诵 / 取消选中
    // 搜索栏 Esc 由 MindMapContentView 在 window capture 阶段优先处理并 stopPropagation，
    // 本 listener 挂在 document 冒泡，搜索打开时不会走到这里。
    // 节点编辑态的 Esc 由 NodeContent 的 textarea 就地处理（恢复 draft + stopPropagation），
    // 正常不会冒泡到 document；下面的 editingNodeId 分支仅是兜底
    // （编辑态残留但焦点已不在 textarea 的异常场景），不会抢跑吞掉 draft。
    if (e.key === 'Escape') {
      // 无编辑/背诵/选中/焦点时导图对 Esc 无事可做：放行给外层
      // （工作台窗口、命令系统等），不得 preventDefault/stopPropagation 吞掉。
      const hasEscapeTarget =
        !!editingNodeId || !!editingNoteNodeId || reciteMode
        || !!focusedNodeId || selection.length > 0;
      if (!hasEscapeTarget) return;
      e.preventDefault();
      handled();
      if (editingNodeId) {
        setEditingNodeId(null);
      } else if (editingNoteNodeId) {
        setEditingNoteNodeId(null);
      } else if (reciteMode) {
        // ★ 背诵模式逃生舱：按 Esc 退出背诵模式
        setReciteMode(false);
      } else {
        setFocusedNodeId(null);
        setSelection([]);
      }
      return;
    }

    // ── 编辑模式下，其余快捷键交给 input/textarea 处理 ──
    if (editingNodeId || editingNoteNodeId) return;

    // ── 如果焦点在输入控件上，跳过 ──
    if (isTextInputContext) return;

    // Cmd+A → 全选可见节点（不依赖焦点；背诵模式下禁用编辑类选择）
    if (isMod && lowerKey === 'a' && !reciteMode) {
      e.preventDefault();
      handled();
      if (typeof selectAllVisible === 'function') {
        // store 新增的 selectAllVisible（并行迭代中），存在则直接使用
        selectAllVisible();
      } else {
        // 回退：本地展平可见节点（不含根，与 cut/delete 的根保护语义一致）
        const visibleIds = flattenVisibleNodes(document.root)
          .map((entry) => entry.node.id)
          .filter((id) => id !== document.root.id);
        if (visibleIds.length > 0) {
          setSelection(visibleIds);
          if (!focusedNodeId) setFocusedNodeId(visibleIds[0]);
        }
      }
      return;
    }

    // ── 无选中节点时，跳过 ──
    if (!focusedNodeId) return;

    // ── 背诵模式下：仅允许导航和折叠/展开，屏蔽所有编辑操作 ──
    if (reciteMode) {
      const root = document.root;
      const visibleNodes = flattenVisibleNodes(root);
      const currentIndex = visibleNodes.findIndex(n => n.node.id === focusedNodeId);

      switch (e.key) {
        case 'ArrowUp': {
          e.preventDefault();
          if (currentIndex > 0) {
            setFocusedNodeId(visibleNodes[currentIndex - 1].node.id);
          }
          return;
        }
        case 'ArrowDown': {
          e.preventDefault();
          if (currentIndex < visibleNodes.length - 1) {
            setFocusedNodeId(visibleNodes[currentIndex + 1].node.id);
          }
          return;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          const node = findNodeById(root, focusedNodeId);
          if (node && node.children.length > 0 && !node.collapsed) {
            toggleCollapse(focusedNodeId);
          } else {
            const parent = findParentNode(root, focusedNodeId);
            if (parent) setFocusedNodeId(parent.id);
          }
          return;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const node = findNodeById(root, focusedNodeId);
          if (node && node.collapsed) {
            toggleCollapse(focusedNodeId);
          } else if (node && node.children.length > 0) {
            setFocusedNodeId(node.children[0].id);
          }
          return;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          handled();
          const target = findNextUnrevealedBlank(
            visibleNodes.map((entry) => entry.node),
            focusedNodeId,
            revealedBlanks,
          );
          if (target) {
            setFocusedNodeId(target.nodeId);
            revealBlank(target.nodeId, target.rangeIndex);
          }
          return;
        }
        default:
          // 背诵模式下屏蔽其他所有按键（Tab、Delete、F2 等）
          return;
      }
    }

    const root = document.root;
    const visibleNodes = flattenVisibleNodes(root);
    const currentIndex = visibleNodes.findIndex(n => n.node.id === focusedNodeId);
    const preferences = getMindMapPreferences();

    const focusSpatialNeighbor = (direction: 'up' | 'down' | 'left' | 'right'): boolean => {
      if (preferences.canvasNavigation !== 'spatial') return false;
      // ★ 查询范围限定本实例容器：分屏双画布下全局查询会把另一实例的
      // 节点当成候选邻居，导致焦点跳进别的导图。
      const queryRoot: ParentNode = containerRef?.current ?? globalThis.document;
      const escaped = typeof CSS?.escape === 'function' ? CSS.escape(focusedNodeId) : focusedNodeId;
      const current = queryRoot.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`);
      if (!current) return false;
      const candidates = Array.from(queryRoot.querySelectorAll<HTMLElement>('.react-flow__node[data-id]'))
        .filter((element) => element !== current && !!element.dataset.id)
        .map((element) => ({ id: element.dataset.id!, rect: element.getBoundingClientRect() }));
      const nextId = findSpatialMindMapNeighbor(current.getBoundingClientRect(), candidates, direction);
      if (!nextId) return false;
      setFocusedNodeId(nextId);
      return true;
    };

    /**
     * Cmd/Alt+↑/↓ 批量上移/下移：作用于整个选中集（无多选时只动焦点节点）。
     * 选中集须同父才做块移动（非连续选中会被聚拢成块）；
     * 跨父级多选时退化为仅移动焦点节点。
     */
    const moveFocusedOrSelection = (direction: 'up' | 'down') => {
      const targetIds = selection.length > 0 ? selection : [focusedNodeId];
      let ids = collectTopLevelNodeIds(root, targetIds, { excludeRoot: true });
      if (ids.length === 0) return;
      let parent = findParentNode(root, ids[0]);
      if (!parent) return;
      let indices = ids.map((id) => parent!.children.findIndex((c) => c.id === id));
      if (indices.some((i) => i < 0)) {
        parent = findParentNode(root, focusedNodeId);
        if (!parent) return;
        const idx = parent.children.findIndex((c) => c.id === focusedNodeId);
        if (idx < 0) return;
        ids = [focusedNodeId];
        indices = [idx];
      }
      const ordered = ids
        .map((id, i) => ({ id, index: indices[i] }))
        .sort((a, b) => a.index - b.index);
      const sortedIds = ordered.map((entry) => entry.id);
      const minIdx = ordered[0].index;
      const maxIdx = ordered[ordered.length - 1].index;
      if (direction === 'up') {
        if (minIdx > 0) moveNodes(sortedIds, parent.id, minIdx - 1);
      } else if (maxIdx < parent.children.length - 1) {
        moveNodes(sortedIds, parent.id, maxIdx + 2);
      }
    };

    // Fold is independent from zoom in both keymaps.
    if (e.altKey && (e.key === '[' || e.key === ']')) {
      e.preventDefault();
      handled();
      if (e.shiftKey) {
        if (e.key === '[') collapseAll();
        else expandAll();
        return;
      }
      const node = findNodeById(root, focusedNodeId);
      if (node?.children.length && ((e.key === '[' && !node.collapsed) || (e.key === ']' && node.collapsed))) {
        toggleCollapse(focusedNodeId);
      }
      return;
    }

    // ── Alt+方向键（常见导图软件惯例，两种键位方案共用；C4） ──
    // Alt+↑/↓ 同级上移/下移；Alt+←/→ 反缩进/缩进（画布侧 outdent/indent 等价，
    // 大纲语义由 OutlineView 自行处理编辑态）
    if (!isMod && e.altKey && !e.shiftKey) {
      if (eventMatchesShortcut(e, 'alt+ArrowUp') || eventMatchesShortcut(e, 'alt+ArrowDown')) {
        e.preventDefault();
        handled();
        moveFocusedOrSelection(e.key === 'ArrowUp' ? 'up' : 'down');
        return;
      }
      if (eventMatchesShortcut(e, 'alt+ArrowLeft')) {
        e.preventDefault();
        handled();
        outdentNodes(selection.length > 0 ? selection : [focusedNodeId]);
        return;
      }
      if (eventMatchesShortcut(e, 'alt+ArrowRight')) {
        e.preventDefault();
        handled();
        indentNodes(selection.length > 0 ? selection : [focusedNodeId]);
        return;
      }
    }

    // ── Cmd 组合键 ──
    if (isMod) {
      // Cmd+D → duplicate 选中集（store 新 action，W01 并行实现；C5）
      if (eventMatchesShortcut(e, 'mod+d')) {
        e.preventDefault();
        handled();
        if (typeof duplicateNodes === 'function') {
          const targetIds = selection.length > 0 ? selection : [focusedNodeId];
          const newIds = duplicateNodes(
            collectTopLevelNodeIds(root, targetIds, { excludeRoot: true }),
          );
          if (newIds && newIds.length > 0) {
            setSelection(newIds);
            setFocusedNodeId(newIds[newIds.length - 1]);
          }
        }
        return;
      }

      // Cmd+B / Cmd+I / Cmd+U → 文本样式，作用于整个选中集（单次 undo）
      if (lowerKey === 'b' || lowerKey === 'i' || lowerKey === 'u') {
        e.preventDefault();
        handled();
        const targetIds = selection.length > 0 ? selection : [focusedNodeId];
        const nodes = Array.from(new Set(targetIds))
          .map((id) => findNodeById(root, id))
          .filter((node): node is MindMapNode => !!node);
        if (nodes.length === 0) return;
        // 统一切换：只要有一个未生效则全部生效，否则全部取消
        const isOn = (style: NodeStyle | undefined): boolean =>
          lowerKey === 'b'
            ? style?.fontWeight === 'bold'
            : lowerKey === 'i'
              ? style?.fontStyle === 'italic'
              : style?.textDecoration === 'underline';
        const enable = nodes.some((node) => !isOn(node.style));
        nodes.forEach((node, index) => {
          const style: NodeStyle = { ...node.style };
          if (lowerKey === 'b') style.fontWeight = enable ? 'bold' : undefined;
          else if (lowerKey === 'i') style.fontStyle = enable ? 'italic' : undefined;
          else style.textDecoration = enable ? 'underline' : undefined;
          // 首个节点记录历史快照，其余跳过 → 一次 undo 还原整批
          updateNode(node.id, { style }, index === 0 ? undefined : { skipHistory: true });
        });
        return;
      }

      switch (e.key) {
        case 'ArrowUp': {
          e.preventDefault();
          handled();
          moveFocusedOrSelection('up');
          return;
        }
        case 'ArrowDown': {
          e.preventDefault();
          handled();
          moveFocusedOrSelection('down');
          return;
        }
        case '[': {
          e.preventDefault();
          handled();
          if (preferences.keymap === 'classic') {
            const parent = viewRootId ? findParentNode(root, viewRootId) : null;
            setViewRootId(parent && parent.id !== root.id ? parent.id : null);
            return;
          }
          if (e.shiftKey) {
            collapseAll();
            return;
          }
          const node = findNodeById(root, focusedNodeId);
          if (node && node.children.length > 0 && !node.collapsed) {
            toggleCollapse(focusedNodeId);
          }
          return;
        }
        case ']': {
          e.preventDefault();
          handled();
          if (preferences.keymap === 'classic') {
            setViewRootId(focusedNodeId === root.id ? null : focusedNodeId);
            return;
          }
          if (e.shiftKey) {
            expandAll();
            return;
          }
          const node = findNodeById(root, focusedNodeId);
          if (node && node.collapsed) {
            toggleCollapse(focusedNodeId);
          }
          return;
        }
        case 'Enter': {
          e.preventDefault();
          handled();
          if (preferences.keymap === 'classic' && !e.shiftKey) {
            const node = findNodeById(root, focusedNodeId);
            if (node) updateNode(focusedNodeId, { completed: !node.completed });
            return;
          }
          const newId = addNode(focusedNodeId, 0);
          if (newId) {
            setFocusedNodeId(newId);
            setEditingNodeId(newId);
          }
          return;
        }
        default:
          break;
      }
      return;
    }

    // ── 普通键 ──
    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault();
        if (focusSpatialNeighbor('up')) return;
        if (currentIndex > 0) {
          setFocusedNodeId(visibleNodes[currentIndex - 1].node.id);
        }
        return;
      }
      case 'ArrowDown': {
        e.preventDefault();
        if (focusSpatialNeighbor('down')) return;
        if (currentIndex < visibleNodes.length - 1) {
          setFocusedNodeId(visibleNodes[currentIndex + 1].node.id);
        }
        return;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (focusSpatialNeighbor('left')) return;
        const node = findNodeById(root, focusedNodeId);
        if (node && node.children.length > 0 && !node.collapsed) {
          // 有展开的子节点 → 折叠
          toggleCollapse(focusedNodeId);
        } else {
          // 否则 → 跳到父节点
          const parent = findParentNode(root, focusedNodeId);
          if (parent) {
            setFocusedNodeId(parent.id);
          }
        }
        return;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (focusSpatialNeighbor('right')) return;
        const node = findNodeById(root, focusedNodeId);
        if (node && node.collapsed) {
          // 折叠状态 → 展开
          toggleCollapse(focusedNodeId);
        } else if (node && node.children.length > 0) {
          // 有子节点 → 跳到第一个子节点
          setFocusedNodeId(node.children[0].id);
        }
        return;
      }
      case 'Enter': {
        if (e.shiftKey) {
          e.preventDefault();
          setEditingNoteNodeId(focusedNodeId);
          return;
        }
        e.preventDefault();
        if (root.id === focusedNodeId) {
          // 根节点 → 添加子节点
          const newId = addNode(focusedNodeId, 0);
          if (newId) {
            setFocusedNodeId(newId);
            setEditingNodeId(newId);
          }
        } else {
          const parent = findParentNode(root, focusedNodeId);
          if (parent) {
            const idx = parent.children.findIndex(c => c.id === focusedNodeId);
            const newId = addNode(parent.id, idx + 1);
            if (newId) {
              setFocusedNodeId(newId);
              setEditingNodeId(newId);
            }
          }
        }
        return;
      }
      case 'Tab': {
        e.preventDefault();
        // Shift+Tab → 反缩进（作用于整个选中集，与大纲对齐）
        if (e.shiftKey) {
          handled();
          outdentNodes(selection.length > 0 ? selection : [focusedNodeId]);
          return;
        }
        // 多选时 Tab 批量缩进；单选保持画布语义：添加子节点
        if (selection.length > 1) {
          handled();
          indentNodes(selection);
          return;
        }
        const newId = addNode(focusedNodeId, 0);
        if (newId) {
          setFocusedNodeId(newId);
          setEditingNodeId(newId);
        }
        return;
      }
      case 'Delete':
      case 'Backspace': {
        // 删除节点（支持多选，且不能删根节点）
        // Delete/Backspace 在 SPECIAL_KEYS 中，需 stopPropagation 防止命令系统拦截
        e.preventDefault();
        handled();
        const targetIds = selection.length > 0 ? selection : [focusedNodeId];
        deleteNodes(targetIds);
        return;
      }
      case 'F2':
      case ' ': {
        // F2 在 SPECIAL_KEYS 中，需 stopPropagation
        e.preventDefault();
        handled();
        setEditingNodeId(focusedNodeId);
        return;
      }
      default:
        break;
    }
  }, [
    focusedNodeId, editingNodeId, editingNoteNodeId, selection, document,
    setFocusedNodeId, setEditingNodeId, setEditingNoteNodeId, setSelection,
    addNode, deleteNodes, moveNodes, indentNodes, outdentNodes, selectAllVisible, duplicateNodes,
    toggleCollapse, collapseAll, expandAll, updateNode,
    undo, redo, save, reciteMode, revealedBlanks, revealBlank, setReciteMode,
    viewRootId, setViewRootId, containerRef,
  ]);

  useEffect(() => {
    if (!isActive) return;
    // 注册在 document 上：handled() 中的 stopPropagation 可阻止事件到达 window 层的命令系统
    // 注：使用 window.document 避免与组件内 MindMapDocument 变量 shadowing
    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, isActive]);
}
