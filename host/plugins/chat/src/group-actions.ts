/**
 * Topic (session group) commands. Rust source: `chat_v2/handlers/group_handlers.rs`.
 *
 * `create_group` / `update_group` resolve a runtime-root binding through the
 * L05 runtime-root service; when that service is absent a non-empty binding
 * fails with the same validation error Rust reports for an unresolvable root.
 */
import { isAbsolute } from '../../../platform/util/path.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ChatV2State } from './state.ts';
import { ChatV2Error } from './error.ts';
import { utcNow } from './types.ts';
import type { ChatLogger } from './logger.ts';
import { StudySpaceRepo, type FolderRepository } from '../../vfs-repos/api.ts';
import {
  archiveGroup, createGroup, getGroup, listGroups, permanentlyDeleteGroup, restoreGroup,
  listSessionIdsOwnedByGroup, updateGroup,
} from '../repository/groups.ts';
import { sessionHasLiveAnkiBlocks, type StaleAnkiBlockReaperSlot } from './stale-anki-reaper.ts';
import {
  createVfsFolder, generateUniqueFolderTitle, getVfsFolder, newVfsFolder,
  renameVfsFolder, vfsFolderExists, MAX_FOLDER_TITLE_LENGTH,
} from '../repository/vfs-folders.ts';

export interface VfsFolderDatabaseLike {
  getConnSafe(): DatabaseHandle;
}
export interface VfsFolderServiceLike {
  readonly version: 1;
  readonly database: VfsFolderDatabaseLike;
  readonly folders?: FolderRepository;
}
export type VfsFolderLookup = () => VfsFolderServiceLike | undefined;

const studySpaces = new StudySpaceRepo();

function syncStudySpace(vfs: VfsFolderServiceLike | undefined, group: SessionGroup): void {
  if (!vfs || !group.rootFolderId) return;
  const conn = vfsHandle(vfs);
  if (group.persistStatus !== 'active') {
    studySpaces.archiveProfile(conn, group.id);
    return;
  }
  const previous = studySpaces.getProfile(conn, group.id, true);
  if (previous?.rootFolderId === group.rootFolderId && studySpaces.getProfile(conn, group.id)) return;
  studySpaces.upsertProfile(conn, { ...previous, spaceId: group.id, rootFolderId: group.rootFolderId });
}

/** L05 `runtime_root_by_id(app, db, "session-preview", None, Some(id), false)` subset. */
export interface RuntimeRootLookup {
  resolve(rootId: string): { path: string } | null;
}
export type RuntimeRootLookupGetter = () => RuntimeRootLookup | undefined;

