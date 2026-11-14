/**
 * Study Space profiles, Inbox canonical folder, zero-copy cross-space mounts,
 * and semantic anchor backlink edges (`vfs.db`).
 *
 * Canonical `folder_items` and `idx_folder_items_item_active_unique` are never mutated here.
 */
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type AnchorEdgeAnchorObject,
  type AnchorEdgeRecord,
  type AnchorEdgeRect,
  type AnchorEdgeWireInput,
  type AnchorEdgesDeleteResult,
  type AnchorEdgesUpsertResult,
  type CreateSpaceMountInput,
  type ListSpaceMountsFilter,
  type RemoveSpaceMountInput,
  type ResolvedMountScope,
  type StudySpaceMount,
  type StudySpaceProfile,
  type StudySpaceRepository,
  type UpsertStudySpaceProfileInput,
  type VfsFolder,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { logWarn } from './logger.ts';

const ALLOWED_LAYOUT_PRESETS = new Set([
  'chat_focus',
  'split_reader_chat',
  'split_notes_chat',
  'practice_review',
  'freeform_desktop',
]);

const ALLOWED_MEMORY_SCOPES = new Set([
  'space_isolated',
  'space_and_global',
  'global_only',
]);

const ALLOWED_MOUNT_ITEM_TYPES = new Set([
  'note',
  'exam',
  'file',
  'image',
  'translation',
  'essay',
  'mindmap',
  'folder',
]);

const PROFILE_COLUMNS = `space_id, root_folder_id, exam_date, daily_budget_minutes, target_retention,
  workbench_layout_preset, default_deck_id, memory_scope, created_at, updated_at`;

const MOUNT_COLUMNS = 'id, space_id, target_folder_id, item_type, item_id, created_at';

const FOLDER_COLUMNS = `id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
  CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END AS created_at,
  CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END AS updated_at`;

const EDGE_COLUMNS = `edge_id, source_kind, source_resource_id, source_sub_id,
  source_anchor_uri, source_label, target_kind, target_resource_id,
  target_locator_key, target_page, target_start_ms, target_end_ms,
  target_rect_json, target_anchor_uri, study_space_id,
  created_at, updated_at`;

const UTF8_ENCODER = new TextEncoder();

function validationError(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `VALIDATION_ERROR: ${message}`);
}

function folderNotFound(folderId: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `FOLDER_NOT_FOUND: ${folderId}`, { id: folderId });
}

