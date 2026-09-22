/**
 * 移动端工具条 → CrepeEditorApi 命令桥。
 * 写操作复用共享命令注册表；菜单展示仍通过编辑器 view 打开。
 */

import i18next from 'i18next';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/prose/view';

import type { CrepeEditorApi } from '@/components/crepe';
import { openCrepeBlockCommandMenu } from '@/components/crepe/blockCommandMenu';
import type { CrepeBlockTurnInto } from '@/components/crepe/blockMenuCommands';
import { executeCrepeCommand, canExecuteCrepeCommand, canEditCrepeView, type CrepeCommandId, type CrepeCommandRequest } from '@/components/crepe/commandRegistry';
import {
  createImageUploader,
  validateImageFile,
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

export function runEditorCommand(editor: CrepeEditorApi | null | undefined, id: CrepeCommandId, request?: CrepeCommandRequest): void {
  if (editor?.executeCommand) { void editor.executeCommand(id, request).catch(error => showGlobalNotification('error', String(error))); return; }
  withEditorView(editor, view => { void executeCrepeCommand(view, id, request).catch(error => showGlobalNotification('error', String(error))); });
}

/** 列表缩进经统一 canExecute/schema 门禁。 */
export function indentEditor(editor: CrepeEditorApi | null | undefined): void {
  runEditorCommand(editor, 'indent');
}

/** 列表反缩进经统一 canExecute/schema 门禁。 */
export function outdentEditor(editor: CrepeEditorApi | null | undefined): void {
  runEditorCommand(editor, 'outdent');
}

export function undoEditor(editor: CrepeEditorApi | null | undefined): void {
  runEditorCommand(editor, 'undo');
}

export function redoEditor(editor: CrepeEditorApi | null | undefined): void {
  runEditorCommand(editor, 'redo');
}

/** Opening/cancelling is UI-only: no document transaction or undo entry. */
export function openSlashMenu(editor: CrepeEditorApi | null | undefined): void {
  withEditorView(editor, (view) => { openCrepeBlockCommandMenu(view); });
}

function turnCurrentBlockInto(editor: CrepeEditorApi | null | undefined, kind: CrepeBlockTurnInto): void {
  runEditorCommand(editor, kind, { toggle: true });
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
  if (editor.insertImageFromDevice) { editor.insertImageFromDevice(); return; }
  if (editor.isReadonly()) return;
  if (!isTauriEnv()) {
    editor.insertImage();
    return;
  }
  const instance = editor.getCrepe();
  const selection = editor.captureSelection?.() ?? null;
  try {
    const file = await pickImageWithTauriDialog();
    if (!file) return; // 用户取消
    try {
      await validateImageFile(file);
    } catch {
      showGlobalNotification(
        'error',
        i18next.t('notes:editor.image_upload.invalid_image', {
          defaultValue: '无法读取该图片，文件可能已损坏或格式不受支持',
        }),
      );
      return;
    }
    const url = await createImageUploader(noteId)(file);
    if (!url) return; // 上传失败：uploader 已 toast
    if (editor.getCrepe() !== instance || !instance || editor.isReadonly()) return;
    editor.restoreSelection?.(selection);
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
    subscribeState: editor?.subscribeCommandState,
    canExecute: (action) => {
      const ids: Record<string, CrepeCommandId> = { bold: 'bold', italic: 'italic', strikethrough: 'strikethrough',
        h1: 'heading-1', h2: 'heading-2', h3: 'heading-3', bullet: 'bullet-list', task: 'task-list', ordered: 'ordered-list',
        codeblock: 'code-block', columns: 'insert-columns', cornell: 'insert-cornell', convertColumns: 'convert-columns',
        convertCornell: 'convert-cornell', unwrapColumns: 'unwrap-columns' };
      if (action === 'generateCards' || action === 'find') return Boolean(editor);
      if (action === 'slash' || action === 'blockActions') {
        let enabled = false; withEditorView(editor, view => { enabled = canEditCrepeView(view); }); return enabled;
      }
      const id = ids[action] ?? action as CrepeCommandId;
      if (editor?.canExecuteCommand) return editor.canExecuteCommand(id, { toggle: true });
      let enabled = false; withEditorView(editor, view => { enabled = canExecuteCrepeCommand(view, id, { toggle: true }); }); return enabled;
    },
    toggleBold: () => editor?.toggleBold(),
    toggleItalic: () => editor?.toggleItalic(),
    toggleStrikethrough: () => editor?.toggleStrikethrough(),
    insertHeading: (level) => turnCurrentBlockInto(editor, `heading-${level}`),
    toggleBulletList: () => turnCurrentBlockInto(editor, 'bullet-list'),
    toggleTaskList: () => turnCurrentBlockInto(editor, 'task-list'),
    indent: () => indentEditor(editor),
    outdent: () => outdentEditor(editor),
    insertImage: () => { void insertImageFromDevice(editor, extras?.noteId); },
    openSlash: () => openSlashMenu(editor),
    undo: () => undoEditor(editor),
    redo: () => redoEditor(editor),
    // 内联块插入条命令（MobileEditorToolbar 侧为可选，注入后按钮才渲染）
    toggleOrderedList: () => turnCurrentBlockInto(editor, 'ordered-list'),
    toggleBlockquote: () => turnCurrentBlockInto(editor, 'quote'),
    insertLink: () => editor?.insertLink(),
    insertCodeBlock: () => turnCurrentBlockInto(editor, 'code-block'),
    insertTable: () => editor?.insertTable(),
    // 📱 触屏无 hover 块句柄：当前块操作菜单入口（Turn into / 复制 / 删除等）
    openBlockActions: () => {
      if (editor?.executeCommand && editor.openBlockMenuAtSelection) editor.openBlockMenuAtSelection();
      else withEditorView(editor, (view) => { openCrepeBlockCommandMenu(view, true); });
    },
    insertColumns: () => runEditorCommand(editor, 'insert-columns'),
    insertCornell: () => runEditorCommand(editor, 'insert-cornell'),
    convertColumns: () => runEditorCommand(editor, 'convert-columns'),
    convertCornell: () => runEditorCommand(editor, 'convert-cornell'),
    unwrapColumns: () => runEditorCommand(editor, 'unwrap-columns'),
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
