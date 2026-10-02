/**
 * 「追加到已有笔记」共享落点（与 saveTextAsNote 的「新建笔记」并列）。
 *
 * 学习者按主题把聊天回答 / PDF 摘录 / 批改结果持续积累进同一篇笔记。
 *
 * 写入语义：
 * 1. 正文：既有内容去掉尾部空白 + 分隔线 `\n\n---\n\n` + 追加段（笔记为空时不加分隔线）。
 *    调用方已构造的来源行（PDF 摘录的 pdfref:// 回链等）原样随追加段写入；聊天来源
 *    没有正文来源行时补一行引用式来源说明（对话不可用链接表达）。
 * 2. 溯源：只追加正文，绝不改写目标笔记的 props._origin——那是这篇笔记自己的来源。
 * 3. 并发：
 *    - 目标笔记若正在编辑器里且有未保存修改，先经 contentDirtyRegistry 冲刷该编辑器
 *      （与「保存并关闭」同一挂点）；冲刷失败则放弃追加，不与未落盘草稿竞争
 *    - 读取 updatedAt 作乐观锁基线随 dstu_update 提交；被并发写抢先（CONFLICT）时
 *      重新读取再拼接，最多重试 MAX_CONFLICT_RETRIES 次，绝不盲写覆盖
 *    - 编辑器同步：后端 dstu_update 成功后广播 DSTU watch `updated` 事件
 *      （`dstu:change`），已打开该笔记的 NoteContentView 据此从磁盘原位刷新
 *      （含 markdown 分窗投影与脏检查）。这里不再自行派发 notes:external-updated：
 *      那条通道要求分窗后的 loadedMarkdown，直接塞全文会让分窗视图把尾部写重。
 */

import type { NoteOrigin } from '@/features/notes/noteOrigin';
import i18n from '@/i18n';
import { dstu } from '@/dstu';
import { VfsErrorCode } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { openSavedNote } from './saveTextAsNote';

/** 既有正文与追加段之间的分隔（Markdown 分隔线，前后空行避免被解析成 setext 标题） */
export const NOTE_APPEND_SEPARATOR = '\n\n---\n\n';

/** 乐观锁冲突后的重读重试次数 */
const MAX_CONFLICT_RETRIES = 2;

export interface AppendTextToNoteInput {
  /** 目标笔记 ID */
  noteId: string;
  /** 追加的正文（调用方已含来源行时原样保留） */
  content: string;
  /** 来源：只用于补正文来源行，不写入目标笔记 props */
  origin?: NoteOrigin;
  /** 段标题（如「学习周报 09.25–10.01」）：正文不以标题开头时写成 `### 标题`，追加多次也分得清 */
  title?: string;
}

export type AppendTextToNoteResult =
  | { ok: true; noteId: string; title: string }
  | { ok: false; error: string };

/**
 * 拼接追加后的完整正文：既有内容尾部空白收敛后接分隔线与追加段。
 * 追加段只去掉首尾空行/尾部空白，保留首行缩进（代码块等）。
 */
export function joinAppendedNoteContent(existing: string, addition: string): string {
  const head = existing.replace(/\s+$/u, '');
  const tail = addition.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/\s+$/u, '');
  if (!head) return tail;
  if (!tail) return head;
  return `${head}${NOTE_APPEND_SEPARATOR}${tail}`;
}

/**
 * 追加段的来源行。资源来源（PDF 等）的来源行由调用方写进正文（pdfref:// 回链），
 * 这里只为聊天来源补一行——追加不改目标笔记的 _origin，没有这一行就丢了出处。
 */
export function buildAppendSourceLine(origin?: NoteOrigin): string | null {
  if (origin?.kind !== 'chat') return null;
  const title = origin.title?.replace(/\s+/gu, ' ').trim();
  const label = title
    ? i18n.t('chatV2:selectionToolbar.appendToNoteSourceChat', {
        defaultValue: '来自对话「{{title}}」',
        title,
      })
    : i18n.t('chatV2:selectionToolbar.appendToNoteSourceChatUntitled', '来自对话');
  return `> ${label}`;
}

