/**
 * Notion 式块选择（顶层块粒度）
 *
 * - Esc：选中光标所在的顶层块（再按 Esc 取消）
 * - ↑ / ↓：移动到上一 / 下一块；Shift + ↑ / ↓：扩选
 * - Backspace / Delete：删除选中块；Mod-D：在其后复制一份
 * - Enter：回到最后一块末尾继续编辑
 * - 其余按键：退出块选择，交给编辑器（底层文本选区已覆盖这些块，⌘C/⌘X/输入替换走原生路径）
 *
 * 状态只记录顶层子节点下标；任何不带本插件 meta 的选区/文档变化都会清空，
 * 所以点击、输入、撤销等外部操作天然退出块选择。
 */

import { Fragment } from '@milkdown/prose/model';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

export type BlockSelectionState = { anchor: number; head: number } | null;

export const blockSelectionKey = new PluginKey<BlockSelectionState>('ds-block-selection');

const SELECTED_CLASS = 'ds-block-selected';
const ACTIVE_CLASS = 'ds-block-selecting';

const span = (sel: NonNullable<BlockSelectionState>) => ({
  first: Math.min(sel.anchor, sel.head),
  last: Math.max(sel.anchor, sel.head),
});

/** 第 index 个顶层子节点的起始位置 */
export const topChildPos = (doc: ProseNode, index: number): number => {
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i++) pos += doc.child(i).nodeSize;
  return pos;
};

const topIndexAt = (doc: ProseNode, pos: number): number =>
  Math.min(doc.childCount - 1, Math.max(0, doc.resolve(Math.min(pos, doc.content.size)).index(0)));

const rangeOf = (doc: ProseNode, sel: NonNullable<BlockSelectionState>) => {
  const { first, last } = span(sel);
  return { from: topChildPos(doc, first), to: topChildPos(doc, last + 1) };
};

/** 让底层文本选区覆盖选中块：原生复制/剪切/输入替换都作用在整块上 */
const coveringSelection = (state: EditorState, sel: NonNullable<BlockSelectionState>) => {
  const { from, to } = rangeOf(state.doc, sel);
  const start = Selection.findFrom(state.doc.resolve(from), 1, true) ?? Selection.atStart(state.doc);
  const end = Selection.findFrom(state.doc.resolve(to), -1, true) ?? Selection.atEnd(state.doc);
  return TextSelection.between(start.$from, end.$to);
};

const setBlockSelection = (view: EditorView, sel: BlockSelectionState) => {
  const tr = view.state.tr.setMeta(blockSelectionKey, sel);
  if (sel) tr.setSelection(coveringSelection(view.state, sel));
  view.dispatch(tr.scrollIntoView());
};

/** 有别的浮层 / 模式拥有 Esc 时让路（专注模式、AI 审阅、斜杠菜单、链接编辑、块菜单、对话框） */
const escapeOwnedElsewhere = (view: EditorView): boolean => {
  if (!view.editable) return true;
  const shell = view.dom.closest('.notes-crepe-shell');
  if (shell?.getAttribute('data-focus-mode') === 'true') return true;
  if (shell?.querySelector('.notes-ai-diff-inline')) return true;
  const root = view.dom.closest('.milkdown') ?? document;
  if (root.querySelector('.milkdown-slash-menu[data-show="true"], .milkdown-link-edit[data-show="true"]')) return true;
  return !!document.querySelector('.crepe-block-menu, [role="dialog"][data-state="open"]');
};

export const blockSelectionProsePlugin = () => new Plugin<BlockSelectionState>({
  key: blockSelectionKey,
  state: {
    init: () => null,
    apply(tr, value) {
      const meta = tr.getMeta(blockSelectionKey) as BlockSelectionState | undefined;
      if (meta !== undefined) return meta;
      if (value && (tr.docChanged || tr.selectionSet)) return null;
      return value;
    },
  },
  props: {
    decorations(state) {
      const sel = blockSelectionKey.getState(state);
      if (!sel) return null;
      const { first, last } = span(sel);
      const decorations: Decoration[] = [];
      let pos = topChildPos(state.doc, first);
      for (let i = first; i <= last && i < state.doc.childCount; i++) {
        const node = state.doc.child(i);
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: SELECTED_CLASS }));
        pos += node.nodeSize;
      }
      return DecorationSet.create(state.doc, decorations);
    },
    handleKeyDown(view, event) {
      if (event.isComposing || event.keyCode === 229) return false;
      const sel = blockSelectionKey.getState(view.state);
      const { doc } = view.state;

      if (!sel) {
        if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
        if (doc.childCount === 0 || escapeOwnedElsewhere(view)) return false;
        const index = topIndexAt(doc, view.state.selection.from);
        setBlockSelection(view, { anchor: index, head: index });
        return true;
      }

      const mod = event.metaKey || event.ctrlKey;
      const lastIndex = doc.childCount - 1;
      switch (event.key) {
        case 'Escape':
          setBlockSelection(view, null);
          return true;
        case 'ArrowUp':
        case 'ArrowDown': {
          if (mod || event.altKey) return false;
          const delta = event.key === 'ArrowUp' ? -1 : 1;
          const head = Math.min(lastIndex, Math.max(0, sel.head + delta));
          setBlockSelection(view, event.shiftKey ? { anchor: sel.anchor, head } : { anchor: head, head });
          return true;
        }
        case 'Enter': {
          if (mod || event.shiftKey) return false;
          const { last } = span(sel);
          const end = topChildPos(doc, last + 1);
          const caret = Selection.findFrom(doc.resolve(end), -1, true) ?? Selection.atEnd(doc);
          view.dispatch(view.state.tr.setMeta(blockSelectionKey, null).setSelection(caret).scrollIntoView());
          return true;
        }
        case 'Backspace':
        case 'Delete': {
          const { from, to } = rangeOf(doc, sel);
          const tr = view.state.tr.setMeta(blockSelectionKey, null).delete(from, to);
          if (tr.doc.childCount === 0) {
            const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
            if (paragraph) tr.insert(0, paragraph);
          }
          const near = Math.min(from, tr.doc.content.size);
          tr.setSelection(Selection.near(tr.doc.resolve(near), near > 0 ? -1 : 1));
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        default:
          break;
      }

      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        const { first, last } = span(sel);
        const { from, to } = rangeOf(doc, sel);
        const copies: ProseNode[] = [];
        doc.slice(from, to).content.forEach((node) => copies.push(node));
        const tr = view.state.tr.insert(to, Fragment.from(copies));
        const count = last - first + 1;
        const next = { anchor: last + 1, head: last + count };
        tr.setMeta(blockSelectionKey, next);
        view.dispatch(tr);
        setBlockSelection(view, next);
        return true;
      }

      // 修饰键本身不退出；其他按键退出块选择，按键照常交给编辑器（选区已覆盖整块）
      if (['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) return false;
      if (!(mod && ['c', 'x', 'a'].includes(event.key.toLowerCase()))) {
        view.dispatch(view.state.tr.setMeta(blockSelectionKey, null));
      }
      return false;
    },
    handleDOMEvents: {
      mousedown(view) {
        if (blockSelectionKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(blockSelectionKey, null));
        return false;
      },
    },
  },
  view(view) {
    const sync = () => view.dom.classList.toggle(ACTIVE_CLASS, !!blockSelectionKey.getState(view.state));
    sync();
    return { update: sync, destroy: () => view.dom.classList.remove(ACTIVE_CLASS) };
  },
});

export const blockSelectionPlugin = () => $prose(() => blockSelectionProsePlugin());
