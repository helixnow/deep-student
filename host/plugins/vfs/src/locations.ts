import { CommandError } from '../../../kernel/api.ts';
import type { BatchMoveRequest, BatchMoveResult, ResourceLocation } from '../api.ts';
import type { VfsDatabase } from '../api.ts';
import { dstuNodeTypeFromString, inferDstuResourceType, movedEvent, type DstuNode, type DstuWatchEvent } from './dstu-types.ts';
import { canonicalFolderItemType } from './folder-types.ts';
import { vfsRepositories } from '../repository/services.ts';
import {
  buildFolderPathWithConn,
  getActiveFolderItemIdWithConn,
  getActiveFolderItemLocationWithConn,
  getResourcePathWithConn,
  insertFolderItemLocationWithConn,
  listFolderItemsForRefreshWithConn,
  moveFolderItemByIdWithConn,
  moveSingleFolderItemWithConn,
  setFolderItemCachedPathWithConn,
} from '../repository/locations.ts';

export interface LocationLog {
  warn(message: string, ...args: unknown[]): void;
}

/** Logger shape for commands whose Rust source also logs info!/error!. */
export interface DstuCommandLog extends LocationLog {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LocationDeps {
  readonly database: VfsDatabase;
  readonly log: LocationLog;
  readonly emit?: (event: string, payload: unknown) => void;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

function warn(deps: LocationDeps, message: string, ...args: unknown[]): void {
  deps.log.warn(message, ...args);
}

/** `emit_watch_event` (node_converters.rs:152-172) emits both the path and the generic event. */
export function emitDstuWatchEvent(deps: LocationDeps, event: DstuWatchEvent): void {
  if (deps.emit === undefined) return;
  for (const name of [`dstu:change:${event.path}`, 'dstu:change']) {
    try {
      deps.emit(name, event);
    } catch (error) {
      warn(deps, '[DSTU::handlers] Failed to emit event %s: %s', name, error instanceof Error ? error.message : String(error));
    }
  }
}

function eventNode(location: ResourceLocation): DstuNode {
  const now = Date.now();
  return {
    id: location.id,
    sourceId: location.id,
    name: location.id,
    path: location.fullPath,
    type: dstuNodeTypeFromString(location.resourceType) ?? 'file',
    createdAt: now,
    updatedAt: now,
  };
}

function movedLocationEvent(deps: LocationDeps, oldPath: string, location: ResourceLocation): void {
  emitDstuWatchEvent(deps, movedEvent(oldPath, location.fullPath, eventNode(location)));
}

function folderPath(deps: LocationDeps, conn: ReturnType<VfsDatabase['getConnSafe']>, folderId: string): string {
  try {
    return buildFolderPathWithConn(conn, folderId);
  } catch (error) {
    warn(deps, '[DSTU::handlers] Failed to build folder path for %s: %s', folderId, error instanceof Error ? error.message : String(error));
    return '';
  }
}

/** `dstu_build_path` (handlers.rs:5927-5965). */
export function buildPathCommand(
  deps: LocationDeps & { log: LocationLog & { info(message: string, ...args: unknown[]): void } },
  folderId: string | null | undefined,
  resourceId: string,
): string {
  return command(() => {
    deps.log.info('[DSTU::handlers] dstu_build_path: folder_id=%s, resource_id=%s', folderId ?? null, resourceId);
    const path = folderId === undefined || folderId === null
      ? ''
      : vfsRepositories().folders.buildFolderPath(deps.database.getConnSafe(), folderId);
    const fullPath = path === '' ? `/${resourceId}` : `${path}/${resourceId}`;
    deps.log.info('[DSTU::handlers] dstu_build_path: result=%s', fullPath);
    return fullPath;
  });
}

/** `dstu_get_resource_location` (handlers.rs:5983-6038). */
export function getResourceLocationCommand(deps: LocationDeps, resourceId: string): ResourceLocation {
  return command(() => {
    const resourceType = inferDstuResourceType(resourceId) ?? 'unknown';
    const conn = deps.database.getConnSafe();
    const row = getActiveFolderItemLocationWithConn(conn, resourceType, resourceId);
    const folderId = row?.folderId ?? null;
    const cachedPath = row?.cachedPath ?? null;
    const path = folderId === null ? '' : folderPath(deps, conn, folderId);
    const fullPath = cachedPath ?? (path === '' ? `/${resourceId}` : `${path}/${resourceId}`);
    return {
      id: resourceId,
      resourceType,
      folderId,
      folderPath: path,
      fullPath,
      hash: null,
    };
  });
}

function moveResources(
  deps: LocationDeps,
  resourceId: string,
  targetFolderId: string | null | undefined,
  path: string,
): { location: ResourceLocation; oldPath: string } {
  const conn = deps.database.getConnSafe();
  const resourceType = inferDstuResourceType(resourceId) ?? 'unknown';
  const canonical = canonicalFolderItemType(resourceType);
  const target = targetFolderId ?? null;
  const oldPath = getActiveFolderItemLocationWithConn(conn, canonical, resourceId)?.cachedPath
    ?? `/${resourceId}`;
  const fullPath = path === '' ? `/${resourceId}` : `${path}/${resourceId}`;
  const now = Date.now();
  const existing = getActiveFolderItemIdWithConn(conn, canonical, resourceId);
  if (existing !== undefined) {
    moveFolderItemByIdWithConn(conn, resourceId, target, fullPath, now);
  } else {
    insertFolderItemLocationWithConn(conn, canonical, resourceId, target, fullPath, now);
  }
  return {
    location: {
      id: resourceId,
      resourceType,
      folderId: target,
      folderPath: path,
      fullPath,
      hash: null,
    },
    oldPath,
  };
}

/** `dstu_move_to_folder` (handlers.rs:6146-6247). */
export function moveToFolderCommand(
  deps: LocationDeps,
  resourceId: string,
  targetFolderId?: string | null,
): ResourceLocation {
  return command(() => {
    const conn = deps.database.getConnSafe();
    const target = targetFolderId ?? null;
    const path = target === null ? '' : folderPath(deps, conn, target);
    const { location, oldPath } = moveResources(deps, resourceId, target, path);
    movedLocationEvent(deps, oldPath, location);
    return location;
  });
}

function moveSingleItem(
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  resourceId: string,
  targetFolderId: string | null,
  path: string,
): { location: ResourceLocation; oldPath: string; resourceType: string } {
  const resourceType = inferDstuResourceType(resourceId) ?? 'unknown';
  const canonical = canonicalFolderItemType(resourceType);
  let oldPath: string;
  try {
    oldPath = getActiveFolderItemLocationWithConn(conn, canonical, resourceId)?.cachedPath
      ?? `/${resourceId}`;
  } catch (error) {
    throw new Error(`查询旧路径失败 (${resourceId}): ${error instanceof Error ? error.message : String(error)}`);
  }

  const fullPath = path === '' ? `/${resourceId}` : `${path}/${resourceId}`;
  const now = Date.now();
  let existing: string | undefined;
  try {
    existing = getActiveFolderItemIdWithConn(conn, canonical, resourceId);
  } catch (error) {
    throw new Error(`查询现有记录失败 (${resourceId}): ${error instanceof Error ? error.message : String(error)}`);
  }

  if (existing !== undefined) {
    try {
      moveSingleFolderItemWithConn(conn, canonical, resourceId, targetFolderId, fullPath, now);
    } catch (error) {
      throw new Error(`更新 folder_items 失败 (${resourceId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      insertFolderItemLocationWithConn(conn, canonical, resourceId, targetFolderId, fullPath, now);
    } catch (error) {
      throw new Error(`插入 folder_items 失败 (${resourceId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    location: {
      id: resourceId,
      resourceType,
      folderId: targetFolderId,
      folderPath: path,
      fullPath,
      hash: null,
    },
    oldPath,
    resourceType,
  };
}

/** `dstu_batch_move` (handlers.rs:6268-6387). */
export function batchMoveCommand(deps: LocationDeps, request: BatchMoveRequest): BatchMoveResult {
  return command(() => {
    const totalCount = request.itemIds.length;
    if (totalCount === 0) return { successes: [], failedItems: [], totalCount: 0 };

    const conn = deps.database.getConnSafe();
    const target = request.targetFolderId ?? null;
    const path = target === null ? '' : folderPath(deps, conn, target);
    const successes: ResourceLocation[] = [];
    const failedItems: Array<{ itemId: string; error: string }> = [];

    for (const resourceId of request.itemIds) {
      try {
        const { location, oldPath } = moveSingleItem(conn, resourceId, target, path);
        successes.push(location);
        movedLocationEvent(deps, oldPath, location);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(deps, '[DSTU::handlers] dstu_batch_move: 移动失败 item_id=%s, error=%s', resourceId, message);
        failedItems.push({ itemId: resourceId, error: message });
      }
    }

    return { successes, failedItems, totalCount };
  });
}

/** `dstu_refresh_path_cache` (handlers.rs:6508-6617). */
export function refreshPathCacheCommand(deps: LocationDeps, resourceId?: string | null): number {
  return command(() => {
    const conn = deps.database.getConnSafe();
    const items = resourceId === undefined || resourceId === null
      ? listFolderItemsForRefreshWithConn(conn)
      : listFolderItemsForRefreshWithConn(
        conn,
        canonicalFolderItemType(inferDstuResourceType(resourceId) ?? 'unknown'),
        resourceId,
      );

    let updatedCount = 0;
    for (const item of items) {
      const path = item.folderId === null ? '' : folderPath(deps, conn, item.folderId);
      const fullPath = path === '' ? `/${item.itemId}` : `${path}/${item.itemId}`;
      setFolderItemCachedPathWithConn(conn, item.id, fullPath);
      updatedCount += 1;
    }
    return updatedCount;
  });
}

/** `dstu_get_path_by_id`/`get_resource_path_internal` (ref_handlers.rs:1979-1016). */
export function getPathByIdCommand(deps: LocationDeps, resourceId: string): string {
  return command(() => getResourcePathWithConn(deps.database.getConnSafe(), resourceId));
}