/** `resolve_group_preferred_runtime_root` (group_handlers.rs:106-142). */
function resolveGroupPreferredRuntimeRoot(
  rootId: string | null | undefined, lookup: RuntimeRootLookupGetter,
): [string | null, string | null] {
  if (rootId === null || rootId === undefined) return [null, null];
  const trimmed = rustTrim(rootId);
  if (trimmed === '') return [null, null];
  if (isAbsolute(trimmed)) {
    throw new ChatV2Error('Validation',
      'defaultRuntimeRootId must be a runtime root id (workspace / authorized_*), not a filesystem path');
  }
  const service = lookup();
  if (service === undefined) {
    throw new ChatV2Error('Validation',
      `defaultRuntimeRootId '${trimmed}' is not resolvable on this device: runtime root service is unavailable`);
  }
  let root: { path: string } | null;
  try { root = service.resolve(trimmed); }
  catch (error) {
    throw new ChatV2Error('Validation', `defaultRuntimeRootId '${trimmed}' is not resolvable on this device: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (root === null) {
    throw new ChatV2Error('Validation',
      `defaultRuntimeRootId '${trimmed}' is not resolvable on this device: runtime root not found`);
  }
  return [trimmed, root.path];
}

/** `chat_v2_create_group` (group_handlers.rs:144-191). */
export function createGroupAction(
  db: DatabaseHandle, vfs: VfsFolderServiceLike | undefined,
  request: CreateGroupRequest, runtimeRoots: RuntimeRootLookupGetter,
  log?: ChatLogger,
): SessionGroup {
  const existing = listGroups(db, 'active', request.workspaceId ?? null, log);
  const nextSort = existing.reduce((max, group) => Math.max(max, group.sortOrder), 0) + 1;
  const [defaultRuntimeRootId, preferredProjectRootPath] =
    resolveGroupPreferredRuntimeRoot(request.defaultRuntimeRootId, runtimeRoots);
  const { rootFolderId, pinned: pinnedResourceIds } = ensureGroupFolder(
    vfs, request.name, request.pinnedResourceIds ?? [], request.rootFolderId,
  );
  const now = utcNow();
  const group: SessionGroup = {
    id: `group_${globalThis.crypto.randomUUID()}`,
    name: request.name,
    defaultSkillIds: request.defaultSkillIds ?? [],
    pinnedResourceIds,
    rootFolderId,
    sortOrder: nextSort,
    persistStatus: 'active',
    createdAt: now,
    updatedAt: now,
  };
  if (request.description !== null && request.description !== undefined) group.description = request.description;
  if (request.icon !== null && request.icon !== undefined) group.icon = request.icon;
  if (request.color !== null && request.color !== undefined) group.color = request.color;
  if (request.systemPrompt !== null && request.systemPrompt !== undefined) group.systemPrompt = request.systemPrompt;
  if (request.workspaceId !== null && request.workspaceId !== undefined) group.workspaceId = request.workspaceId;
  if (defaultRuntimeRootId !== null) group.defaultRuntimeRootId = defaultRuntimeRootId;
  if (preferredProjectRootPath !== null) group.preferredProjectRootPath = preferredProjectRootPath;
  createGroup(db, group);
  syncStudySpace(vfs, group);
  return group;
}

/** None keeps the old value; an empty/whitespace string clears it (group_handlers.rs:214-222). */
function mergeOptionalString(
  requestValue: string | null | undefined, existingValue: string | null | undefined,
): string | null {
  if (requestValue === null || requestValue === undefined) return existingValue ?? null;
  if (rustTrim(requestValue) === '') return null;
  return requestValue;
}

/** Contract's derived enum accepts both `"archived"` and `{"archived": null}`. */
function persistStatusValue(value: UpdateGroupRequest['persistStatus']): 'active' | 'archived' | 'deleted' | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if ('active' in value) return 'active';
  if ('archived' in value) return 'archived';
  return 'deleted';
}

/** `chat_v2_update_group` (group_handlers.rs:194-247). */
export function updateGroupAction(
  db: DatabaseHandle, vfs: VfsFolderServiceLike | undefined,
  groupId: string, request: UpdateGroupRequest, runtimeRoots: RuntimeRootLookupGetter,
): SessionGroup {
  const existing = getGroup(db, groupId);
  if (existing === null) throw new ChatV2Error('GroupNotFound', groupId);
  const name = request.name ?? existing.name;
  const requestedRoot = request.rootFolderId !== undefined ? request.rootFolderId : existing.rootFolderId;
  let defaultRuntimeRootId: string | null;
  let preferredProjectRootPath: string | null;
  if (request.defaultRuntimeRootId === null || request.defaultRuntimeRootId === undefined) {
    defaultRuntimeRootId = existing.defaultRuntimeRootId ?? null;
    preferredProjectRootPath = mergeOptionalString(
      request.preferredProjectRootPath, existing.preferredProjectRootPath);
  } else {
    [defaultRuntimeRootId, preferredProjectRootPath] =
      resolveGroupPreferredRuntimeRoot(request.defaultRuntimeRootId, runtimeRoots);
  }
  const requestedStatus = persistStatusValue(request.persistStatus);
  const { rootFolderId, pinned: pinnedResourceIds } = ensureGroupFolder(
    vfs, name, request.pinnedResourceIds ?? existing.pinnedResourceIds, requestedRoot,
  );
  const updated: SessionGroup = {
    ...existing,
    name,
    defaultSkillIds: request.defaultSkillIds ?? existing.defaultSkillIds,
    pinnedResourceIds,
    rootFolderId,
    sortOrder: request.sortOrder ?? existing.sortOrder,
    persistStatus: requestedStatus ?? existing.persistStatus,
    updatedAt: utcNow(),
  };
  const description = mergeOptionalString(request.description, existing.description);
  const icon = mergeOptionalString(request.icon, existing.icon);
  const color = mergeOptionalString(request.color, existing.color);
  const systemPrompt = mergeOptionalString(request.systemPrompt, existing.systemPrompt);
  const workspaceId = mergeOptionalString(request.workspaceId, existing.workspaceId);
  if (description === null) delete updated.description; else updated.description = description;
  if (icon === null) delete updated.icon; else updated.icon = icon;
  if (color === null) delete updated.color; else updated.color = color;
  if (systemPrompt === null) delete updated.systemPrompt; else updated.systemPrompt = systemPrompt;
  if (workspaceId === null) delete updated.workspaceId; else updated.workspaceId = workspaceId;
  if (defaultRuntimeRootId === null) delete updated.defaultRuntimeRootId;
  else updated.defaultRuntimeRootId = defaultRuntimeRootId;
  if (preferredProjectRootPath === null) delete updated.preferredProjectRootPath;
  else updated.preferredProjectRootPath = preferredProjectRootPath;
  updateGroup(db, updated);
  if (requestedStatus === 'archived') archiveGroup(db, groupId);
  else if (requestedStatus === 'active') restoreGroup(db, groupId);
  syncStudySpace(vfs, updated);
  return updated;
}

function vfsHandle(vfs: VfsFolderServiceLike | undefined): DatabaseHandle {
  if (vfs === undefined) throw new ChatV2Error('Database', 'VFS database is unavailable');
  try {
    return vfs.database.getConnSafe();
  } catch (error) {
    throw new ChatV2Error('Database', error instanceof Error ? error.message : String(error));
  }
}

/** `topic_folder_title` (group_handlers.rs:23-41). */
export function topicFolderTitle(name: string): string {
  let title = [...rustTrim(name)].slice(0, MAX_FOLDER_TITLE_LENGTH).map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (code < 0x20 || (code >= 0x7f && code <= 0x9f)) || ch === '\0' || ch === '/' || ch === '\\' ? '_' : ch;
  }).join('');
  title = title.replace(/^_+|_+$/g, '');
  title = rustTrim(title);
  return title === '' ? '未命名课题' : title;
}

/** `first_pinned_folder_id` (group_handlers.rs:43-50). */
function firstPinnedFolderId(pinnedResourceIds: string[]): string | null {
  for (const id of pinnedResourceIds) {
    const trimmed = rustTrim(id);
    if (trimmed.startsWith('fld_')) return trimmed;
  }
  return null;
}

/** `prepend_unique_pinned_folder` (group_handlers.rs:52-59). */
function prependUniquePinnedFolder(pinnedResourceIds: string[], folderId: string): string[] {
  const next = pinnedResourceIds.filter(id => rustTrim(id) !== folderId);
  next.unshift(folderId);
  return next;
}

function vfsDatabaseError(error: unknown): ChatV2Error {
  return new ChatV2Error('Database', error instanceof Error ? error.message : String(error));
}

/** `ensure_group_folder` (group_handlers.rs:62-114). */
export function ensureGroupFolder(
  vfs: VfsFolderServiceLike | undefined,
  groupName: string,
  pinnedResourceIds: string[],
  explicitRootFolderId?: string | null,
): { rootFolderId: string; pinned: string[] } {
  const conn = vfsHandle(vfs);
  const folderTitle = topicFolderTitle(groupName);
  try {
    const folders = vfs?.folders;
    if (folders === undefined) throw new Error('VfsFolderRepo is not available');
    const explicitTrimmed = typeof explicitRootFolderId === 'string' ? rustTrim(explicitRootFolderId) : '';
    const candidateId = explicitTrimmed.startsWith('fld_')
      ? explicitTrimmed
      : firstPinnedFolderId(pinnedResourceIds);
    if (candidateId !== null && candidateId !== 'fld_inbox') {
      const folder = getVfsFolder(conn, candidateId, folders);
      if (folder !== null && vfsFolderExists(conn, candidateId, folders)) {
        const uniqueTitle = generateUniqueFolderTitle(conn, folderTitle, folder.parentId, candidateId, folders);
        if (folder.title !== uniqueTitle) {
          folder.title = uniqueTitle;
          renameVfsFolder(conn, folder, folders);
        }
        return {
          rootFolderId: candidateId,
          pinned: prependUniquePinnedFolder(pinnedResourceIds, candidateId),
        };
      }
    }
    const uniqueTitle = generateUniqueFolderTitle(conn, folderTitle, null, null, folders);
    const folder = newVfsFolder(uniqueTitle, null, 'folder');
    createVfsFolder(conn, folder, folders);
    return {
      rootFolderId: folder.id,
      pinned: prependUniquePinnedFolder(pinnedResourceIds.filter(id => rustTrim(id) !== candidateId), folder.id),
    };
  } catch (error) {
    throw vfsDatabaseError(error);
  }
}

/** `chat_v2_get_group` (group_handlers.rs:347-374). */
export function getGroupAction(
  db: DatabaseHandle, vfs: VfsFolderServiceLike | undefined, groupId: string,
): SessionGroup | null {
  const group = getGroup(db, groupId);
  if (group === null) return null;
  if (group.persistStatus !== 'active') return group;
  const { rootFolderId, pinned } = ensureGroupFolder(
    vfs, group.name, group.pinnedResourceIds, group.rootFolderId,
  );
  syncStudySpace(vfs, { ...group, rootFolderId });
  if (
    JSON.stringify(pinned) === JSON.stringify(group.pinnedResourceIds)
    && (group.rootFolderId ?? null) === rootFolderId
  ) {
    return group;
  }
  const updated: SessionGroup = {
    ...group, pinnedResourceIds: pinned, rootFolderId, updatedAt: utcNow(),
  };
  updateGroup(db, updated);
  return updated;
}

/** `chat_v2_list_groups` (group_handlers.rs:377-405). */
export function listGroupsAction(
  db: DatabaseHandle, vfs: VfsFolderServiceLike | undefined,
  status: string | null | undefined, workspaceId: string | null | undefined,
  log?: ChatLogger,
): SessionGroup[] {
  const groups = listGroups(db, status ?? null, workspaceId ?? null, log);
  for (const group of groups) {
    if (group.persistStatus !== 'active') continue;
    const { rootFolderId, pinned } = ensureGroupFolder(
      vfs, group.name, group.pinnedResourceIds, group.rootFolderId,
    );
    syncStudySpace(vfs, { ...group, rootFolderId });
    if (
      JSON.stringify(pinned) === JSON.stringify(group.pinnedResourceIds)
      && (group.rootFolderId ?? null) === rootFolderId
    ) {
      continue;
    }
    group.pinnedResourceIds = pinned;
    group.rootFolderId = rootFolderId;
    updateGroup(db, group);
  }
  return groups;
}

/** `chat_v2_archive_group` (group_handlers.rs:311-320). */
export function archiveGroupAction(db: DatabaseHandle, groupId: string, vfs?: VfsFolderServiceLike): void {
  archiveGroup(db, groupId);
  if (vfs) studySpaces.archiveProfile(vfsHandle(vfs), groupId);
}

/** `chat_v2_restore_group` (group_handlers.rs:323-345). */
export function restoreGroupAction(
  db: DatabaseHandle, vfs: VfsFolderServiceLike | undefined, groupId: string,
): SessionGroup {
  restoreGroup(db, groupId);
  const group = getGroup(db, groupId);
  if (group === null) throw new ChatV2Error('GroupNotFound', groupId);
  const { rootFolderId, pinned } = ensureGroupFolder(
    vfs, group.name, group.pinnedResourceIds, group.rootFolderId,
  );
  syncStudySpace(vfs, { ...group, rootFolderId });
  if (
    JSON.stringify(pinned) !== JSON.stringify(group.pinnedResourceIds)
    || (group.rootFolderId ?? null) !== rootFolderId
  ) {
    group.pinnedResourceIds = pinned;
    group.rootFolderId = rootFolderId;
    updateGroup(db, group);
  }
  return group;
}

/** `chat_v2_delete_group` (group_handlers.rs:271-308), minus the VFS ref decrement. */
export function deleteGroupAction(
  db: DatabaseHandle, state: ChatV2State, groupId: string, reapers: StaleAnkiBlockReaperSlot, log: ChatLogger,
  vfs?: VfsFolderServiceLike,
): void {
  const group = getGroup(db, groupId);
  if (group === null) throw new ChatV2Error('GroupNotFound', groupId);
  if (group.persistStatus === 'active') {
    throw new ChatV2Error('Validation', '请先归档课题，再从归档页永久删除。');
  }
  const sessionIds = listSessionIdsOwnedByGroup(db, groupId);
  for (const sessionId of sessionIds) {
    if (state.hasActiveStream(sessionId)) {
      throw new ChatV2Error('Other',
        'Cannot delete topic while a session is streaming. Please wait for completion or cancel first.');
    }
    if (sessionHasLiveAnkiBlocks(db, sessionId, reapers, log)) {
      throw new ChatV2Error('Other',
        'Cannot delete topic while ChatAnki generation is still running. Please wait for completion or cancel first.');
    }
  }
  // Rust decrements each session's VFS resource refs here; that counter belongs
  // to the VFS lane, whose failures only abort the delete when its DB is down.
  permanentlyDeleteGroup(db, groupId);
  if (vfs && group.rootFolderId) studySpaces.deleteProfile(vfsHandle(vfs), groupId);
}
