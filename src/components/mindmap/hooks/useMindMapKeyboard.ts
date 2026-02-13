/**
 * 思维导图画布键盘导航与操作 Hook
 *
 * 当节点被选中（focusedNodeId != null）且不在编辑模式时，
 * 处理方向键导航、节点增删、折叠展开等快捷键。
 */

import { useEffect, useCallback } from 'react';
import { useMindMapStore } from '../store';
import { flattenVisibleNodes } from '../utils/node/traverse';
import { findNodeById, findParentNode } from '../utils/node/find';

// ============================================================================
// Hook
// ============================================================================

export function useMindMapKeyboard(): void {
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
  const moveNode = useMindMapStore(s => s.moveNode);
  const toggleCollapse = useMindMapStore(s => s.toggleCollapse);
  const updateNode = useMindMapStore(s => s.updateNode);
  const setEditingNoteNodeId = useMindMapStore(s => s.setEditingNoteNodeId);
  const undo = useMindMapStore(s => s.undo);
  const redo = useMindMapStore(s => s.redo);
  const save = useMindMapStore(s => s.save);
  const reciteMode = useMindMapStore(s => s.reciteMode);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const tagName = target.tagName;
    const isMod = e.metaKey || e.ctrlKey;
    const lowerKey = e.key.toLowerCase();
    const isTextInputContext = tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;

    // 辅助：处理快捷键后阻止冒泡，防止命令系统重复处理
    const handled = () => { e.stopPropagation(); };

    // ── 全局快捷键（即使在编辑模式也生效） ──

    // Cmd+S → 保存
    if (isMod && e.key === 's') {
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

    // Escape → 退出编辑 / 取消选中
    if (e.key === 'Escape') {
      e.preventDefault();
      handled();
      if (editingNodeId) {
        setEditingNodeId(null);
      } else if (editingNoteNodeId) {
        setEditingNoteNodeId(null);
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
          // 背诵模式：Enter/空格不做操作（挖空揭示由点击完成）
          e.preventDefault();
          handled();
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

    // ── Cmd 组合键 ──
    if (isMod) {
      switch (e.key) {
        case 'ArrowUp': {
          e.preventDefault();
          handled();
          const parent = findParentNode(root, focusedNodeId);
          if (!parent) return;
          const idx = parent.children.findIndex(c => c.id === focusedNodeId);
          if (idx > 0) {
            moveNode(focusedNodeId, parent.id, idx - 1);
          }
          return;
        }
        case 'ArrowDown': {
          e.preventDefault();
          handled();
          const parent = findParentNode(root, focusedNodeId);
          if (!parent) return;
          const idx = parent.children.findIndex(c => c.id === focusedNodeId);
          if (idx < parent.children.length - 1) {
            moveNode(focusedNodeId, parent.id, idx + 2);
          }
          return;
        }
        case '[': {
          // 折叠（阻止冒泡，防止与 nav.back 冲突）
          e.preventDefault();
          handled();
          const node = findNodeById(root, focusedNodeId);
          if (node && node.children.length > 0 && !node.collapsed) {
            toggleCollapse(focusedNodeId);
          }
          return;
        }
        case ']': {
          // 展开（阻止冒泡，防止与 nav.forward 冲突）
          e.preventDefault();
          handled();
          const node = findNodeById(root, focusedNodeId);
          if (node && node.collapsed) {
            toggleCollapse(focusedNodeId);
          }
          return;
        }
        case 'b': {
          e.preventDefault();
          handled();
          const node = findNodeById(root, focusedNodeId);
          if (node) {
            updateNode(focusedNodeId, {
              style: {
                ...node.style,
                fontWeight: node.style?.fontWeight === 'bold' ? undefined : 'bold',
              },
            });
          }
          return;
        }
        case 'Enter': {
          e.preventDefault();
          handled();
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
        // Tab → 添加子节点
        e.preventDefault();
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
    addNode, deleteNodes, moveNode, toggleCollapse, updateNode,
    undo, redo, save, reciteMode,
  ]);

  useEffect(() => {
    // 注册在 document 上：handled() 中的 stopPropagation 可阻止事件到达 window 层的命令系统
    // 注：使用 window.document 避免与组件内 MindMapDocument 变量 shadowing
    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
