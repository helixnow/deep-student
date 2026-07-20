/**
 * 思维导图剪贴板 Hook（Cmd+C / Cmd+X / Cmd+V / Cmd+Shift+V）
 *
 * 复制 / 剪切：经 clipboardCodec 同时写入 Markdown 文本与结构化载荷，
 * 并记录写入文本的指纹。
 *
 * 粘贴优先级（修复「内存剪贴板永远优先」的旧 bug）：
 * 1. 系统剪贴板文本指纹 == 本实例最近一次写入 → 走 store 内部粘贴
 *    （保留 cut 的「粘贴后清空」语义，无损）；
 * 2. 结构化载荷（自定义 MIME 或指纹匹配的 localStorage 侧车）→ 灌回本实例
 *    剪贴板后复用 pasteNodes，实现跨导图带样式 / 挖空 / 完成态粘贴；
 * 3. text/html 大纲（Word / 网页）→ 转 Markdown 层级粘贴；
 * 4. Markdown 列表文本 → 层级粘贴；
 * 5. 普通文本 → 逐行粘贴为子节点。
 * 系统剪贴板完全不可读时才退化为直接粘内部剪贴板（旧行为）。
 *
 * Cmd+Shift+V：忽略结构化载荷，强制按纯文本 / Markdown 粘贴。
 *
 * 大纲编辑态（textarea 带 data-mm-outline-input 标记，B2）：
 * - 有文本选区 → 完全交给原生文本复制/剪切/粘贴；
 * - 无文本选区 → Cmd+C/X 作用于当前节点子树（幕布「复制主题」语义），
 *   Cmd+V 走上面的粘贴仲裁（内部新鲜 → 粘节点树；外部更新 → 结构化/文本解析；
 *   外部为单行纯文本 → 插入光标处）；Cmd+Shift+V 保持原生文本粘贴。
 */

import { useEffect, useCallback, useRef } from 'react';
import i18next from 'i18next';
import { useMindMapStore, useMindMapStoreApi } from '../store';
import { useMindMapIsActive } from '../MindMapActiveContext';
import { collectTopLevelNodeIds, traverseDFS } from '../utils/node/traverse';
import type { MindMapNode } from '../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { looksLikeMarkdownList, markdownListToNodes } from '../utils/pasteMarkdown';
import {
  hashText,
  readMindMapClipboard,
  writeMindMapClipboard,
} from '../utils/clipboardCodec';

function resolveClipboardNodes(
  root: MindMapNode,
  nodeIds: string[],
  options?: { excludeRoot?: boolean },
): { ids: string[]; nodes: MindMapNode[] } {
  const ids = collectTopLevelNodeIds(root, nodeIds, options);
  const wanted = new Set(ids);
  const nodeById = new Map<string, MindMapNode>();
  traverseDFS(root, (node) => {
    if (wanted.has(node.id)) nodeById.set(node.id, node);
  });
  return {
    ids,
    nodes: ids.flatMap((id) => {
      const node = nodeById.get(id);
      return node ? [node] : [];
    }),
  };
}

