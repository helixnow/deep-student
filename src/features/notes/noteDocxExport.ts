/**
 * 笔记 → Word（.docx）导出：读取当前编辑器全文（未保存的最后一次输入也包含在内），
 * 转为 DOCX spec，由后端 `notes_export_docx` 解析 notes_assets 图片并生成，
 * 经系统保存对话框写出（Android content:// 与其它导出同一通道）。
 */
import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { dstu } from '@/dstu';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { isExportUnsupportedPlatform } from '@/features/learning-hub/utils/exportResource';
import { markdownToDocxSpec, type DocxTemplate } from './noteDocxSpec';

/** 文件名去掉系统保留字符 */
export function docxFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80);
  return `${safe || 'note'}.docx`;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readNoteMarkdown(noteId: string, windowId?: string): Promise<string> {
  const { getNoteEditor } = await import('@/features/workbench/agent/drivers/noteDriver');
  const editor = getNoteEditor(noteId, windowId);
  if (editor?.getFullDocument) {
    const fullApi = editor as import('@/features/notes/fullDocument').FullDocumentSearchApi;
    if (fullApi.materializeFullDocument) await fullApi.materializeFullDocument();
    const draft = editor.getFullDocument();
    if (draft.noteId === noteId && !editor.isDocumentWindowed?.()) {
      return editor.getPlainMarkdown?.() ?? draft.markdown;
    }
  }
  const { notesDstuAdapter } = await import('@/dstu/adapters/notesDstuAdapter');
  const content = await notesDstuAdapter.getNoteContent(noteId);
  if (!content.ok) throw new Error(content.error.toUserMessage());
  return content.value;
}

function formatDate(lang: string): string {
  const now = new Date();
  return lang.toLowerCase().startsWith('zh')
    ? `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    : now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export async function exportNoteAsDocx(
  noteId: string,
  template: DocxTemplate,
  windowId?: string,
): Promise<boolean> {
  const t = i18n.getFixedT(null, 'notes');
  if (isExportUnsupportedPlatform()) {
    showGlobalNotification('warning', t('chrome.export_docx_unsupported'));
    return false;
  }
  try {
    const [markdown, node] = await Promise.all([readNoteMarkdown(noteId, windowId), dstu.get(`/${noteId}`)]);
    const title = node.ok ? node.value.name : '';
    const lang = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
    const spec = markdownToDocxSpec(markdown, {
      title,
      template,
      date: template === 'handout' ? formatDate(lang) : undefined,
    });
    showGlobalNotification('info', t('chrome.export_docx_running'));
    const b64 = await invoke<string>('notes_export_docx', { spec });
    const fileName = docxFileName(spec.title || title);
    const saved = await fileManager.saveBinaryFile({
      data: base64ToBytes(b64),
      title: t('chrome.export_docx'),
      defaultFileName: fileName,
      filters: [{ name: 'Word', extensions: ['docx'] }],
    });
    if (saved.canceled) return false;
    const shown = saved.path && !/^(content|ph|asset):\/\//i.test(saved.path) ? saved.path : fileName;
    showGlobalNotification('success', t('chrome.export_docx_done', { path: shown }));
    return true;
  } catch (error: unknown) {
    showGlobalNotification('error', getErrorMessage(error), t('chrome.export_docx_failed'));
    return false;
  }
}