/** 组装追加段：段标题（如有且正文未自带标题）+ 来源行（如有）+ 正文 */
export function composeAppendSection(content: string, origin?: NoteOrigin, title?: string): string {
  const body = content.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/\s+$/u, '');
  const sourceLine = buildAppendSourceLine(origin);
  const heading = title?.replace(/\s+/gu, ' ').trim();
  // 标题常由正文首句截取（聊天消息默认标题）：与正文开头重复时不加，避免同一句出现两次
  const plain = (text: string) => text.replace(/[*_`#>\s]/gu, '');
  const firstLine = body.split(/\r?\n/u, 1)[0] ?? '';
  const headingRepeatsBody = Boolean(heading) && plain(firstLine).startsWith(plain(heading ?? '').slice(0, 24));
  const parts = [
    heading && !/^#{1,6}\s/u.test(body) && !headingRepeatsBody ? `### ${heading}` : null,
    sourceLine,
    body,
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n\n');
}

/**
 * 目标笔记若在编辑器中有未保存修改，先冲刷到磁盘。
 * 返回 false = 仍有未落盘修改（冲刷失败 / 无保存挂点），调用方应放弃追加。
 */
async function flushOpenNoteEditor(noteId: string): Promise<boolean> {
  // 动态 import：shared 层不静态依赖 features/workbench（与 saveTextAsNote 的 noteOrigin 同理）
  const registry = await import('@/features/workbench/apps/content/contentDirtyRegistry');
  if (!registry.isContentDirty('note', noteId)) return true;
  const saved = await registry.saveContentNow('note', noteId);
  return saved && !registry.isContentDirty('note', noteId);
}

/** 把一段文本追加到已有笔记末尾（带乐观锁基线写入）。 */
export async function appendTextToNote(input: AppendTextToNoteInput): Promise<AppendTextToNoteResult> {
  if (!input.content?.trim()) {
    return { ok: false, error: i18n.t('chatV2:messageItem.actions.noContentToExport') };
  }
  if (!input.noteId) {
    return {
      ok: false,
      error: i18n.t('chatV2:selectionToolbar.appendToNoteNotFound', '笔记不存在或已被删除'),
    };
  }

  const path = `/${input.noteId}`;
  const section = composeAppendSection(input.content, input.origin, input.title);

  try {
    const flushed = await flushOpenNoteEditor(input.noteId);
    if (!flushed) {
      return {
        ok: false,
        error: i18n.t(
          'chatV2:selectionToolbar.appendToNoteDirty',
          '这篇笔记有未保存的修改，请先保存后再追加',
        ),
      };
    }

    for (let attempt = 0; ; attempt += 1) {
      const nodeResult = await dstu.get(path);
      if (!nodeResult.ok) return { ok: false, error: nodeResult.error.toUserMessage() };
      const node = nodeResult.value;
      if (!node || node.type !== 'note') {
        return {
          ok: false,
          error: i18n.t('chatV2:selectionToolbar.appendToNoteNotFound', '笔记不存在或已被删除'),
        };
      }

      const contentResult = await dstu.getContent(path);
      if (!contentResult.ok) return { ok: false, error: contentResult.error.toUserMessage() };
      const existing = typeof contentResult.value === 'string' ? contentResult.value : '';

      const updated = await dstu.update(path, joinAppendedNoteContent(existing, section), 'note', {
        expectedUpdatedAtMs: node.updatedAt,
      });
      if (updated.ok) {
        return { ok: true, noteId: input.noteId, title: updated.value.name || node.name };
      }
      if (updated.error.code === VfsErrorCode.CONFLICT && attempt < MAX_CONFLICT_RETRIES) {
        continue;
      }
      return { ok: false, error: updated.error.toUserMessage() };
    }
  } catch (error: unknown) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/** 成功 toast（带「打开笔记」动作，与新建路径一致）；失败 toast。 */
export function notifyAppendTextToNoteResult(
  result: AppendTextToNoteResult,
  options?: { openSource?: string },
): void {
  if (result.ok === false) {
    showGlobalNotification(
      'error',
      result.error,
      i18n.t('chatV2:selectionToolbar.appendToNoteFailed', '追加到笔记失败'),
    );
    return;
  }

  const { noteId, title } = result;
  const openSource = options?.openSource;
  showGlobalNotification(
    'success',
    i18n.t('chatV2:selectionToolbar.appendToNoteSuccess', {
      defaultValue: '已追加到「{{title}}」',
      title,
    }),
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

/** 选好笔记 → 追加 → 提示，一步到位。 */
export async function appendTextToNoteAndNotify(
  input: AppendTextToNoteInput,
  options?: { openSource?: string },
): Promise<AppendTextToNoteResult> {
  const result = await appendTextToNote(input);
  notifyAppendTextToNoteResult(result, options);
  return result;
}