export function useMindMapClipboard(): void {
  // ★ 标签页保活：非活跃实例不响应复制/剪切/粘贴，避免多个全局监听器重复执行
  const isActive = useMindMapIsActive();
  const storeApi = useMindMapStoreApi();
  const document = useMindMapStore(s => s.document);
  const focusedNodeId = useMindMapStore(s => s.focusedNodeId);
  const selection = useMindMapStore(s => s.selection);
  const editingNodeId = useMindMapStore(s => s.editingNodeId);
  const copyNodes = useMindMapStore(s => s.copyNodes);
  const cutNodes = useMindMapStore(s => s.cutNodes);
  const pasteNodes = useMindMapStore(s => s.pasteNodes);
  const pasteTextChildren = useMindMapStore(s => s.pasteTextChildren);
  const pasteMarkdownChildren = useMindMapStore(s => s.pasteMarkdownChildren);

  /**
   * 本实例最近一次写入系统剪贴板的文本指纹。
   * 粘贴时以它判断系统剪贴板是否仍是「我们自己复制的内容」：
   * 一致 → 内部剪贴板未过期；不一致 → 用户后来复制了别的东西，走外部粘贴路径。
   */
  const lastWrittenRef = useRef<{ fingerprint: string; copiedAt: number } | null>(null);

  /** Markdown 层级粘贴（解析失败时提示，而非 store 侧静默吞掉） */
  const pasteMarkdownSafely = useCallback((targetId: string, markdown: string) => {
    try {
      if (markdownListToNodes(markdown).length === 0) return;
    } catch (error) {
      console.error('[MindMapClipboard] Markdown 解析失败:', error);
      showGlobalNotification(
        'warning',
        i18next.t('mindmap:clipboard.pasteParseFailed', {
          defaultValue: '粘贴内容过大或层级过深，无法解析',
        }),
      );
      return;
    }
    pasteMarkdownChildren(targetId, markdown);
  }, [pasteMarkdownChildren]);

  /** 统一粘贴入口（见文件头的优先级说明） */
  const handlePaste = useCallback(async (
    targetId: string,
    options?: {
      forceText?: boolean;
      /**
       * 大纲编辑态传入的 textarea：外部内容是单行纯文本时插入光标处
       * （而非降级为子节点），与文本编辑直觉一致。
       */
      inlineSingleLineTarget?: HTMLTextAreaElement;
    },
  ) => {
    const read = await readMindMapClipboard();

    // 系统剪贴板不可读（权限被拒等）：退化为旧行为，直接粘内部剪贴板
    if (read.kind === 'empty') {
      const { clipboard } = storeApi.getState();
      if (clipboard && clipboard.nodes.length > 0) {
        pasteNodes(targetId);
      }
      return;
    }

    if (!options?.forceText) {
      // 内部剪贴板是否仍然新鲜：系统剪贴板文本正是本实例最近一次 copy/cut 写入的
      const written = lastWrittenRef.current;
      const { clipboard } = storeApi.getState();
      const internalFresh =
        !!clipboard &&
        clipboard.nodes.length > 0 &&
        !!written &&
        read.text !== null &&
        hashText(read.text) === written.fingerprint;
      if (internalFresh) {
        pasteNodes(targetId);
        return;
      }

      if (read.kind === 'structured') {
        // 跨导图结构化粘贴：把载荷灌回本实例剪贴板后复用 pasteNodes
        // （沿用其深度/数量守卫与 id 重生成；copiedAt 为 store 并行新增字段，做兼容性携带）
        const hydrated = {
          nodes: read.payload.nodes,
          sourceOperation: 'copy' as const,
          copiedAt: read.payload.copiedAt,
        };
        type ClipboardState = ReturnType<(typeof storeApi)['getState']>['clipboard'];
        storeApi.setState({ clipboard: hydrated as unknown as ClipboardState });
        pasteNodes(targetId);
        return;
      }
    }

    // ── 外部文本粘贴路径 ──
    const text = read.text;
    if (!text?.trim()) return;

    if (read.kind === 'markdown') {
      pasteMarkdownSafely(targetId, read.markdown);
      return;
    }
    // forceText 时 structured 也按文本处理
    if (looksLikeMarkdownList(text)) {
      pasteMarkdownSafely(targetId, text);
      return;
    }

    const lines = read.kind === 'lines'
      ? read.lines
      : text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    // 大纲编辑态 + 单行纯文本 → 插入到光标处（execCommand 会触发 input 事件，
    // React 受控组件正常收到 onChange）；失败或多行时退化为子节点粘贴
    const inlineTarget = options?.inlineSingleLineTarget;
    if (
      lines.length === 1 &&
      inlineTarget &&
      globalThis.document?.activeElement === inlineTarget
    ) {
      try {
        if (globalThis.document.execCommand('insertText', false, lines[0])) return;
      } catch {
        /* execCommand 不可用：退化为子节点粘贴 */
      }
    }
    pasteTextChildren(targetId, lines);
  }, [storeApi, pasteNodes, pasteMarkdownSafely, pasteTextChildren]);

  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // IME 组字期间短路，避免组字确认键误触发剪贴板操作
      if (e.isComposing) return;
      // 画布编辑态 textarea 内仍让系统默认复制/粘贴
      if (editingNodeId) return;

      const activeNodes = selection.length > 0
        ? selection
        : focusedNodeId
          ? [focusedNodeId]
          : [];

      const target = e.target as HTMLElement;
      const isMod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // ── 大纲编辑态节点级剪贴板（B2）──
      // 大纲行 textarea 带 data-mm-outline-input 标记；无文本选区时
      // Cmd+C/X/V 升级为节点级操作，有选区时保持原生文本行为。
      const isOutlineInput =
        target instanceof HTMLTextAreaElement &&
        target.dataset.mmOutlineInput === 'true';
      if (isOutlineInput) {
        if (!isMod || e.altKey) return;
        if (target.selectionStart !== target.selectionEnd) return; // 有文本选区 → 原生
        if (!focusedNodeId) return;

        if (key === 'c' && !e.shiftKey) {
          e.preventDefault();
          // 根行复制降级为其子树森林（与画布 Cmd+C 的根保护语义一致）
          const sourceIds =
            focusedNodeId === document.root.id && document.root.children.length > 0
              ? document.root.children.map((child) => child.id)
              : [focusedNodeId];
          const { ids, nodes } = resolveClipboardNodes(document.root, sourceIds);
          if (ids.length === 0) return;
          copyNodes(ids);
          if (nodes.length > 0) {
            void writeMindMapClipboard(nodes).then((written) => {
              if (written) lastWrittenRef.current = written;
            });
          }
        } else if (key === 'x' && !e.shiftKey) {
          // 根节点不可剪切（resolveClipboardNodes excludeRoot 后为空则直接放行）
          const { ids, nodes } = resolveClipboardNodes(document.root, [focusedNodeId], {
            excludeRoot: true,
          });
          if (ids.length === 0) return;
          e.preventDefault();
          cutNodes(ids);
          if (nodes.length > 0) {
            void writeMindMapClipboard(nodes).then((written) => {
              if (written) lastWrittenRef.current = written;
            });
          }
        } else if (key === 'v' && !e.shiftKey) {
          // 无内部剪贴板时不拦截：原生粘贴 + 行内 onPaste 的结构化解析已足够；
          // Cmd+Shift+V 也不拦截（原生文本粘贴即「强制按文本」）。
          const { clipboard } = storeApi.getState();
          if (!clipboard || clipboard.nodes.length === 0) return;
          e.preventDefault();
          // 内部新鲜 → 粘节点树；外部有新内容 → 结构化/Markdown/文本仲裁（B3）
          void handlePaste(focusedNodeId, { inlineSingleLineTarget: target });
        }
        return;
      }

      // 其余输入控件（搜索框、画布编辑 textarea 等）保持原生行为
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      // Alt 组合（如 Cmd+Alt+C 拷贝样式类快捷键）不在此处理
      if (!isMod || e.altKey) return;

      if (key === 'c' && !e.shiftKey) {
        if (activeNodes.length === 0) return;
        e.preventDefault();
        // C6：copy/cut 语义统一 —— 根节点不可整棵复制（与 cut 禁 root 对齐），
        // 复制根时降级为复制其子树森林；根无子节点时仅复制根文本（不带子树引用）
        let sourceIds = activeNodes;
        if (activeNodes.includes(document.root.id)) {
          sourceIds = document.root.children.length > 0
            ? document.root.children.map((child) => child.id)
            : activeNodes;
        }
        const { ids, nodes } = resolveClipboardNodes(document.root, sourceIds);
        copyNodes(ids);
        if (nodes.length > 0) {
          void writeMindMapClipboard(nodes).then((written) => {
            if (written) lastWrittenRef.current = written;
          });
        }
      } else if (key === 'x' && !e.shiftKey) {
        if (activeNodes.length === 0) return;
        e.preventDefault();
        const { ids, nodes } = resolveClipboardNodes(document.root, activeNodes, {
          excludeRoot: true,
        });
        if (ids.length === 0) return;
        cutNodes(ids);
        if (nodes.length > 0) {
          void writeMindMapClipboard(nodes).then((written) => {
            if (written) lastWrittenRef.current = written;
          });
        }
      } else if (key === 'v') {
        // 优先粘到焦点节点，其次选中集中的第一个
        const pasteTargetId =
          (focusedNodeId &&
          (selection.length === 0 || selection.includes(focusedNodeId))
            ? focusedNodeId
            : null) ||
          activeNodes[0] ||
          document.root.id;
        if (!pasteTargetId) return;
        e.preventDefault();
        // Cmd+Shift+V：强制按纯文本粘贴（忽略结构化载荷）
        void handlePaste(pasteTargetId, { forceText: e.shiftKey });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, storeApi, document.root, focusedNodeId, selection, editingNodeId, copyNodes, cutNodes, handlePaste]);
}