function asString(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asInt(value: SqlValue | undefined, fallback = 0): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function asNullableInt(value: SqlValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function asFloat(value: SqlValue | undefined, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function rowToProfile(row: Row): StudySpaceProfile {
  return {
    spaceId: asString(row['space_id']),
    rootFolderId: asString(row['root_folder_id']),
    examDate: asNullableString(row['exam_date']),
    dailyBudgetMinutes: asInt(row['daily_budget_minutes'], 45),
    targetRetention: asFloat(row['target_retention'], 0.9),
    workbenchLayoutPreset: asString(row['workbench_layout_preset']),
    defaultDeckId: asNullableString(row['default_deck_id']),
    memoryScope: asString(row['memory_scope']),
    createdAt: asString(row['created_at']),
    updatedAt: asString(row['updated_at']),
  };
}

function rowToMount(row: Row): StudySpaceMount {
  return {
    id: asString(row['id']),
    spaceId: asString(row['space_id']),
    targetFolderId: asString(row['target_folder_id']),
    itemType: asString(row['item_type']),
    itemId: asString(row['item_id']),
    createdAt: asString(row['created_at']),
  };
}

function rowToFolder(row: Row): VfsFolder {
  const folder: VfsFolder = {
    id: asString(row['id']),
    title: asString(row['title']),
    isExpanded: asInt(row['is_expanded'], 1) !== 0,
    isFavorite: asInt(row['is_favorite'], 0) !== 0,
    sortOrder: asInt(row['sort_order'], 0),
    createdAt: asInt(row['created_at'], 0),
    updatedAt: asInt(row['updated_at'], 0),
  };
  const parentId = asNullableString(row['parent_id']);
  if (parentId !== null) folder.parentId = parentId;
  const icon = asNullableString(row['icon']);
  if (icon !== null) folder.icon = icon;
  const color = asNullableString(row['color']);
  if (color !== null) folder.color = color;
  return folder;
}

function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T): T {
  const outermost = conn.inTransaction === false;
  conn.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  try {
    const result = run();
    conn.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      conn.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
    } catch (rollbackError) {
      logWarn('[VFS::StudySpaceRepo] Savepoint rollback failed:', rollbackError);
    }
    throw error;
  }
}

export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of UTF8_ENCODER.encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function parseRectJson(raw: string | null | undefined): AnchorEdgeRect | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const x = Number(rec['x']);
    const y = Number(rec['y']);
    const w = Number(rec['w']);
    const h = Number(rec['h']);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

function serializeAnchorObject(anchor: AnchorEdgeAnchorObject): string {
  const kind = anchor.kind.trim();
  const encodedId = encodeURIComponent(anchor.resourceId.trim());
  const query: string[] = [];
  switch (kind) {
    case 'pdf': {
      if (anchor.page !== null && anchor.page !== undefined) {
        query.push(`page=${Math.max(1, Math.trunc(anchor.page))}`);
      }
      if (anchor.rect !== null && anchor.rect !== undefined) {
        query.push(
          `rect=${anchor.rect.x.toFixed(4)},${anchor.rect.y.toFixed(4)},${anchor.rect.w.toFixed(4)},${anchor.rect.h.toFixed(4)}`,
        );
      }
      if (anchor.quote !== null && anchor.quote !== undefined && anchor.quote !== '') {
        query.push(`quote=${encodeURIComponent(anchor.quote)}`);
      }
      break;
    }
    case 'media': {
      if (anchor.startMs !== null && anchor.startMs !== undefined) {
        query.push(`t=${Math.max(0, Math.trunc(anchor.startMs))}`);
      }
      if (anchor.endMs !== null && anchor.endMs !== undefined) {
        query.push(`end=${Math.max(0, Math.trunc(anchor.endMs))}`);
      }
      if (anchor.quote !== null && anchor.quote !== undefined && anchor.quote !== '') {
        query.push(`quote=${encodeURIComponent(anchor.quote)}`);
      }
      break;
    }
    case 'note': {
      if (anchor.blockId !== null && anchor.blockId !== undefined && anchor.blockId !== '') {
        query.push(`block=${encodeURIComponent(anchor.blockId)}`);
      }
      if (anchor.heading !== null && anchor.heading !== undefined && anchor.heading !== '') {
        query.push(`heading=${encodeURIComponent(anchor.heading)}`);
      }
      break;
    }
    case 'mindmap': {
      if (anchor.nodeId !== null && anchor.nodeId !== undefined && anchor.nodeId !== '') {
        query.push(`node=${encodeURIComponent(anchor.nodeId)}`);
      }
      break;
    }
    case 'qbank': {
      if (anchor.questionId !== null && anchor.questionId !== undefined && anchor.questionId !== '') {
        query.push(`q=${encodeURIComponent(anchor.questionId)}`);
      }
      break;
    }
    case 'epub': {
      if (anchor.cfi !== null && anchor.cfi !== undefined && anchor.cfi !== '') {
        query.push(`cfi=${encodeURIComponent(anchor.cfi)}`);
      }
      break;
    }
    case 'custom': {
      const ns = encodeURIComponent(anchor.namespace ?? 'custom');
      const loc = encodeURIComponent(anchor.locator ?? '');
      return `ds-anchor://v1/custom/${ns}?id=${encodedId}&loc=${loc}`;
    }
    default:
      break;
  }
  if (anchor.aliasResourceId !== null && anchor.aliasResourceId !== undefined && anchor.aliasResourceId !== '') {
    query.push(`alias=${encodeURIComponent(anchor.aliasResourceId)}`);
  }
  if (anchor.label !== null && anchor.label !== undefined && anchor.label !== '') {
    query.push(`label=${encodeURIComponent(anchor.label)}`);
  }
  return query.length === 0
    ? `ds-anchor://v1/${kind}/${encodedId}`
    : `ds-anchor://v1/${kind}/${encodedId}?${query.join('&')}`;
}

function deriveLocatorKey(
  targetKind: string,
  targetPage: number | null,
  targetStartMs: number | null,
  targetAnchor: AnchorEdgeAnchorObject | null | undefined,
): string {
  switch (targetKind) {
    case 'pdf':
      return targetPage !== null ? `p:${targetPage}` : '';
    case 'media':
      return targetStartMs !== null ? `ms:${targetStartMs}` : '';
    case 'note':
      return targetAnchor?.blockId ? `blk:${targetAnchor.blockId}` : '';
    case 'epub':
      return targetAnchor?.cfi ? `cfi:${targetAnchor.cfi}` : '';
    default:
      return '';
  }
}

function stripControlAndTruncate(input: string, maxCodePoints: number): string {
  const out: string[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out.push(ch);
    if (out.length >= maxCodePoints) break;
  }
  return out.join('');
}

function normalizeEdgeInput(
  item: AnchorEdgeWireInput,
  nowMs: number,
): { record: AnchorEdgeRecord; targetRectJson: string | null } {
  const sourceKind = item.sourceKind.trim();
  const sourceResourceId = item.sourceResourceId.trim();
  if (sourceKind === '' || sourceResourceId === '') {
    throw validationError('sourceKind 与 sourceResourceId 不能为空');
  }
  const sourceSubId = (item.sourceSubId ?? '').trim();
  const rawSourceUri = (item.sourceAnchorUri ?? '').trim();
  const sourceAnchorUri = rawSourceUri !== ''
    ? rawSourceUri
    : item.sourceAnchor
      ? serializeAnchorObject(item.sourceAnchor)
      : `ds-anchor://v1/${sourceKind}/${encodeURIComponent(sourceResourceId)}`;
  const sourceLabel = stripControlAndTruncate(item.sourceLabel ?? '', 120);

  const rawTargetKind = (item.targetKind ?? '').trim();
  const targetKind = rawTargetKind !== ''
    ? rawTargetKind
    : (item.targetAnchor?.kind ?? '').trim();
  if (targetKind === '') {
    throw validationError('targetKind 不能为空');
  }

  const rawTargetResourceId = (item.targetResourceId ?? '').trim();
  const targetResourceId = rawTargetResourceId !== ''
    ? rawTargetResourceId
    : (item.targetAnchor?.resourceId ?? '').trim();
  if (targetResourceId === '') {
    throw validationError('targetResourceId 不能为空');
  }

  const targetPage = item.targetPage !== null && item.targetPage !== undefined
    ? Math.trunc(item.targetPage)
    : item.targetAnchor?.page !== null && item.targetAnchor?.page !== undefined
      ? Math.trunc(item.targetAnchor.page)
      : null;
  const targetStartMs = item.targetStartMs !== null && item.targetStartMs !== undefined
    ? Math.trunc(item.targetStartMs)
    : item.targetAnchor?.startMs !== null && item.targetAnchor?.startMs !== undefined
      ? Math.trunc(item.targetAnchor.startMs)
      : null;
  const targetEndMs = item.targetEndMs !== null && item.targetEndMs !== undefined
    ? Math.trunc(item.targetEndMs)
    : item.targetAnchor?.endMs !== null && item.targetAnchor?.endMs !== undefined
      ? Math.trunc(item.targetAnchor.endMs)
      : null;
  const targetRect = item.targetRect
    ?? item.targetAnchor?.rect
    ?? parseRectJson(item.targetRectJson)
    ?? null;
  const targetRectJson = targetRect !== null
    ? JSON.stringify({ x: targetRect.x, y: targetRect.y, w: targetRect.w, h: targetRect.h })
    : (item.targetRectJson && item.targetRectJson.trim() !== '' ? item.targetRectJson.trim() : null);

  const rawLocatorKey = (item.targetLocatorKey ?? '').trim();
  const targetLocatorKey = rawLocatorKey !== ''
    ? rawLocatorKey
    : deriveLocatorKey(targetKind, targetPage, targetStartMs, item.targetAnchor);

  const rawTargetUri = (item.targetAnchorUri ?? '').trim();
  const targetAnchorUri = rawTargetUri !== ''
    ? rawTargetUri
    : item.targetAnchor
      ? serializeAnchorObject(item.targetAnchor)
      : '';
  if (targetAnchorUri === '') {
    throw validationError('targetAnchorUri 不能为空');
  }

  const rawEdgeId = (item.edgeId ?? '').trim();
  const edgeId = rawEdgeId !== ''
    ? rawEdgeId
    : `edge_${fnv1a64Hex(`${sourceKind}:${sourceResourceId}:${sourceSubId}:${targetAnchorUri}`)}`;

  const rawSpaceId = (item.studySpaceId ?? '').trim();
  const studySpaceId = rawSpaceId !== '' ? rawSpaceId : null;
  const createdAt = item.createdAt !== null && item.createdAt !== undefined
    ? Math.trunc(item.createdAt)
    : nowMs;
  const updatedAt = item.updatedAt !== null && item.updatedAt !== undefined
    ? Math.trunc(item.updatedAt)
    : nowMs;

  return {
    record: {
      edgeId,
      sourceKind,
      sourceResourceId,
      sourceSubId,
      sourceAnchorUri,
      sourceLabel,
      targetKind,
      targetResourceId,
      targetLocatorKey,
      targetPage,
      targetStartMs,
      targetEndMs,
      targetRect,
      targetAnchorUri,
      studySpaceId,
      createdAt,
      updatedAt,
    },
    targetRectJson,
  };
}

function rowToAnchorEdge(row: Row): AnchorEdgeRecord {
  return {
    edgeId: asString(row['edge_id']),
    sourceKind: asString(row['source_kind']),
    sourceResourceId: asString(row['source_resource_id']),
    sourceSubId: asString(row['source_sub_id']),
    sourceAnchorUri: asString(row['source_anchor_uri']),
    sourceLabel: asString(row['source_label']),
    targetKind: asString(row['target_kind']),
    targetResourceId: asString(row['target_resource_id']),
    targetLocatorKey: asString(row['target_locator_key']),
    targetPage: asNullableInt(row['target_page']),
    targetStartMs: asNullableInt(row['target_start_ms']),
    targetEndMs: asNullableInt(row['target_end_ms']),
    targetRect: parseRectJson(asNullableString(row['target_rect_json'])),
    targetAnchorUri: asString(row['target_anchor_uri']),
    studySpaceId: asNullableString(row['study_space_id']),
    createdAt: asInt(row['created_at'], 0),
    updatedAt: asInt(row['updated_at'], 0),
  };
}

function isMissingTableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\bno such table\b/i.test(msg);
}

