/**
 * 「保存为笔记」共享落点。
 *
 * 改造前各入口（聊天消息、聊天划词）都是 `createNote(title, text)` 一把梭：
 * 笔记默认落在资源库根目录，toast 只说"已保存"，用户既不知道存去哪、也点不开。
 * （快捷助手不在此列：轻量独立窗直落根目录属独立产品语义，书面豁免见
 * docs/dev/wave2-B-r3-quick-assistant-exemption.md。）
 *
 * 这里统一三件事：
 * 1. 落点：调用方先选目录（复用 learning-hub 的 FolderPickerDialog），folderId 随
 *    dstu_create 一次提交（metadata.folderId，后端单事务落盘），不再有旧两步模型
 *    「创建成功、移动失败」的中间态
 * 2. 反馈：成功 toast 明示实际落点（所选目录 / 资源库根目录），带「打开笔记」动作
 * 3. 标题：从正文首行推导，避免出现"未命名"堆积
 *
 * 不新造文件树、不新造笔记编辑器；目录树查询用 folderApi，目录归属由后端事务保证。
 */

import i18n from '@/i18n';
import { folderApi } from '@/dstu';
import { emitDstuFolderChange } from '@/dstu/folderEvents';
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
  /**
   * landed = 实际落点，不是意图落点：
   * - 'folder'：已确认在所选目录里
   * - 'root'：在资源库根目录（用户选了根目录，或后端兼容形态忽略了 folderId）
   */
  | { ok: true; noteId: string; title: string; landed: 'folder' | 'root' }
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
 * 确认笔记的实际落点。
 *
 * 现行后端在 dstu_create 内单事务写入目录归属（目标目录不存在时整体失败），
 * 但兼容形态（旧后端 / folderId 形状不被识别）会静默落根且创建仍返回成功。
 * 因此创建成功后回查目标目录：只有确认在目录里才报 'folder'；查不到或回查
 * 失败一律按 'root' 报告——宁可把「可能已在目录里」说保守，也不再谎称已到
 * 所选目录。
 */
async function resolveLandedFolder(noteId: string, folderId: string): Promise<'folder' | 'root'> {
  const items = await folderApi.getFolderItems(folderId);
  return items.ok && items.value.some((item) => item.itemId === noteId) ? 'folder' : 'root';
}

/**
 * 写入笔记：folderId + tags 随一次 dstu_create 提交。
 *
 * 目标目录不存在时后端整体回滚（未落盘），这里直接得到 ok:false；
 * 不再存在旧两步模型「先建到根、再移动失败」的部分成功窗口。
 */
export async function saveTextAsNote(input: SaveTextAsNoteInput): Promise<SaveTextAsNoteResult> {
  const content = input.content?.trim() ?? '';
  if (!content) {
    return { ok: false, error: i18n.t('chatV2:messageItem.actions.noContentToExport') };
  }

  const title = input.title?.trim() || deriveNoteTitle(content);

  try {
    const created = await notesDstuAdapter.createNote(
      title,
      content,
      input.tags ?? [],
      input.folderId,
    );
    if (!created.ok) {
      return { ok: false, error: created.error.toUserMessage() };
    }

    const noteId = created.value.id;
    const landed = input.folderId ? await resolveLandedFolder(noteId, input.folderId) : 'root';

    if (landed === 'folder') {
      // 旧两步模型里 moveItem 会广播 item-moved 让目录树刷新；单次提交后由这里
      // 补发等价事件（根目录落点由 DSTU watch 流的资源创建事件覆盖，无需补发）。
      emitDstuFolderChange({
        kind: 'item-added',
        folderId: input.folderId,
        itemId: noteId,
        itemType: 'note',
      });
    }

    return { ok: true, noteId, title, landed };
  } catch (error: unknown) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/** 成功 toast（按实际落点措辞，带「打开笔记」动作）；失败 toast。 */
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

  const { noteId, title, landed } = result;
  // toast 明示实际位置：落根目录时（无论是用户选的还是后端兼容降级）不再谎称
  // 已到所选目录。两个 landed 键 zh/en 均已落库（chatV2.json），defaultValue 仅兜底。
  const message =
    landed === 'folder'
      ? i18n.t('chatV2:messageItem.actions.saveAsNoteSuccessInFolder', {
          defaultValue: '「{{title}}」已保存到所选目录',
          title,
        })
      : i18n.t('chatV2:messageItem.actions.saveAsNoteSuccessAtRoot', {
          defaultValue: '「{{title}}」已保存到资源库根目录',
          title,
        });

  const openSource = options?.openSource;
  showGlobalNotification('success', message, undefined, {
    action: {
      label: i18n.t('chatV2:selectionToolbar.openNote', '打开笔记'),
      onClick: () => openSavedNote(noteId, openSource),
    },
    borderTone: 'neutral',
  });
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
