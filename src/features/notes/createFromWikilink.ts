/**
 * 未解析 wikilink 点击 → 按标题创建笔记 → 打开。
 * 多编辑器实例共用同一 in-flight，避免重复创建。
 */

import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { CrepeEditorApi } from '@/components/crepe';
import { upsertWikilinkNoteCache } from './wikilinkNotesCache';

export const CREATE_FROM_WIKILINK_EVENT = 'notes:create-from-wikilink';

type CreateFromWikilinkDetail = { title: string };

let inflight: Promise<string | null> | null = null;
let inflightTitle: string | null = null;

/**
 * 按标题创建空笔记；同 title 并发请求合并为一次 create。
 * @returns 新笔记 id；失败返回 null
 */
export async function createNoteFromWikilinkTitle(title: string): Promise<string | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;

  if (inflight && inflightTitle === trimmed) {
    return inflight;
  }

  inflightTitle = trimmed;
  inflight = (async () => {
    try {
      const result = await notesDstuAdapter.createNote(trimmed, '');
      if (!result.ok) {
        showGlobalNotification('error', result.error.toUserMessage());
        return null;
      }
      const noteId = result.value.id;
      // 立即写入宿主索引，便于随后 refresh 未解析样式
      upsertWikilinkNoteCache({ id: noteId, title: trimmed });
      // 通知侧栏 / W1 notesRef 刷新索引（若有监听）
      window.dispatchEvent(
        new CustomEvent('notes:created', {
          detail: { noteId, title: trimmed, source: 'wikilink' },
        }),
      );
      window.dispatchEvent(
        new CustomEvent('DSTU_OPEN_NOTE', {
          detail: { noteId, source: 'wikilink', target: trimmed },
        }),
      );
      return noteId;
    } catch (error: unknown) {
      console.error('[createNoteFromWikilinkTitle] failed:', error);
      showGlobalNotification('error', `创建笔记「${trimmed}」失败`);
      return null;
    } finally {
      inflight = null;
      inflightTitle = null;
    }
  })();

  return inflight;
}

/**
 * 尝试把当前文档中的未解析 wikilink 刷成已解析样式。
 * 插件未暴露 refresh API：仅当 markdown 含 `[[title` 时 setMarkdown 同文触发 NodeView update；
 * 若 W1 resolve 未读 live 索引，视觉仍会保持 unresolved（见 W4 交付文档遗留）。
 */
export function refreshWikilinksAfterCreate(
  editor: CrepeEditorApi | null | undefined,
  title: string,
): void {
  if (!editor) return;
  const trimmed = title.trim();
  if (!trimmed) return;
  try {
    const md = editor.getMarkdown();
    if (!md.includes(`[[${trimmed}`)) return;
    editor.setMarkdown(md);
  } catch (error: unknown) {
    console.warn('[refreshWikilinksAfterCreate] skipped:', error);
  }
}

export function parseCreateFromWikilinkEvent(event: Event): string | null {
  const detail = (event as CustomEvent<CreateFromWikilinkDetail>).detail;
  const title = detail?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}
