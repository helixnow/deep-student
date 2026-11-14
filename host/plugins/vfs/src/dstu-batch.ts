/**
 * DSTU batch commands: dstu_delete_many and dstu_move_many.
 * Rust: dstu/handlers.rs:5264-5640.
 */
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { VfsDatabase } from '../api.ts';
import type { DstuNode } from './dstu-types.ts';
import { emitDstuWatchEvent, type LocationDeps } from './locations.ts';
import { extractResourceInfo } from './path-utils.ts';
import { getResourceByTypeAndId } from './dstu-resource.ts';
import { deleteResourceByTypeWithConn, type DstuTrashDeps } from './dstu-trash.ts';
import { collectDeleteManyResourceIdsWithConn } from '../repository/trash.ts';
import { vfsRepositories } from '../repository/services.ts';

const MAX_BATCH_SIZE = 100;

export interface DstuBatchDeps extends DstuTrashDeps {
  readonly database: VfsDatabase;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkBatchSize(paths: readonly string[]): void {
  if (paths.length > MAX_BATCH_SIZE) {
    throw new Error(`批量操作数量超出限制：最多允许 ${MAX_BATCH_SIZE} 个，实际 ${paths.length} 个`);
  }
}

/** `dstu_delete_many` (handlers.rs:5264-5426). */
export function deleteManyCommand(deps: DstuBatchDeps, paths: readonly string[]): number {
  return command(() => {
    checkBatchSize(paths);
    if (paths.length === 0) return 0;

    const parsed: { resourceType: string; id: string }[] = [];
    for (const path of paths) {
      try {
        parsed.push(extractResourceInfo(path));
      } catch (error) {
        throw new Error(`无效的资源路径 '${path}': ${failureMessage(error)}`);
      }
    }

    const resourceIdsToCleanup = collectDeleteManyResourceIdsWithConn(
      deps.database.getConnSafe(), parsed);
    const conn = deps.database.getConnSafe();
    try {
      conn.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new Error(`开始事务失败: ${failureMessage(error)}`);
    }
    try {
      for (const item of parsed) {
        deleteResourceByTypeWithConn(deps, conn, item.resourceType, item.id);
      }
    } catch (error) {
      try { conn.exec('ROLLBACK'); }
      catch (rollbackError) { // boundary-allow empty-catch: Rust `let _ = conn.execute("ROLLBACK")` 忽略回滚失败
        void rollbackError;
      }
      throw error;
    }
    try {
      conn.exec('COMMIT');
    } catch (error) {
      throw new Error(`提交事务失败: ${failureMessage(error)}`);
    }

    for (const path of paths) emitDstuWatchEvent(deps, { type: 'deleted', path });
    if (resourceIdsToCleanup.length > 0) {
      void deps.index.cleanupVectors(resourceIdsToCleanup).then(() => deps.log.info(
        '[DSTU::handlers] dstu_delete_many: cleaned up vectors for %s resources', resourceIdsToCleanup.length));
    }
    return paths.length;
  });
}

const MOVE_ITEM_TYPES: Readonly<Record<string, string>> = {
  notes: 'note',
  textbooks: 'textbook',
  exams: 'exam',
  translations: 'translation',
  essays: 'essay',
  folders: 'folder',
  mindmaps: 'mindmap',
  files: 'file',
  images: 'file',
  attachments: 'file',
};

/** `dstu_move_many` (handlers.rs:5531-5627). */
export function moveManyCommand(
  deps: DstuBatchDeps,
  paths: readonly string[],
  destFolder: string,
): number {
  return command(() => {
    checkBatchSize(paths);

    const trimmed = rustTrim(destFolder);
    let destFolderId: string | undefined;
    if (trimmed !== '' && trimmed !== '/') {
      const { resourceType, id } = extractResourceInfo(destFolder);
      if (resourceType !== 'folders') throw new Error('Destination must be a folder');
      destFolderId = id;
    }

    const conn = deps.database.getConnSafe();
    let success = 0;
    for (const path of paths) {
      let parsed: { resourceType: string; id: string };
      try {
        parsed = extractResourceInfo(path);
      } catch {
        continue;
      }
      const itemType = MOVE_ITEM_TYPES[parsed.resourceType];
      if (itemType === undefined) continue;
      try {
        vfsRepositories().folders.moveItemByItemId(conn, itemType, parsed.id, destFolderId ?? null);
        success += 1;
        const fetchType = parsed.resourceType === 'images' || parsed.resourceType === 'attachments'
          ? 'files'
          : parsed.resourceType;
        const node: DstuNode | null = getResourceByTypeAndId({ database: deps.database }, fetchType, parsed.id);
        if (node !== null) {
          emitDstuWatchEvent(deps, { type: 'moved', path: node.path, oldPath: path, node });
        }
      } catch (error) {
        deps.log.warn(
          '[DSTU::handlers] dstu_move_many: FAILED - type=%s, id=%s, error=%s',
          itemType,
          parsed.id,
          failureMessage(error),
        );
      }
    }
    return success;
  });
}