function expandFolderTreeIds(conn: SqlExecutor, seedFolderIds: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const raw of seedFolderIds) {
    const id = raw.trim();
    if (id !== '') expanded.add(id);
  }
  if (expanded.size === 0) return [];
  try {
    const seeds = [...expanded];
    const placeholders = seeds.map((_, idx) => `?${idx + 1}`).join(', ');
    const rows = conn.all<Row>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM folders WHERE id IN (${placeholders}) AND deleted_at IS NULL
         UNION
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
       ) SELECT id FROM tree`,
      seeds,
    );
    expanded.clear();
    for (const row of rows) {
      const id = asString(row['id']).trim();
      if (id !== '') expanded.add(id);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
  return [...expanded];
}

function resolveEntityResourceIds(conn: SqlExecutor, itemType: string, itemId: string): string[] {
  const out = new Set<string>();
  const table = ({ note: 'notes', file: 'files', image: 'files', exam: 'exam_sheets',
    translation: 'translations', essay: 'essays', mindmap: 'mindmaps' } as Record<string, string>)[itemType];
  if (table) {
    try {
      if (conn.get(`SELECT id FROM ${table} WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NOT NULL`, [itemId])) return [];
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }
  try {
    const directRows = conn.all<Row>(
      `SELECT id FROM resources
       WHERE deleted_at IS NULL AND (id = ?1 OR source_id = ?1)`,
      [itemId],
    );
    for (const row of directRows) {
      const id = asString(row['id']).trim();
      if (id !== '') out.add(id);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  let entityQuery: string | null = null;
  switch (itemType) {
    case 'note':
      entityQuery = `SELECT n.resource_id AS id FROM notes n
        LEFT JOIN resources r ON r.id = n.resource_id
        WHERE n.id = ?1 AND n.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`;
      break;
    case 'file':
    case 'image':
      entityQuery = `SELECT f.resource_id AS id FROM files f
        LEFT JOIN resources r ON r.id = f.resource_id
        WHERE f.id = ?1 AND f.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`;
      break;
    case 'exam':
      entityQuery = `SELECT e.resource_id AS id FROM exam_sheets e
        LEFT JOIN resources r ON r.id = e.resource_id
        WHERE e.id = ?1 AND e.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`;
      break;
    case 'translation':
      entityQuery = `SELECT t.resource_id AS id FROM translations t
        LEFT JOIN resources r ON r.id = t.resource_id
        WHERE t.id = ?1 AND t.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`;
      break;
    case 'essay':
      entityQuery = `SELECT e.resource_id AS id FROM essays e
        LEFT JOIN resources r ON r.id = e.resource_id
        WHERE e.id = ?1 AND e.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`;
      break;
    case 'mindmap':
      entityQuery = `SELECT m.resource_id AS id FROM mindmaps m
        LEFT JOIN resources r ON r.id = m.resource_id
        WHERE m.id = ?1 AND m.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`;
      break;
    default:
      break;
  }

  if (entityQuery !== null) {
    try {
      const row = conn.get<Row>(entityQuery, [itemId]);
      const resId = row === undefined ? null : asNullableString(row['id']);
      if (resId !== null && resId.trim() !== '') {
        out.add(resId.trim());
      }
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }
  return [...out];
}

export class StudySpaceRepo implements StudySpaceRepository {
  ensureInboxFolder(conn: SqlExecutor): VfsFolder {
    return databaseResult(() => {
      const nowMs = Date.now();
      conn.run(
        `INSERT INTO folders (
           id, parent_id, title, sort_order, is_expanded, is_favorite,
           created_at, updated_at, local_version, deleted_at
         ) VALUES (
           'fld_inbox', NULL, 'Inbox', -1000, 1, 0,
           ?1, ?1, 1, NULL
         )
         ON CONFLICT(id) DO UPDATE SET
           deleted_at = NULL,
           parent_id = NULL,
           sort_order = -1000,
            updated_at = ?1,
            local_version = COALESCE(folders.local_version, 0) + 1
          WHERE folders.deleted_at IS NOT NULL OR folders.parent_id IS NOT NULL OR folders.sort_order <> -1000`,
        [nowMs],
      );
      const row = conn.get<Row>(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = 'fld_inbox'`);
      if (row === undefined) {
        throw new VfsRepositoryError('VFS_STORAGE', 'Failed to provision fld_inbox folder');
      }
      return rowToFolder(row);
    });
  }

  getProfile(conn: SqlExecutor, spaceId: string, includeDeleted = false): StudySpaceProfile | null {
    return databaseResult(() => {
      const trimmed = spaceId.trim();
      if (trimmed === '') return null;
      const row = conn.get<Row>(
        `SELECT ${PROFILE_COLUMNS} FROM vfs_study_space_profiles
         WHERE space_id = ?1${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        [trimmed],
      );
      return row === undefined ? null : rowToProfile(row);
    });
  }

  listProfiles(conn: SqlExecutor): StudySpaceProfile[] {
    return databaseResult(() =>
      conn
        .all<Row>(
          `SELECT ${PROFILE_COLUMNS} FROM vfs_study_space_profiles
           WHERE deleted_at IS NULL
           ORDER BY updated_at DESC`,
        )
        .map(rowToProfile),
    );
  }

  upsertProfile(conn: SqlExecutor, input: UpsertStudySpaceProfileInput): StudySpaceProfile {
    const previous = this.getProfile(conn, input.spaceId, true);
    input = { ...previous, ...input };
    const spaceId = input.spaceId.trim();
    const rootFolderId = input.rootFolderId.trim();
    if (spaceId === '' || rootFolderId === '') {
      throw validationError('spaceId 与 rootFolderId 不能为空');
    }
    const budget = input.dailyBudgetMinutes ?? 45;
    if (!Number.isInteger(budget) || budget < 5 || budget > 480) {
      throw validationError('dailyBudgetMinutes 必须在 5..480 之间');
    }
    const retention = input.targetRetention ?? 0.9;
    if (!Number.isFinite(retention) || retention < 0.7 || retention > 0.97) {
      throw validationError('targetRetention 必须在 0.70..0.97 之间');
    }
    const preset = input.workbenchLayoutPreset ?? 'split_reader_chat';
    if (!ALLOWED_LAYOUT_PRESETS.has(preset)) {
      throw validationError(`非法 workbenchLayoutPreset: ${preset}`);
    }
    const memoryScope = input.memoryScope ?? 'space_and_global';
    if (!ALLOWED_MEMORY_SCOPES.has(memoryScope)) {
      throw validationError(`非法 memoryScope: ${memoryScope}`);
    }
    const examDate = input.examDate !== null && input.examDate !== undefined && input.examDate.trim() !== ''
      ? input.examDate.trim()
      : null;
    const defaultDeckId = input.defaultDeckId !== null && input.defaultDeckId !== undefined && input.defaultDeckId.trim() !== ''
      ? input.defaultDeckId.trim()
      : null;

    return databaseResult(() => withSavepoint(conn, 'vfs_study_space_upsert_tx', () => {
      if (rootFolderId === 'fld_inbox') throw validationError('收件箱不能用作学习空间根目录');
      if (!conn.get('SELECT id FROM folders WHERE id = ?1 AND deleted_at IS NULL', [rootFolderId])) {
        throw folderNotFound(rootFolderId);
      }
      if (previous && previous.rootFolderId !== rootFolderId) {
        conn.run(`UPDATE vfs_space_mounts SET target_folder_id = ?3,
          updated_at = datetime('now'), local_version = local_version + 1
          WHERE space_id = ?1 AND target_folder_id = ?2 AND deleted_at IS NULL`,
        [spaceId, previous.rootFolderId, rootFolderId]);
      }
      conn.run(
        `INSERT INTO vfs_study_space_profiles (
           space_id, root_folder_id, exam_date, daily_budget_minutes, target_retention,
           workbench_layout_preset, default_deck_id, memory_scope,
           local_version, created_at, updated_at, deleted_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
           1, datetime('now'), datetime('now'), NULL
         )
         ON CONFLICT(space_id) DO UPDATE SET
           root_folder_id = excluded.root_folder_id,
           exam_date = excluded.exam_date,
           daily_budget_minutes = excluded.daily_budget_minutes,
           target_retention = excluded.target_retention,
           workbench_layout_preset = excluded.workbench_layout_preset,
           default_deck_id = excluded.default_deck_id,
           memory_scope = excluded.memory_scope,
           local_version = vfs_study_space_profiles.local_version + 1,
           updated_at = datetime('now'),
           deleted_at = NULL`,
        [
          spaceId,
          rootFolderId,
          examDate,
          budget,
          retention,
          preset,
          defaultDeckId,
          memoryScope,
        ],
      );
      const profile = this.getProfile(conn, spaceId);
      if (profile === null) {
        throw new VfsRepositoryError('VFS_STORAGE', 'INTERNAL_ERROR: upserted profile not found');
      }
      return profile;
    }));
  }

  deleteProfile(conn: SqlExecutor, spaceId: string): boolean {
    const trimmed = spaceId.trim();
    if (trimmed === '') return false;
    return databaseResult(() =>
      withSavepoint(conn, 'vfs_study_space_delete_tx', () => {
        const profileChanges = conn.run(
          `UPDATE vfs_study_space_profiles
           SET deleted_at = datetime('now'),
               updated_at = datetime('now'),
               local_version = local_version + 1
           WHERE space_id = ?1 AND deleted_at IS NULL`,
          [trimmed],
        ).changes;
        conn.run(
          `UPDATE vfs_space_mounts
           SET deleted_at = datetime('now'),
               updated_at = datetime('now'),
               local_version = local_version + 1
           WHERE space_id = ?1 AND deleted_at IS NULL`,
          [trimmed],
        );
        return profileChanges > 0;
      }),
    );
  }

  archiveProfile(conn: SqlExecutor, spaceId: string): void {
    databaseResult(() => conn.run(`UPDATE vfs_study_space_profiles
      SET deleted_at = datetime('now'), updated_at = datetime('now'), local_version = local_version + 1
      WHERE space_id = ?1 AND deleted_at IS NULL`, [spaceId]));
  }

  listMounts(conn: SqlExecutor, filter: ListSpaceMountsFilter = {}): StudySpaceMount[] {
    return databaseResult(() => {
      let sql = `SELECT ${MOUNT_COLUMNS} FROM vfs_space_mounts WHERE deleted_at IS NULL`;
      const params: SqlValue[] = [];
      const spaceId = (filter.spaceId ?? '').trim();
      if (spaceId !== '') {
        params.push(spaceId);
        sql += ` AND space_id = ?${params.length}`;
      }
      const targetFolderId = (filter.targetFolderId ?? '').trim();
      if (targetFolderId !== '') {
        params.push(targetFolderId);
        sql += ` AND target_folder_id = ?${params.length}`;
      }
      const itemType = (filter.itemType ?? '').trim();
      if (itemType !== '') {
        params.push(itemType);
        sql += ` AND item_type = ?${params.length}`;
      }
      const itemId = (filter.itemId ?? '').trim();
      if (itemId !== '') {
        params.push(itemId);
        sql += ` AND item_id = ?${params.length}`;
      }
      sql += ' ORDER BY created_at ASC';
      return conn.all<Row>(sql, params).map(rowToMount);
    });
  }

  addMount(conn: SqlExecutor, input: CreateSpaceMountInput): StudySpaceMount {
    const spaceId = input.spaceId.trim();
    const targetFolderId = input.targetFolderId.trim();
    const itemType = input.itemType.trim();
    const itemId = input.itemId.trim();

    if (spaceId === '' || targetFolderId === '' || itemId === '') {
      throw validationError('spaceId, targetFolderId 与 itemId 不能为空');
    }
    if (!ALLOWED_MOUNT_ITEM_TYPES.has(itemType)) {
      throw validationError(`不支持的挂载资源类型 ${itemType}`);
    }

    return databaseResult(() => withSavepoint(conn, 'vfs_space_mount_add_tx', () => {
      const targetExists = (conn.pluck<number>(
        'SELECT COUNT(*) FROM folders WHERE id = ?1 AND deleted_at IS NULL',
        [targetFolderId],
      ) ?? 0) > 0;
      if (!targetExists) {
        throw folderNotFound(targetFolderId);
      }

      if (itemType === 'folder') {
        if (itemId === 'fld_inbox') throw validationError('收件箱不能跨空间挂载');
        if (itemId === targetFolderId) {
          throw validationError('不能将文件夹挂载到自身');
        }
        const mountedFolder = conn.get<Row>(
          'SELECT id, parent_id FROM folders WHERE id = ?1 AND deleted_at IS NULL',
          [itemId],
        );
        if (mountedFolder === undefined) {
          throw folderNotFound(itemId);
        }
        if (asNullableString(mountedFolder['parent_id']) === targetFolderId) {
          throw validationError('资源已位于目标文件夹中，无需重复挂载');
        }
        const descendantRows = conn.all<Row>(
          `WITH RECURSIVE links(parent_id, id) AS (
             SELECT parent_id, id FROM folders WHERE deleted_at IS NULL
             UNION
             SELECT target_folder_id, item_id FROM vfs_space_mounts
             WHERE item_type = 'folder' AND deleted_at IS NULL
           ), descendants(id) AS (
             SELECT ?1
             UNION
             SELECT l.id FROM links l JOIN descendants d ON l.parent_id = d.id
           ) SELECT id FROM descendants`,
          [itemId],
        );
        if (descendantRows.some((row) => asString(row['id']) === targetFolderId)) {
          throw validationError('不能将父文件夹挂载到其子文件夹中');
        }
      } else {
        const canonicalRow = conn.get<Row>(
          `SELECT folder_id FROM folder_items
           WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL
           LIMIT 1`,
          [itemType, itemId],
        );
        if (canonicalRow !== undefined && asNullableString(canonicalRow['folder_id']) === targetFolderId) {
          throw validationError('资源已位于目标文件夹中，无需重复挂载');
        }
      }

      const existing = conn.get<Row>(
        `SELECT ${MOUNT_COLUMNS} FROM vfs_space_mounts
         WHERE target_folder_id = ?1 AND item_type = ?2 AND item_id = ?3 AND deleted_at IS NULL
         LIMIT 1`,
        [targetFolderId, itemType, itemId],
      );
      if (existing !== undefined) {
        if (asString(existing['space_id']) !== spaceId) throw validationError('目标挂载已属于其他学习空间');
        return rowToMount(existing);
      }

      const profile = this.getProfile(conn, spaceId);
      if (profile && !expandFolderTreeIds(conn, [profile.rootFolderId]).includes(targetFolderId)) {
        throw validationError('挂载目标必须位于学习空间根目录中');
      }
      if (itemType === 'folder') {
        const canonical = expandFolderTreeIds(conn, [targetFolderId]);
        const mountedFolders = this.listMounts(conn, { spaceId, itemType: 'folder' });
        if (canonical.includes(itemId) || mountedFolders.some(mount =>
          expandFolderTreeIds(conn, [mount.itemId]).includes(itemId)
          || expandFolderTreeIds(conn, [itemId]).includes(mount.itemId))) {
          throw validationError('文件夹与当前空间已有目录或挂载重叠');
        }
      }

      const softRow = conn.get<Row>(
        `SELECT id FROM vfs_space_mounts
         WHERE target_folder_id = ?1 AND item_type = ?2 AND item_id = ?3 AND deleted_at IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
        [targetFolderId, itemType, itemId],
      );
      if (softRow !== undefined) {
        const softId = asString(softRow['id']);
        conn.run(
          `UPDATE vfs_space_mounts
           SET space_id = ?2,
               deleted_at = NULL,
               updated_at = datetime('now'),
               local_version = local_version + 1
           WHERE id = ?1`,
          [softId, spaceId],
        );
        const revived = conn.get<Row>(
          `SELECT ${MOUNT_COLUMNS} FROM vfs_space_mounts WHERE id = ?1`,
          [softId],
        );
        if (revived === undefined) {
          throw new VfsRepositoryError('VFS_STORAGE', 'INTERNAL_ERROR: revived mount not found');
        }
        return rowToMount(revived);
      }

      const newId = `mnt_${globalThis.crypto.randomUUID()}`;
      conn.run(
        `INSERT INTO vfs_space_mounts (
           id, space_id, target_folder_id, item_type, item_id,
           local_version, created_at, updated_at, deleted_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5,
           1, datetime('now'), datetime('now'), NULL
         )`,
        [newId, spaceId, targetFolderId, itemType, itemId],
      );
      const inserted = conn.get<Row>(
        `SELECT ${MOUNT_COLUMNS} FROM vfs_space_mounts WHERE id = ?1`,
        [newId],
      );
      if (inserted === undefined) {
        throw new VfsRepositoryError('VFS_STORAGE', 'INTERNAL_ERROR: inserted mount not found');
      }
      return rowToMount(inserted);
    }));
  }

  removeMount(conn: SqlExecutor, input: RemoveSpaceMountInput): boolean {
    const mountId = (input.mountId ?? '').trim();
    const targetFolderId = (input.targetFolderId ?? '').trim();
    const itemType = (input.itemType ?? '').trim();
    const itemId = (input.itemId ?? '').trim();

    if (mountId !== '') {
      return databaseResult(() =>
        conn.run(
          `UPDATE vfs_space_mounts
           SET deleted_at = datetime('now'),
               updated_at = datetime('now'),
               local_version = local_version + 1
           WHERE id = ?1 AND deleted_at IS NULL`,
          [mountId],
        ).changes > 0,
      );
    }

    if (targetFolderId !== '' && itemType !== '' && itemId !== '') {
      return databaseResult(() =>
        conn.run(
          `UPDATE vfs_space_mounts
           SET deleted_at = datetime('now'),
               updated_at = datetime('now'),
               local_version = local_version + 1
           WHERE target_folder_id = ?1 AND item_type = ?2 AND item_id = ?3 AND deleted_at IS NULL`,
          [targetFolderId, itemType, itemId],
        ).changes > 0,
      );
    }

    throw validationError('必须提供 mountId 或 (targetFolderId, itemType, itemId)');
  }

  resolveMountScopeForFolders(conn: SqlExecutor, folderIds: readonly string[]): ResolvedMountScope {
    const canonicalFolderIds = expandFolderTreeIds(conn, folderIds);
    if (canonicalFolderIds.length === 0) {
      return {
        effectiveFolderIds: [],
        mountedResourceIds: [],
        mountedItemKeys: new Set<string>(),
      };
    }

    const effectiveFolderSet = new Set<string>(canonicalFolderIds);
    const mountedResourceSet = new Set<string>();
    const mountedItemKeys = new Set<string>();

    let pendingFolders = canonicalFolderIds;
    while (pendingFolders.length > 0) {
      let mounts: StudySpaceMount[] = [];
      try {
        const placeholders = pendingFolders.map((_, idx) => `?${idx + 1}`).join(', ');
        mounts = conn
          .all<Row>(
            `SELECT ${MOUNT_COLUMNS} FROM vfs_space_mounts
             WHERE target_folder_id IN (${placeholders}) AND deleted_at IS NULL
             ORDER BY created_at ASC`,
            pendingFolders,
          )
          .map(rowToMount);
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
      }

      pendingFolders = [];
      for (const mount of mounts) {
        if (mount.itemType === 'folder') {
          const folderIds = expandFolderTreeIds(conn, [mount.itemId]);
          if (folderIds.length === 0) continue;
          mountedItemKeys.add(`${mount.itemType}:${mount.itemId}`);
          for (const fid of folderIds) {
            if (!effectiveFolderSet.has(fid)) pendingFolders.push(fid);
            effectiveFolderSet.add(fid);
          }
        } else {
          const resourceIds = resolveEntityResourceIds(conn, mount.itemType, mount.itemId);
          if (resourceIds.length === 0) continue;
          mountedItemKeys.add(`${mount.itemType}:${mount.itemId}`);
          for (const resId of resourceIds) mountedResourceSet.add(resId);
        }
      }
    }

    return {
      effectiveFolderIds: [...effectiveFolderSet],
      mountedResourceIds: [...mountedResourceSet],
      mountedItemKeys,
    };
  }

  upsertAnchorEdges(conn: SqlExecutor, edges: readonly AnchorEdgeWireInput[]): AnchorEdgesUpsertResult {
    if (edges.length === 0) {
      return { upserted: 0 };
    }
    const nowMs = Date.now();
    const normalized = edges.map((edge) => normalizeEdgeInput(edge, nowMs));

    return databaseResult(() =>
      withSavepoint(conn, 'vfs_anchor_edges_upsert_tx', () => {
        let upserted = 0;
        for (const { record, targetRectJson } of normalized) {
          conn.run(
            `INSERT INTO vfs_anchor_edges (
               edge_id, source_kind, source_resource_id, source_sub_id,
               source_anchor_uri, source_label, target_kind, target_resource_id,
               target_locator_key, target_page, target_start_ms, target_end_ms,
               target_rect_json, target_anchor_uri, study_space_id,
               created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4,
               ?5, ?6, ?7, ?8,
               ?9, ?10, ?11, ?12,
               ?13, ?14, ?15,
               ?16, ?17
             )
             ON CONFLICT(edge_id) DO UPDATE SET
               source_kind = excluded.source_kind,
               source_resource_id = excluded.source_resource_id,
               source_sub_id = excluded.source_sub_id,
               source_anchor_uri = excluded.source_anchor_uri,
               source_label = excluded.source_label,
               target_kind = excluded.target_kind,
               target_resource_id = excluded.target_resource_id,
               target_locator_key = excluded.target_locator_key,
               target_page = excluded.target_page,
               target_start_ms = excluded.target_start_ms,
               target_end_ms = excluded.target_end_ms,
               target_rect_json = excluded.target_rect_json,
               target_anchor_uri = excluded.target_anchor_uri,
               study_space_id = excluded.study_space_id,
               updated_at = excluded.updated_at`,
            [
              record.edgeId,
              record.sourceKind,
              record.sourceResourceId,
              record.sourceSubId,
              record.sourceAnchorUri,
              record.sourceLabel,
              record.targetKind,
              record.targetResourceId,
              record.targetLocatorKey,
              record.targetPage,
              record.targetStartMs,
              record.targetEndMs,
              targetRectJson,
              record.targetAnchorUri,
              record.studySpaceId,
              record.createdAt,
              record.updatedAt,
            ],
          );
          upserted += 1;
        }
        return { upserted };
      }),
    );
  }

  deleteAnchorEdgesBySource(
    conn: SqlExecutor,
    sourceKind: string,
    sourceResourceId: string,
    keepEdgeIds?: readonly string[] | null,
  ): AnchorEdgesDeleteResult {
    const sk = sourceKind.trim();
    const srid = sourceResourceId.trim();
    if (sk === '' || srid === '') {
      return { deleted: 0 };
    }
    const keep = (keepEdgeIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id !== '');

    return databaseResult(() => {
      if (keep.length === 0) {
        const deleted = conn.run(
          'DELETE FROM vfs_anchor_edges WHERE source_kind = ?1 AND source_resource_id = ?2',
          [sk, srid],
        ).changes;
        return { deleted };
      }
      const placeholders = keep.map((_, idx) => `?${idx + 3}`).join(', ');
      const deleted = conn.run(
        `DELETE FROM vfs_anchor_edges
         WHERE source_kind = ?1 AND source_resource_id = ?2
           AND edge_id NOT IN (${placeholders})`,
        [sk, srid, ...keep],
      ).changes;
      return { deleted };
    });
  }

  queryAnchorEdgesByTarget(
    conn: SqlExecutor,
    targetResourceIds: readonly string[],
    targetKind?: string | null,
  ): AnchorEdgeRecord[] {
    const ids = targetResourceIds
      .map((id) => id.trim())
      .filter((id) => id !== '');
    if (ids.length === 0) return [];
    const tk = (targetKind ?? '').trim();

    return databaseResult(() => {
      const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(', ');
      const params: SqlValue[] = [...ids];
      let sql = `SELECT ${EDGE_COLUMNS} FROM vfs_anchor_edges
                 WHERE target_resource_id IN (${placeholders})`;
      if (tk !== '') {
        params.push(tk);
        sql += ` AND target_kind = ?${params.length}`;
      }
      sql += ' ORDER BY created_at ASC';
      return conn.all<Row>(sql, params).map(rowToAnchorEdge);
    });
  }
}
