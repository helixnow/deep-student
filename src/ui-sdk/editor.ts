/**
 * 编辑器写接口（B9）：插件在选区工具栏、斜杠菜单的 `onRun(ctx)` 里拿到 Milkdown `Ctx`，在块菜单的 `run(view)` 里拿到
 * ProseMirror `EditorView`。`editorApi(ctxOrView)` 把它们包成几个稳定的读写方法，插件不必自己学 ProseMirror。
 *
 * - 写操作都是一次事务，进撤销历史（Ctrl+Z 可撤销），编辑器照常保存；
 * - `insertMarkdown` / `getMarkdown` 需要 Milkdown 的解析器与序列化器，只在拿到 `Ctx` 时可用；
 *   只拿到 `EditorView`（块菜单）时它们按纯文本处理；
 * - 编辑器已经销毁（用户关掉了笔记）时写操作返回 false，不抛错。
 *
 * 需要更底层的能力时，`@milkdown/kit/*` 已作为共享模块提供（与应用同一份实例），可以直接写 `editor.extensions`。
 */
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';

export interface EditorApi {
  /** 当前选中的纯文本（块之间用换行连接）；没有选区时为 ''。 */
  getSelectionText(): string;
  /** 选区的起止位置（ProseMirror 文档坐标）与是否为空。 */
  getSelection(): { from: number; to: number; empty: boolean };
  /** 整篇正文的纯文本。 */
  getText(): string;
  /** 整篇正文的 Markdown（只有 `Ctx` 时可用；否则退回纯文本）。 */
  getMarkdown(): string;
  /** 在光标处（有选区时替换选区）插入纯文本。 */
  insertText(text: string): boolean;
  /** 用纯文本替换当前选区；没有选区时等同 `insertText`。 */
  replaceSelection(text: string): boolean;
  /** 在光标处（有选区时替换选区）插入 Markdown，按块解析（标题、列表、公式等）。没有 `Ctx` 时按纯文本插入。 */
  insertMarkdown(markdown: string): boolean;
  /** 在选区之后另起一段插入 Markdown（不替换原文，适合「在下面追加解释」）。 */
  appendMarkdownAfterSelection(markdown: string): boolean;
  /** 把焦点还给编辑器。 */
  focus(): void;
}

function isView(value: unknown): value is EditorView {
  return typeof value === 'object' && value !== null && 'state' in value && 'dispatch' in value && 'dom' in value;
}

function textBetween(doc: ProseNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', '\n');
}

/**
 * 把 Milkdown `Ctx`（选区工具栏、斜杠菜单的 `onRun`）或 ProseMirror `EditorView`（块菜单的 `run`）包成 {@link EditorApi}。
 *
 * ```ts
 * toolbar.addGroup('demo', '示例').addItem('upper', {
 *   label: '转大写', icon: '', showLabel: true,
 *   onRun: (ctx) => { const editor = editorApi(ctx); editor.replaceSelection(editor.getSelectionText().toUpperCase()); },
 * });
 * ```
 */
export function editorApi(target: Ctx | EditorView): EditorApi {
  const ctx = isView(target) ? undefined : (target as Ctx);
  const view = (): EditorView | undefined => {
    if (!ctx) return target as EditorView;
    try {
      return ctx.get(editorViewCtx);
    } catch {
      return undefined;
    }
  };
  const alive = (v: EditorView | undefined): v is EditorView => !!v && !(v as { isDestroyed?: boolean }).isDestroyed;

  const parse = (markdown: string): ProseNode | undefined => {
    if (!ctx) return undefined;
    try {
      const parser = ctx.get(parserCtx);
      const doc = parser(markdown);
      return doc && typeof doc === 'object' ? doc : undefined;
    } catch {
      return undefined;
    }
  };

  const insertText = (text: string): boolean => {
    const v = view();
    if (!alive(v)) return false;
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(String(text), from, to).scrollIntoView());
    return true;
  };

  const insertDoc = (markdown: string, at: 'selection' | 'after'): boolean => {
    const v = view();
    if (!alive(v)) return false;
    const doc = parse(String(markdown));
    if (!doc) {
      if (at === 'selection') return insertText(markdown);
      const end = v.state.selection.$to.end();
      v.dispatch(v.state.tr.insertText(`\n${markdown}`, end).scrollIntoView());
      return true;
    }
    const { state } = v;
    if (at === 'selection') {
      const single = doc.childCount === 1 && doc.firstChild?.isTextblock;
      // One paragraph: insert its inline content in place, so a sentence lands inside the current block.
      const slice = single ? new Slice(doc.firstChild!.content, 0, 0) : new Slice(doc.content, 0, 0);
      v.dispatch(state.tr.replaceSelection(slice).scrollIntoView());
      return true;
    }
    const $to = state.selection.$to;
    const pos = $to.depth > 0 ? $to.after(1) : state.doc.content.size;
    v.dispatch(state.tr.insert(pos, doc.content).scrollIntoView());
    return true;
  };

  return {
    getSelectionText() {
      const v = view();
      if (!alive(v)) return '';
      const { from, to } = v.state.selection;
      return textBetween(v.state.doc, from, to);
    },
    getSelection() {
      const v = view();
      if (!alive(v)) return { from: 0, to: 0, empty: true };
      const { from, to, empty } = v.state.selection;
      return { from, to, empty };
    },
    getText() {
      const v = view();
      return alive(v) ? textBetween(v.state.doc, 0, v.state.doc.content.size) : '';
    },
    getMarkdown() {
      const v = view();
      if (!alive(v)) return '';
      if (ctx) {
        try {
          return ctx.get(serializerCtx)(v.state.doc);
        } catch {
          // fall through to plain text
        }
      }
      return textBetween(v.state.doc, 0, v.state.doc.content.size);
    },
    insertText,
    replaceSelection: insertText,
    insertMarkdown: (markdown) => insertDoc(markdown, 'selection'),
    appendMarkdownAfterSelection: (markdown) => insertDoc(markdown, 'after'),
    focus() {
      const v = view();
      if (alive(v)) v.focus();
    },
  };
}
