import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import type { NoteRepository, NotesService } from '../../../notes/api.ts';

/**
 * notes 测试替身（`host/kernel/testing.ts` 允许为其他 lane 的服务提供替身）。
 *
 * 只实现文件夹级联实际调用的仓储方法，语义与 Rust `note_repo` 对应方法一致：
 * - `delete_note_with_conn`：只写 `notes.deleted_at`；
 * - `restore_note_with_conn`：清空 `deleted_at` 并恢复该笔记的 `folder_items`；
 * - `purge_note_with_conn`：删除 `folder_items` 与 `notes`，无引用时删除资源行。
 *
 * 生产路径注入的是 notes 插件发布的真实 `notes`，不是这个替身。
 */
export function notesServiceDouble(db: () => SqlExecutor): NotesService {
  const repository = {
    deleteNote(id: string, conn?: SqlExecutor): void {
      const executor = conn ?? db();
      const now = new Date().toISOString();
      executor.run('UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL', [now, id]);
    },
    restoreNote(id: string, conn?: SqlExecutor): void {
      const executor = conn ?? db();
      executor.run('UPDATE notes SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2', [new Date().toISOString(), id]);
      executor.run("UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'note' AND item_id = ?2",
        [Date.now(), id]);
    },
    purgeNote(id: string, conn?: SqlExecutor): void {
      const executor = conn ?? db();
      const note = executor.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id = ?1', [id]);
      executor.run("DELETE FROM folder_items WHERE item_type = 'note' AND item_id = ?1", [id]);
      executor.run('DELETE FROM notes WHERE id = ?1', [id]);
      if (note === undefined) return;
      const refs = Number(executor.pluck<number>('SELECT COUNT(*) FROM notes WHERE resource_id = ?1',
        [note.resource_id]) ?? 0);
      if (refs === 0) executor.run('DELETE FROM resources WHERE id = ?1', [note.resource_id]);
    },
  };
  return { version: 1, repository: repository as unknown as NoteRepository } as NotesService;
}
