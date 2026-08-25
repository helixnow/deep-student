/**
 * 「保存为笔记」共享落点。
 *
 * 改造前各入口（聊天消息、聊天划词、快捷助手）都是 `createNote(title, text)` 一把梭：
 * 笔记默认落在资源库根目录，toast 只说"已保存"，用户既不知道存去哪、也点不开。
 *
 * 这里统一三件事：
 * 1. 落点：调用方先选目录（复用 learning-hub 的 FolderPickerDialog），再写入
 * 2. 反馈：成功 toast 带「打开笔记」动作，走既有 DSTU_OPEN_NOTE 契约
 * 3. 标题：从正文首行推导，避免出现"未命名"堆积
 *
 * 不新造文件树、不新造笔记编辑器；目录树用 folderApi，落点用 folderApi.moveItem。
 */

import i18n from '@/i18n';
import { folderApi } from '@/dstu';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';

/** 标题最大长度（超出截断，保持资源库列表可读） */
const MAX_NOTE_TITLE_LENGTH = 50;

export interface SaveTextAsNoteInput {
  /** 笔记正文 */
  content: string;
  /** 标题；缺省时从正文首行推导 */
  title?: string;
  /** 目标目录 ID；null = 资源库根目录 */
  folderId: string | null;
  /** 标签 */
  tags?: string[];
}

export type SaveTextAsNoteResult =
  | { ok: true; noteId: string; title: string }
  | { ok: false; error: string };

/**
 * 从正文推导笔记标题：取首个非空行，去掉 Markdown 标题标记并截断。
 */
export function deriveNoteTitle(content: string, fallback?: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const cleaned = firstLine?.replace(/^#{1,6}\s*/, '').replace(/[*_`>~]/g, '').trim();
  if (!cleaned) {
    return fallback || i18n.t('chatV2:selectionToolbar.saveAsNoteDefaultTitle', '未命名笔记');
  }
  return cleaned.length > MAX_NOTE_TITLE_LENGTH
    ? `${cleaned.slice(0, MAX_NOTE_TITLE_LENGTH)}…`
    : cleaned;
}

/**
 * 打开笔记：沿用既有 DSTU_OPEN_NOTE 契约（source 非 Notes 自有 → Chat 侧处理，
 * 缺省 source → Workbench 侧处理，见 features/notes/openNoteEvent.ts）。
 */
export function openSavedNote(noteId: string, source = 'save-as-note'): void {
  window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId, source } }));
}

/**
 * 写入笔记并（可选）移动到目标目录。
 *
 * 目录移动失败不算整体失败：笔记已经存在，只是落在了根目录，
 * 直接把笔记吞掉比"存到了别处"更糟。
 */
export async function saveTextAsNote(input: SaveTextAsNoteInput): Promise<SaveTextAsNoteResult> {
  const content = input.content?.trim() ?? '';
  if (!content) {
    return { ok: false, error: i18n.t('chatV2:messageItem.actions.noContentToExport') };
  }

  const title = input.title?.trim() || deriveNoteTitle(content);

  try {
    const created = await notesDstuAdapter.createNote(title, content, input.tags ?? []);
    if (!created.ok) {
      return { ok: false, error: created.error.toUserMessage() };
    }

    const noteId = created.value.id;
    if (input.folderId) {
      const moved = await folderApi.moveItem('note', noteId, input.folderId);
      if (!moved.ok) {
        console.warn('[saveTextAsNote] note created but move to folder failed:', moved.error.message);
      }
    }

    return { ok: true, noteId, title };
  } catch (error: unknown) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/** 成功 toast（带「打开笔记」动作）；失败 toast。 */
export function notifySaveTextAsNoteResult(
  result: SaveTextAsNoteResult,
  options?: { openSource?: string },
): void {
  if (result.ok === false) {
    showGlobalNotification(
      'error',
      result.error,
      i18n.t('chatV2:messageItem.actions.saveAsNoteFailed'),
    );
    return;
  }

  const { noteId, title } = result;
  const openSource = options?.openSource;
  showGlobalNotification(
    'success',
    i18n.t('chatV2:messageItem.actions.saveAsNoteSuccess', { title }),
    undefined,
    {
      action: {
        label: i18n.t('chatV2:selectionToolbar.openNote', '打开笔记'),
        onClick: () => openSavedNote(noteId, openSource),
      },
      borderTone: 'neutral',
    },
  );
}

/** 选好目录 → 写入 → 提示，一步到位。 */
export async function saveTextAsNoteAndNotify(
  input: SaveTextAsNoteInput,
  options?: { openSource?: string },
): Promise<SaveTextAsNoteResult> {
  const result = await saveTextAsNote(input);
  notifySaveTextAsNoteResult(result, options);
  return result;
}
