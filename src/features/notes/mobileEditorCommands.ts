/**
 * 移动端工具条 → CrepeEditorApi 命令桥。
 * indent/outdent/undo/redo/openSlash 在 CrepeEditorApi 上未直接暴露，经 getCrepe() 走 ProseMirror。
 */

import i18next from 'i18next';
import { editorViewCtx } from '@milkdown/kit/core';
import { undo as pmUndo, redo as pmRedo } from '@milkdown/prose/history';
import { sinkListItem, liftListItem } from '@milkdown/prose/schema-list';
import type { EditorView } from '@milkdown/prose/view';

import type { CrepeEditorApi } from '@/components/crepe';
import {
  createImageUploader,
  pickImageWithTauriDialog,
} from '@/components/crepe/features/imageUpload';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { generateCardsFromNote } from './generateCardsFromNote';
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
      // isDestroyed：销毁中的 view 上 dispatch 会抛错（快速切换笔记时可复现）
      if (view && !view.isDestroyed) action(view);
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
    try {
      if (listItem && sinkListItem(listItem)(view.state, view.dispatch)) {
        return;
      }
    } catch {
      // sink 在部分嵌套结构下可能抛错，降级到 Tab 派发
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
    try {
      if (listItem && liftListItem(listItem)(view.state, view.dispatch)) {
        return;
      }
    } catch {
      // lift 失败时降级到 Shift+Tab 派发
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
    try {
      pmUndo(view.state, view.dispatch);
    } catch {
      // 历史插件未挂载 / 状态异常时静默（工具条按钮不应抛错）
    }
  });
}

export function redoEditor(editor: CrepeEditorApi | null | undefined): void {
  withEditorView(editor, (view) => {
    try {
      pmRedo(view.state, view.dispatch);
    } catch {
      // 同 undoEditor
    }
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

function isTauriEnv(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * P0-4 图片插入闭环：Tauri 原生选图 → notes_save_asset 上传 → 插入带 URL 的 image 节点。
 * - 用户取消选择：静默返回，不插入空节点；
 * - 上传失败：createImageUploader 内部已 toast，这里同样不插入；
 * - 非 Tauri 环境：回退旧行为（插入空 image 占位块，由 Crepe ImageBlock UI 完成上传）。
 */
export async function insertImageFromDevice(
  editor: CrepeEditorApi | null | undefined,
  noteId: string | undefined,
): Promise<void> {
  if (!editor) return;
  if (!isTauriEnv()) {
    editor.insertImage();
    return;
  }
  try {
    const file = await pickImageWithTauriDialog();
    if (!file) return; // 用户取消 / 对话框失败（pick 内部已记录日志）
    const url = await createImageUploader(noteId)(file);
    if (!url) return; // 上传失败：uploader 已 toast
    editor.insertImage(url, file.name);
    editor.focus();
  } catch (error) {
    console.error('[mobileEditorCommands] insertImageFromDevice failed:', error);
    showGlobalNotification(
      'error',
      i18next.t('notes:editor.image_upload.save_failed', {
        error: error instanceof Error ? error.message : String(error),
        defaultValue: '图片保存失败',
      }),
    );
  }
}

/**
 * 移动端制卡的 in-flight 守卫。
 *
 * 命令对象在宿主每次渲染时重建，闭包变量守不住双击；按编辑器实例记在模块级，
 * 与桌面 NotesEditorToolbar 的 generatingCards state 等效（触屏双击只发一个任务）。
 */
const cardsInFlightEditors = new WeakSet<object>();
/** 编辑器尚未就绪时也要防抖，此时没有可作键的实例 */
let cardsInFlightWithoutEditor = false;

function isGeneratingCards(editor: CrepeEditorApi | null | undefined): boolean {
  return editor ? cardsInFlightEditors.has(editor) : cardsInFlightWithoutEditor;
}

function setGeneratingCards(editor: CrepeEditorApi | null | undefined, running: boolean): void {
  if (!editor) {
    cardsInFlightWithoutEditor = running;
    return;
  }
  if (running) cardsInFlightEditors.add(editor);
  else cardsInFlightEditors.delete(editor);
}

/** 制卡入口：任务在途时忽略重复点击，完成/失败后恢复 */
export function generateCardsFromEditor(
  editor: CrepeEditorApi | null | undefined,
  noteTitle?: string,
): void {
  if (isGeneratingCards(editor)) return;
  setGeneratingCards(editor, true);
  void generateCardsFromNote({ editor, noteTitle }).finally(() => {
    setGeneratingCards(editor, false);
  });
}

/**
 * 宿主侧扩展（不依赖编辑器实例的命令）。
 * - openFind：打开编辑器内查找替换面板（NotesCrepeEditor 传 setIsFindReplaceOpen(true)）；
 * - noteId：图片上传归档到该笔记的资产目录（P0-4；缺省时 uploader 回退 blob URL）。
 * - noteTitle：制卡时作为牌组名；缺省时 generateCardsFromNote 回退到通用牌组。
 * - enableGenerateCards：笔记宿主显式开启制卡入口；其他宿主（复用工具条但内容不是
 *   笔记正文）不传，底栏就不会多出一个「生成卡片」按钮。
 */
export interface MobileEditorCommandExtras {
  openFind?: () => void;
  noteId?: string;
  noteTitle?: string;
  enableGenerateCards?: boolean;
}

export function buildMobileEditorCommands(
  editor: CrepeEditorApi | null | undefined,
  extras?: MobileEditorCommandExtras,
): MobileEditorToolbarCommands {
  return {
    toggleBold: () => editor?.toggleBold(),
    toggleItalic: () => editor?.toggleItalic(),
    toggleStrikethrough: () => editor?.toggleStrikethrough(),
    insertHeading: (level) => editor?.setHeading(level),
    toggleBulletList: () => editor?.toggleBulletList(),
    toggleTaskList: () => editor?.toggleTaskList(),
    indent: () => indentEditor(editor),
    outdent: () => outdentEditor(editor),
    insertImage: () => { void insertImageFromDevice(editor, extras?.noteId); },
    openSlash: () => openSlashMenu(editor),
    undo: () => undoEditor(editor),
    redo: () => redoEditor(editor),
    // 内联块插入条命令（MobileEditorToolbar 侧为可选，注入后按钮才渲染）
    toggleOrderedList: () => editor?.toggleOrderedList(),
    toggleBlockquote: () => editor?.toggleBlockquote(),
    insertLink: () => editor?.insertLink(),
    insertCodeBlock: () => editor?.insertCodeBlock(),
    insertTable: () => editor?.insertTable(),
    // 📱 触屏无 hover 块句柄：当前块操作菜单入口（Turn into / 复制 / 删除等）
    openBlockActions: () => editor?.openBlockMenuAtSelection?.(),
    // 生成卡片：走与桌面工具栏同一个共享制卡入口，不新起链路；
    // 仅笔记宿主显式开启（enableGenerateCards）后暴露，未开启时按钮不渲染
    ...(extras?.enableGenerateCards
      ? {
          generateCards: () => generateCardsFromEditor(editor, extras.noteTitle),
        }
      : {}),
    // 查找入口：仅宿主接线后暴露，保持未接线宿主的按钮隐藏行为
    ...(extras?.openFind ? { openFind: extras.openFind } : {}),
  };
}
