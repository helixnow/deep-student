/**
 * 移动端工具条 → CrepeEditorApi 命令桥。
 * indent/outdent/undo/redo/openSlash 在 CrepeEditorApi 上未直接暴露，经 getCrepe() 走 ProseMirror。
 */

import { editorViewCtx } from '@milkdown/kit/core';
import { undo as pmUndo, redo as pmRedo } from '@milkdown/prose/history';
import { sinkListItem, liftListItem } from '@milkdown/prose/schema-list';
import type { EditorView } from '@milkdown/prose/view';

import type { CrepeEditorApi } from '@/components/crepe';
import type { MobileEditorToolbarCommands } from './components/MobileEditorToolbar';

type ViewAction = (view: EditorView) => void;

function withEditorView(editor: CrepeEditorApi | null | undefined, action: ViewAction): void {
  const crepe = editor?.getCrepe?.();
  if (!crepe?.editor) return;
  try {
    crepe.editor.action((ctx) => {
      let view: EditorView | null = null;
      try {
        view = ctx.get('editorView' as never) as EditorView;
      } catch {
        try {
          view = ctx.get(editorViewCtx) as EditorView;
        } catch {
          view = null;
        }
      }
      if (view) action(view);
    });
  } catch {
    // 编辑器未就绪 / 已销毁
  }
}

function resolveListItemType(view: EditorView) {
  const nodes = view.state.schema.nodes;
  return nodes.list_item ?? nodes.listItem ?? null;
}

/** 列表缩进：优先 sinkListItem，失败则向编辑器 DOM 派发 Tab */
export function indentEditor(editor: CrepeEditorApi | null | undefined): void {
  withEditorView(editor, (view) => {
    const listItem = resolveListItemType(view);
    if (listItem && sinkListItem(listItem)(view.state, view.dispatch)) {
      return;
    }
    view.focus();
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }),
    );
  });
}

/** 列表反缩进：优先 liftListItem，失败则派发 Shift+Tab */
export function outdentEditor(editor: CrepeEditorApi | null | undefined): void {
  withEditorView(editor, (view) => {
    const listItem = resolveListItemType(view);
    if (listItem && liftListItem(listItem)(view.state, view.dispatch)) {
      return;
    }
    view.focus();
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        code: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

export function undoEditor(editor: CrepeEditorApi | null | undefined): void {
  withEditorView(editor, (view) => {
    pmUndo(view.state, view.dispatch);
  });
}

export function redoEditor(editor: CrepeEditorApi | null | undefined): void {
  withEditorView(editor, (view) => {
    pmRedo(view.state, view.dispatch);
  });
}

/**
 * 打开 slash / 块菜单：在光标处插入 `/`，由 Crepe BlockEdit 输入规则弹出菜单。
 * （CrepeEditorApi 无 openSlashMenu；方案见 docs/revamp/19-mobile.md / W4 交付文档）
 */
export function openSlashMenu(editor: CrepeEditorApi | null | undefined): void {
  if (!editor) return;
  editor.focus();
  editor.insertAtCursor('/');
}

export function buildMobileEditorCommands(
  editor: CrepeEditorApi | null | undefined,
): MobileEditorToolbarCommands {
  return {
    toggleBold: () => editor?.toggleBold(),
    toggleItalic: () => editor?.toggleItalic(),
    insertHeading: (level) => editor?.setHeading(level),
    toggleBulletList: () => editor?.toggleBulletList(),
    toggleTaskList: () => editor?.toggleTaskList(),
    indent: () => indentEditor(editor),
    outdent: () => outdentEditor(editor),
    insertImage: () => editor?.insertImage(),
    openSlash: () => openSlashMenu(editor),
    undo: () => undoEditor(editor),
    redo: () => redoEditor(editor),
  };
}
