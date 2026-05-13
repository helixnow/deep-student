import { useEffect, useCallback } from 'react';
import { useMindMapStore } from '../store';
import { findNodeById } from '../utils/node/find';
import type { MindMapNode } from '../types';
import { copyTextToClipboard, readTextFromClipboard } from '@/utils/clipboardUtils';

/** 将节点树递归序列化为纯文本（每行一个节点，缩进表示层级） */
function nodesToText(nodes: MindMapNode[], level = 0): string {
  return nodes
    .map((n) => {
      const indent = '  '.repeat(level);
      const childText = n.children?.length ? '\n' + nodesToText(n.children, level + 1) : '';
      return `${indent}${n.text}${childText}`;
    })
    .join('\n');
}

/** 写入系统剪贴板（静默失败，不阻塞流程） */
async function writeToSystemClipboard(text: string): Promise<void> {
  try { await copyTextToClipboard(text); } catch { /* 权限被拒 */ }
}

/** 从系统剪贴板读取纯文本（失败时返回 null） */
async function readFromSystemClipboard(): Promise<string | null> {
  try { return await readTextFromClipboard(); } catch { return null; }
}

export function useMindMapClipboard(): void {
  const document = useMindMapStore(s => s.document);
  const focusedNodeId = useMindMapStore(s => s.focusedNodeId);
  const selection = useMindMapStore(s => s.selection);
  const editingNodeId = useMindMapStore(s => s.editingNodeId);
  const clipboard = useMindMapStore(s => s.clipboard);
  const copyNodes = useMindMapStore(s => s.copyNodes);
  const cutNodes = useMindMapStore(s => s.cutNodes);
  const pasteNodes = useMindMapStore(s => s.pasteNodes);
  const addNode = useMindMapStore(s => s.addNode);
  const updateNode = useMindMapStore(s => s.updateNode);

  /** 从系统剪贴板粘贴外部文本为子节点 */
  const handlePasteExternal = useCallback(async (targetId: string) => {
    const text = await readFromSystemClipboard();
    if (!text?.trim()) return;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const newId = addNode(targetId);
      if (newId) updateNode(newId, { text: line });
    }
  }, [addNode, updateNode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (editingNodeId) return;

      const activeNodes = selection.length > 0
        ? selection
        : focusedNodeId
          ? [focusedNodeId]
          : [];

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      const isMod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (!isMod) return;

      if (key === 'c') {
        if (activeNodes.length === 0) return;
        e.preventDefault();
        copyNodes(activeNodes);
        // 同步写入系统剪贴板
        const nodes = activeNodes
          .map((id) => findNodeById(document.root, id))
          .filter((n): n is MindMapNode => n !== null);
        if (nodes.length > 0) writeToSystemClipboard(nodesToText(nodes));
      } else if (key === 'x') {
        if (activeNodes.length === 0) return;
        e.preventDefault();
        // 先读取文本再剪切（剪切会删除节点）
        const nodes = activeNodes
          .map((id) => findNodeById(document.root, id))
          .filter((n): n is MindMapNode => n !== null);
        cutNodes(activeNodes);
        if (nodes.length > 0) writeToSystemClipboard(nodesToText(nodes));
      } else if (key === 'v') {
        const pasteTargetId = activeNodes[0] || document.root.id;
        if (!pasteTargetId) return;
        e.preventDefault();
        // 优先内部剪贴板，若为空则回退到系统剪贴板
        if (clipboard && clipboard.nodes.length > 0) {
          pasteNodes(pasteTargetId);
        } else {
          handlePasteExternal(pasteTargetId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [document.root, focusedNodeId, selection, editingNodeId, clipboard, copyNodes, cutNodes, pasteNodes, handlePasteExternal]);
}
