/**
 * 大纲视图子组件共享：布局常量、类型、搜索高亮、快捷键文案、store action 快照。
 */

import React, { useMemo } from 'react';
import { useMindMapStore, useMindMapStoreApi } from '../../store';
import { splitSearchHighlights, type OutlineFlatNode } from '../../utils/searchFilter';
import type { MindMapKeymap } from '../../utils/mindmapPreferences';

export const LEVEL_INDENT = 28; // Increased indent for better hierarchy
export const BASE_PADDING = 12;

export type DropPosition = 'before' | 'after' | 'inside';

export type FlatNode = OutlineFlatNode;

export const SearchHighlightedText: React.FC<{
  text: string;
  query: string;
  enabled?: boolean;
}> = ({ text, query, enabled = true }) => {
  // W10：高亮与命中同用 store 的 searchOptions，避免大小写/全词设置下不同步
  const searchOptions = useMindMapStore(state => state.searchOptions);
  if (!enabled || !query.trim()) return <>{text}</>;
  const parts = splitSearchHighlights(text, query, searchOptions);
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

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '');

export interface OutlineShortcutLabels {
  addChild: string;
  addSibling: string;
  note: string;
  toggleComplete: string | undefined;
  collapse: string;
  expand: string;
  copy: string;
  cut: string;
  paste: string;
}

/** 「⋯」菜单快捷键文案：随 keymap（deep-student / classic）与平台变化 */
export function getOutlineShortcutLabels(keymap: MindMapKeymap): OutlineShortcutLabels {
  const mod = IS_MAC ? '⌘' : 'Ctrl+';
  const alt = IS_MAC ? '⌥' : 'Alt+';
  const shift = IS_MAC ? '⇧' : 'Shift+';
  const isClassic = keymap === 'classic';
  return {
    addChild: isClassic ? `${shift}${mod}Enter` : `${mod}Enter`,
    addSibling: 'Enter',
    note: isClassic ? `${shift}Enter` : `${shift}${mod}Enter`,
    toggleComplete: isClassic ? `${mod}Enter` : undefined,
    // 经典大纲键位把 Mod+[/] 留给缩放，折叠走 Alt+[/]
    collapse: isClassic ? `${alt}[` : `${mod}[`,
    expand: isClassic ? `${alt}]` : `${mod}]`,
    copy: `${mod}C`,
    cut: `${mod}X`,
    paste: `${mod}V`,
  };
}

/**
 * 一次性取出行组件需要的 store actions（zustand action 引用稳定，
 * 不订阅即可避免每行 ~20 个 selector 带来的重渲染与订阅开销）。
 */
export function useOutlineStoreActions() {
  const storeApi = useMindMapStoreApi();
  return useMemo(() => {
    const {
      updateNode,
      addNode,
      deleteNode,
      deleteNodes,
      moveNode,
      moveNodes,
      toggleCollapse,
      collapseAll,
      expandAll,
      collapseSubtree,
      expandSubtree,
      setFocusedNodeId,
      indentNode,
      outdentNode,
      indentNodes,
      outdentNodes,
      splitNode,
      mergeWithPrevious,
      mergeNextIntoCurrent,
      copyNodes,
      cutNodes,
      pasteNodes,
      revealBlank,
      addBlankRange,
      removeBlankRange,
      removeNodeRef,
      addNodeRef,
      pasteMarkdownChildren,
      setSelection,
      setSelectionAnchorId,
      setViewRootId,
      toggleCompleted,
    } = storeApi.getState();
    return {
      updateNode,
      addNode,
      deleteNode,
      deleteNodes,
      moveNode,
      moveNodes,
      toggleCollapse,
      collapseAll,
      expandAll,
      collapseSubtree,
      expandSubtree,
      setFocusedNodeId,
      indentNode,
      outdentNode,
      indentNodes,
      outdentNodes,
      splitNode,
      mergeWithPrevious,
      mergeNextIntoCurrent,
      copyNodes,
      cutNodes,
      pasteNodes,
      revealBlank,
      addBlankRange,
      removeBlankRange,
      removeNodeRef,
      addNodeRef,
      pasteMarkdownChildren,
      setSelection,
      setSelectionAnchorId,
      setViewRootId,
      toggleCompleted,
    };
  }, [storeApi]);
}

export type OutlineStoreActions = ReturnType<typeof useOutlineStoreActions>;
