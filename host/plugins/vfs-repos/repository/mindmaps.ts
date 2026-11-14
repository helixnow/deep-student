/** Port of dstu-vfs mindmap_repo.rs. All DB functions take the caller's connection. */
import { logDebug, logError, logInfo, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type JsonValue,
  type MindmapRepository,
  type VfsCreateMindMapParams,
  type VfsFolderItem,
  type VfsMindMap,
  type VfsMindMapVersion,
  type VfsUpdateMindMapParams,
} from '../api.ts';
import { databaseResult, rollbackIgnoringFailure } from './errors.ts';
import { FolderRepo } from './folders.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { IndexStateRepo } from './embedding-repo.ts';
import { ResourceRepo } from './resources.ts';
import { utcTimestamp, utcTimestampFromMillis } from './timestamps.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';

const MAX_MINDMAP_DEPTH = 100;
const MAX_MINDMAP_NODES = 10_000;
const AUTOSAVE_MERGE_WINDOW_MINUTES = 30;
const MAX_AUTOSAVE_VERSIONS = 20;
const DEFAULT_VERSION_PAGE_SIZE = 100;
const DEFAULT_MINDMAP_CONTENT = '{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}';

const MINDMAP_COLUMNS = `id, resource_id, title, description, is_favorite, default_view, theme,
  settings, created_at, updated_at, deleted_at, COALESCE(content_updated_at, updated_at) AS content_updated_at`;
const MINDMAP_COLUMNS_ALIASED = `m.id, m.resource_id, m.title, m.description, m.is_favorite,
  m.default_view, m.theme, m.settings, m.created_at, m.updated_at, m.deleted_at,
  COALESCE(m.content_updated_at, m.updated_at) AS content_updated_at`;
const VERSION_COLUMNS = 'version_id, mindmap_id, resource_id, title, label, source, created_at';

let versionSnapshotConsecutiveFailures = 0;


function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function invalidOperation(operation: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_OPERATION', `INVALID_OPERATION: ${operation} - ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalText(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function optionalNumber(value: SqlValue | undefined): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : null;
}
function textOr(value: SqlValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
function numberOr(value: SqlValue | undefined, fallback: number): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : fallback;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSettings(mindmapId: string, raw: string | null): JsonValue | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    logWarn(
      `[VFS::MindMapRepo] Invalid settings JSON for mindmap ${mindmapId} (ignored):`, error);
    return undefined;
  }
}

/**
 * Strictly later than `current` at millisecond precision (same as
 * note_repo::next_updated_at). Falls back to the current time when parsing fails.
 */
function nextTimestampAfter(current: string): string {
  const now = Date.now();
  const parsed = parseRfc3339(current)?.millis ?? null;
  if (parsed === null) return utcTimestampFromMillis(now);
  const minimum = parsed + 1;
  return utcTimestampFromMillis(now > minimum ? now : minimum);
}

function rowToMindmap(row: Row): VfsMindMap {
  const id = String(row.id);
  const description = optionalText(row.description);
  const theme = optionalText(row.theme);
  const settings = parseSettings(id, optionalText(row.settings));
  const deletedAt = optionalText(row.deleted_at);
  return {
    id,
    resourceId: String(row.resource_id),
    title: String(row.title),
    ...(description === null ? {} : { description }),
    isFavorite: numberOr(row.is_favorite, 0) !== 0,
    defaultView: textOr(row.default_view, 'mindmap'),
    ...(theme === null ? {} : { theme }),
    ...(settings === undefined ? {} : { settings }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    contentUpdatedAt: String(row.content_updated_at),
    ...(deletedAt === null ? {} : { deletedAt }),
  };
}

function rowToDeletedMindmap(row: Row): VfsMindMap {
  const id = String(row.id);
  const description = optionalText(row.description);
  const theme = optionalText(row.theme);
  const settings = parseSettings(id, optionalText(row.settings));
  const deletedAt = optionalText(row.deleted_at);
  return {
    id,
    resourceId: optionalText(row.resource_id) ?? '',
    title: String(row.title),
    ...(description === null ? {} : { description }),
    isFavorite: numberOr(row.is_favorite, 0) !== 0,
    defaultView: optionalText(row.default_view) ?? 'mindmap',
    ...(theme === null ? {} : { theme }),
    ...(settings === undefined ? {} : { settings }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    contentUpdatedAt: String(row.content_updated_at),
    ...(deletedAt === null ? {} : { deletedAt }),
  };
}

function rowToVersion(row: Row): VfsMindMapVersion {
  const label = optionalText(row.label);
  const source = optionalText(row.source);
  return {
    versionId: String(row.version_id),
    mindmapId: String(row.mindmap_id),
    resourceId: String(row.resource_id),
    title: String(row.title),
    ...(label === null ? {} : { label }),
    ...(source === null ? {} : { source }),
    createdAt: String(row.created_at),
  };
}

function valueToString(value: JsonValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

export class MindmapRepo implements MindmapRepository {
  private readonly folders = new FolderRepo();
  private readonly resources = new ResourceRepo();
  private readonly indexStates = new IndexStateRepo();

  normalizeContent(content: string): string {
    let doc: JsonValue;
    try {
      doc = JSON.parse(content) as JsonValue;
    } catch (error) {
      throw invalidArgument('content', `Invalid JSON: ${errorMessage(error)}`);
    }

    if (!isJsonObject(doc)) {
      throw invalidArgument('content', 'MindMapDocument must be a JSON object');
    }

    // Compatibility: LLMs may pass a bare root node (no version/meta/root).
    const isNodeLike = !Object.prototype.hasOwnProperty.call(doc, 'root')
      && (Object.prototype.hasOwnProperty.call(doc, 'text')
        || Object.prototype.hasOwnProperty.call(doc, 'children'));
    if (isNodeLike) {
      doc = { version: '1.0', root: doc, meta: { createdAt: '' } };
    }

    const versionValid = typeof doc.version === 'string' && doc.version.trim() !== '';
    if (!versionValid) doc.version = '1.0';

    if (!isJsonObject(doc.meta)) doc.meta = {};
    const meta = doc.meta;
    const createdAtValid = typeof meta.createdAt === 'string' && meta.createdAt.trim() !== '';
    if (!createdAtValid) meta.createdAt = utcTimestamp();

    if (!Object.prototype.hasOwnProperty.call(doc, 'root')) {
      doc.root = { id: 'root', text: '根节点', children: [] };
    }
    if (!Object.prototype.hasOwnProperty.call(doc, 'root')) {
      throw invalidArgument('content', 'Missing root node');
    }

    let nodeCount = 0;
    const seenIds = new Set<string>();
    this.normalizeNode(doc.root, 0, { count: nodeCount }, seenIds);
    return JSON.stringify(doc);
  }

  private normalizeNode(node: JsonValue | undefined, depth: number,
    counter: { count: number }, seenIds: Set<string>): void {
    if (depth > MAX_MINDMAP_DEPTH) {
      throw invalidArgument('content', `Mindmap depth exceeds limit (${MAX_MINDMAP_DEPTH})`);
    }
    if (!isJsonObject(node)) {
      throw invalidArgument('content', 'Mindmap node must be an object');
    }

    counter.count += 1;
    if (counter.count > MAX_MINDMAP_NODES) {
      throw invalidArgument('content', `Mindmap node count exceeds limit (${MAX_MINDMAP_NODES})`);
    }

    const rawId = typeof node.id === 'string' ? node.id.trim() : '';
    let uniqueId: string;
    if (rawId !== '' && !seenIds.has(rawId)) {
      uniqueId = rawId;
    } else if (rawId !== '') {
      uniqueId = nanoid(10);
      while (seenIds.has(uniqueId)) uniqueId = nanoid(10);
      logWarn(
        `[VFS::MindMapRepo] Duplicate node id ${JSON.stringify(rawId)} detected (depth=${depth}), regenerated as ${JSON.stringify(uniqueId)}`);
    } else if (depth === 0 && !seenIds.has('root')) {
      uniqueId = 'root';
    } else {
      uniqueId = nanoid(10);
      while (seenIds.has(uniqueId)) uniqueId = nanoid(10);
    }
    seenIds.add(uniqueId);
    node.id = uniqueId;

    const textAlreadyValid = typeof node.text === 'string' && node.text.trim() !== '';
    if (!textAlreadyValid) {
      let textValue = node.text === undefined ? null : valueToString(node.text);
      if (textValue === null || textValue.trim() === '') {
        const fallbackKeys = ['name', 'label', 'title', 'value', 'content'] as const;
        let fallback: string | null = null;
        for (const key of fallbackKeys) {
          if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
          fallback = valueToString(node[key]!);
          if (fallback !== null) break;
        }
        textValue = fallback ?? '未命名';
      }
      node.text = textValue;
    }

    if (Object.prototype.hasOwnProperty.call(node, 'note') && typeof node.note !== 'string') {
      node.note = '';
    }

    if (!Array.isArray(node.children)) node.children = [];
    for (const child of node.children) {
      this.normalizeNode(child, depth + 1, counter, seenIds);
    }
  }

  createMindmap(conn: SqlExecutor, params: VfsCreateMindMapParams): VfsMindMap {
    return databaseResult(() => this.createMindmapWithConn(conn, params));
  }

  createMindmapWithConn(conn: SqlExecutor, params: VfsCreateMindMapParams): VfsMindMap {
    return databaseResult(() => {
      conn.exec('SAVEPOINT vfs_mindmap_create_tx');
      let mindmap: VfsMindMap;
      try {
        mindmap = this.createMindmapInner(conn, params);
      } catch (error) {
        this.rollbackToSavepoint(conn, 'vfs_mindmap_create_tx');
        throw error;
      }
      try {
        conn.exec('RELEASE SAVEPOINT vfs_mindmap_create_tx');
      } catch (error) {
        this.rollbackToSavepoint(conn, 'vfs_mindmap_create_tx');
        throw error;
      }
      return mindmap;
    });
  }

  private createMindmapInner(conn: SqlExecutor, params: VfsCreateMindMapParams): VfsMindMap {
    let finalTitle: string;
    if (params.title.trim() === '') {
      logWarn('[VFS::MindMapRepo] create_mindmap: 标题为空，使用默认标题');
      finalTitle = '无标题导图';
    } else {
      finalTitle = params.title;
    }

    const mindmapId = `mm_${nanoid(10)}`;
    const now = utcTimestamp();
    const description = params.description ?? null;
    const defaultView = params.defaultView ?? 'mindmap';
    const theme = params.theme ?? null;

    const normalizedContent = this.normalizeContent(params.content ?? DEFAULT_MINDMAP_CONTENT);
    const resource = this.resources.createOrReuse(
      conn, 'mindmap', normalizedContent, mindmapId, 'mindmaps', null);

    conn.run(`INSERT INTO mindmaps
        (id, resource_id, title, description, is_favorite, default_view, theme, settings,
         created_at, updated_at, content_updated_at)
      VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, NULL, ?7, ?8, ?9)`,
    [mindmapId, resource.resourceId, finalTitle, description, defaultView, theme, now, now, now]);

    logInfo(`[VFS::MindMapRepo] Created mindmap: ${mindmapId} (resource: ${resource.resourceId})`);

    return {
      id: mindmapId,
      resourceId: resource.resourceId,
      title: finalTitle,
      ...(description === null ? {} : { description }),
      isFavorite: false,
      defaultView,
      ...(theme === null ? {} : { theme }),
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt: now,
    };
  }

  createMindmapInFolder(conn: SqlExecutor, params: VfsCreateMindMapParams,
    folderId: string | null): VfsMindMap {
    return databaseResult(() => this.createMindmapInFolderWithConn(conn, params, folderId));
  }

  createMindmapInFolderWithConn(conn: SqlExecutor, params: VfsCreateMindMapParams,
    folderId: string | null): VfsMindMap {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      let mindmap: VfsMindMap;
      try {
        if (folderId !== null && !this.folders.folderExists(conn, folderId)) {
          throw notFound('Folder', folderId);
        }
        mindmap = this.createMindmapWithConn(conn, params);
        const folderItem: VfsFolderItem = {
          id: `fi_${nanoid(10)}`,
          ...(folderId === null ? {} : { folderId }),
          itemType: 'mindmap',
          itemId: mindmap.id,
          sortOrder: 0,
          createdAt: Date.now(),
        };
        this.folders.addItemToFolder(conn, folderItem);
        // Rust `{:?}` of Option<&str>.
        logDebug(`[VFS::MindMapRepo] Created mindmap ${mindmap.id} in folder `
          + `${folderId === null ? 'None' : `Some(${JSON.stringify(folderId)})`}`);
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      try {
        conn.exec('COMMIT');
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      return mindmap;
    });
  }

  updateMindmap(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams): VfsMindMap {
    return databaseResult(() => this.updateMindmapWithConn(conn, mindmapId, params));
  }

  updateMindmapWithConn(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams): VfsMindMap {
    return databaseResult(() => this.updateMindmapReturningVersionWithConn(
      conn, mindmapId, params, false)[0]);
  }

  updateMindmapReturningVersion(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams, snapshotAfter: boolean):
    [VfsMindMap, VfsMindMapVersion | null] {
    return databaseResult(() => this.updateMindmapReturningVersionWithConn(
      conn, mindmapId, params, snapshotAfter));
  }

  updateMindmapReturningVersionWithConn(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams, snapshotAfter: boolean):
    [VfsMindMap, VfsMindMapVersion | null] {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      let output: [VfsMindMap, VfsMindMapVersion | null];
      try {
        output = this.updateMindmapInner(conn, mindmapId, params, snapshotAfter);
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      try {
        conn.exec('COMMIT');
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      return output;
    });
  }

  private updateMindmapInner(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams, snapshotAfter: boolean):
    [VfsMindMap, VfsMindMapVersion | null] {
    const current = this.getMindmapWithConn(conn, mindmapId);
    if (current === null) throw notFound('MindMap', mindmapId);

    const expectedUpdatedAt = params.expectedUpdatedAt ?? null;
    if (expectedUpdatedAt !== null) {
      const matchesContent = current.contentUpdatedAt === expectedUpdatedAt;
      const matchesMeta = current.updatedAt === expectedUpdatedAt;
      if (!matchesContent && !matchesMeta) {
        throw invalidOperation('mindmap_update_conflict',
          `MINDMAP_UPDATE_CONFLICT: expected_updated_at=${expectedUpdatedAt}, actual_content_updated_at=${current.contentUpdatedAt}, actual_updated_at=${current.updatedAt}`);
      }
    }

    const versionSource = params.versionSource ?? null;
    const isChatSource = versionSource !== null && versionSource.startsWith('chat');

    const occBaseline = current.updatedAt >= current.contentUpdatedAt
      ? current.updatedAt
      : current.contentUpdatedAt;
    const now = nextTimestampAfter(occBaseline);

    let finalResourceId = current.resourceId;
    let finalNormalizedContent: string | null = null;
    let contentChanged = false;

    const newContent = params.content ?? null;
    if (newContent !== null) {
      const normalizedContent = this.normalizeContent(newContent);
      const currentResource = this.resources.getResource(conn, current.resourceId);
      if (currentResource === null) throw notFound('Resource', current.resourceId);
      const newHash = this.resources.computeHash(normalizedContent);
      if (newHash === currentResource.hash) {
        contentChanged = false;
      } else {
        if (currentResource.data !== undefined) {
          const oldData = currentResource.data;
          if (snapshotAfter) {
            this.snapshotOldContentIfUncaptured(
              conn, mindmapId, oldData, currentResource.hash, current.title);
          } else {
            try {
              this.createVersionWithConn(
                conn, mindmapId, oldData, current.title, null, versionSource);
              versionSnapshotConsecutiveFailures = 0;
            } catch (error) {
              if (isChatSource) {
                logError(
                  `[VFS::MindMapRepo] MINDMAP_VERSION_SNAPSHOT_FAILED (chat source, fail-closed): mindmap ${mindmapId}: ${errorMessage(error)}`);
                throw error;
              }
              versionSnapshotConsecutiveFailures += 1;
              if (versionSnapshotConsecutiveFailures >= 3) {
                logError(
                  `[VFS::MindMapRepo] MINDMAP_VERSION_SNAPSHOT_FAILED (consecutive=${versionSnapshotConsecutiveFailures}): mindmap ${mindmapId}: ${errorMessage(error)}`);
              } else {
                logWarn(
                  `[VFS::MindMapRepo] MINDMAP_VERSION_SNAPSHOT_FAILED: mindmap ${mindmapId}: ${errorMessage(error)}`);
              }
            }
          }
        }

        if (this.shouldCopyOnWriteResource(conn, current.resourceId)) {
          const resource = this.resources.createOrReuse(
            conn, 'mindmap', normalizedContent, mindmapId, 'mindmaps', null);
          finalResourceId = resource.resourceId;
          contentChanged = true;
        } else {
          contentChanged = this.resources.updateResourceData(
            conn, current.resourceId, normalizedContent);
        }
      }
      finalNormalizedContent = normalizedContent;
    }

    const finalTitle = params.title ?? current.title;
    const finalDescription = params.description ?? current.description;
    const finalDefaultView = params.defaultView ?? current.defaultView;
    const finalTheme = params.theme ?? current.theme;
    const finalSettings = params.settings !== undefined && params.settings !== null
      ? params.settings
      : current.settings;
    const settingsJson = finalSettings === undefined ? null : JSON.stringify(finalSettings);
    const finalContentUpdatedAt = contentChanged ? now : current.contentUpdatedAt;

    conn.run(`UPDATE mindmaps
        SET resource_id = ?1, title = ?2, description = ?3, default_view = ?4,
            theme = ?5, settings = ?6, updated_at = ?7, content_updated_at = ?8
        WHERE id = ?9`,
    [finalResourceId, finalTitle, finalDescription ?? null, finalDefaultView,
      finalTheme ?? null, settingsJson, now, finalContentUpdatedAt, mindmapId]);

    let afterVersion: VfsMindMapVersion | null = null;
    if (snapshotAfter) {
      let finalContent: string | null = null;
      if (finalNormalizedContent !== null) {
        finalContent = finalNormalizedContent;
      } else {
        const resource = this.resources.getResource(conn, finalResourceId);
        finalContent = resource?.data ?? null;
      }
      if (finalContent !== null) {
        afterVersion = this.createVersionWithConn(
          conn, mindmapId, finalContent, finalTitle, null, versionSource);
      } else {
        logWarn(
          `[VFS::MindMapRepo] snapshot_after requested but resource ${finalResourceId} has no data (mindmap ${mindmapId})`);
      }
    }

    return [{
      id: mindmapId,
      resourceId: finalResourceId,
      title: finalTitle,
      ...(finalDescription === undefined ? {} : { description: finalDescription }),
      isFavorite: current.isFavorite,
      defaultView: finalDefaultView,
      ...(finalTheme === undefined ? {} : { theme: finalTheme }),
      ...(finalSettings === undefined ? {} : { settings: finalSettings }),
      createdAt: current.createdAt,
      updatedAt: now,
      contentUpdatedAt: finalContentUpdatedAt,
      ...(current.deletedAt === undefined ? {} : { deletedAt: current.deletedAt }),
    }, afterVersion];
  }

  private snapshotOldContentIfUncaptured(conn: SqlExecutor, mindmapId: string,
    oldContent: string, oldHash: string, title: string): void {
    const captured = Number(conn.pluck<number>(`
      SELECT COUNT(*)
      FROM mindmap_versions v
      JOIN resources r ON v.resource_id = r.id
      WHERE v.mindmap_id = ?1 AND r.hash = ?2`, [mindmapId, oldHash]) ?? 0);
    if (captured > 0) return;
    this.createVersionWithConn(
      conn, mindmapId, oldContent, title, null, 'pre_chat_backup');
  }

  countActiveMindmapsByResourceId(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => this.countActiveMindmapsByResourceIdWithConn(conn, resourceId));
  }

  countActiveMindmapsByResourceIdWithConn(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1', [resourceId]) ?? 0));
  }

  /** Historical snapshots in mindmap_versions must stay immutable on copy-on-write edits. */
  private shouldCopyOnWriteResource(conn: SqlExecutor, resourceId: string): boolean {
    if (this.countActiveMindmapsByResourceIdWithConn(conn, resourceId) > 1) return true;
    const versionRefs = Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1', [resourceId]) ?? 0);
    return versionRefs > 0;
  }

  getMindmap(conn: SqlExecutor, mindmapId: string): VfsMindMap | null {
    return databaseResult(() => this.getMindmapWithConn(conn, mindmapId));
  }

  getMindmapWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMap | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT ${MINDMAP_COLUMNS} FROM mindmaps WHERE id = ?1 AND deleted_at IS NULL`,
        [mindmapId]);
      return row === undefined ? null : rowToMindmap(row);
    });
  }

  getMindmapContent(conn: SqlExecutor, mindmapId: string): string | null {
    return databaseResult(() => this.getMindmapContentWithConn(conn, mindmapId));
  }

  getMindmapContentWithConn(conn: SqlExecutor, mindmapId: string): string | null {
    return databaseResult(() => {
      const mindmap = this.getMindmapWithConn(conn, mindmapId);
      if (mindmap === null) return null;
      const resource = this.resources.getResource(conn, mindmap.resourceId);
      return resource?.data ?? null;
    });
  }

  listMindmaps(conn: SqlExecutor): VfsMindMap[] {
    return databaseResult(() => this.listMindmapsWithConn(conn));
  }

  listMindmapsWithConn(conn: SqlExecutor): VfsMindMap[] {
    return databaseResult(() => {
      const rows = conn.all<Row>(
        `SELECT ${MINDMAP_COLUMNS} FROM mindmaps
         WHERE deleted_at IS NULL ORDER BY updated_at DESC`);
      return rows.map(rowToMindmap);
    });
  }

  listMindmapsByFolder(conn: SqlExecutor, folderId: string | null,
    limit: number, offset: number): VfsMindMap[] {
    return databaseResult(() => this.listMindmapsByFolderWithConn(conn, folderId, limit, offset));
  }

  listMindmapsByFolderWithConn(conn: SqlExecutor, folderId: string | null,
    limit: number, offset: number): VfsMindMap[] {
    return databaseResult(() => {
      const rows = conn.all<Row>(
        `SELECT ${MINDMAP_COLUMNS_ALIASED}
         FROM mindmaps m
         INNER JOIN folder_items fi ON m.id = fi.item_id AND fi.item_type = 'mindmap'
         WHERE m.deleted_at IS NULL AND fi.deleted_at IS NULL AND fi.folder_id IS ?1
         ORDER BY m.updated_at DESC LIMIT ?2 OFFSET ?3`,
        [folderId, limit, offset]);
      const mindmaps: VfsMindMap[] = [];
      for (const row of rows) {
        try { mindmaps.push(rowToMindmap(row)); }
        catch (error) { logWarn('[VFS::MindMapRepo] Row parse error (skipped):', error); }
      }
      return mindmaps;
    });
  }

  deleteMindmap(conn: SqlExecutor, mindmapId: string): void {
    databaseResult(() => this.deleteMindmapWithConn(conn, mindmapId));
  }

  deleteMindmapWithConn(conn: SqlExecutor, mindmapId: string): void {
    databaseResult(() => {
      conn.exec('SAVEPOINT delete_mindmap');
      try {
        const now = utcTimestamp();
        const affected = conn.run(
          'UPDATE mindmaps SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL',
          [now, now, mindmapId]).changes;
        if (affected === 0) {
          const exists = Number(conn.pluck<number>(
            'SELECT EXISTS(SELECT 1 FROM mindmaps WHERE id = ?1)', [mindmapId]) ?? 0) !== 0;
          if (exists) {
            conn.exec('RELEASE SAVEPOINT delete_mindmap');
            return;
          }
          throw notFound('MindMap', mindmapId);
        }
        const nowMs = Date.now();
        conn.run(`UPDATE folder_items
            SET deleted_at = ?1, updated_at = ?2
            WHERE item_id = ?3 AND item_type = 'mindmap' AND deleted_at IS NULL`,
        [now, nowMs, mindmapId]);
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT delete_mindmap'); }
        catch (rollbackError) { logWarn('[VFS::MindMapRepo] delete_mindmap rollback failed:', rollbackError); }
        try { conn.exec('RELEASE SAVEPOINT delete_mindmap'); }
        catch (releaseError) { logWarn('[VFS::MindMapRepo] delete_mindmap release failed:', releaseError); }
        throw error;
      }
      try {
        conn.exec('RELEASE SAVEPOINT delete_mindmap');
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT delete_mindmap'); }
        catch (rollbackError) { logWarn('[VFS::MindMapRepo] delete_mindmap rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  restoreMindmap(conn: SqlExecutor, mindmapId: string): VfsMindMap {
    return databaseResult(() => {
      const mindmap = this.restoreMindmapWithConn(conn, mindmapId);
      try { this.indexStates.markPending(conn, mindmap.resourceId); }
      catch (error) {
        logWarn(
          `[VfsMindMapRepo] Failed to mark mindmap for re-indexing after restore: ${errorMessage(error)}`);
      }
      return mindmap;
    });
  }

  restoreMindmapWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMap {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const now = utcTimestamp();
        const affected = conn.run(
          'UPDATE mindmaps SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL',
          [now, mindmapId]).changes;
        if (affected === 0) throw notFound('MindMap (deleted)', mindmapId);

        conn.run(`UPDATE folder_items SET deleted_at = NULL, updated_at = ?1
            WHERE item_id = ?2 AND item_type = 'mindmap'`,
        [Date.now(), mindmapId]);
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      try {
        conn.exec('COMMIT');
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      const restored = this.getMindmapWithConn(conn, mindmapId);
      if (restored === null) throw notFound('MindMap', mindmapId);
      return restored;
    });
  }

  purgeMindmap(conn: SqlExecutor, mindmapId: string): void {
    databaseResult(() => this.purgeMindmapWithConn(conn, mindmapId));
  }

  purgeMindmapWithConn(conn: SqlExecutor, mindmapId: string): void {
    databaseResult(() => {
      conn.exec('SAVEPOINT vfs_mindmap_purge_tx');
      try {
        this.purgeMindmapInner(conn, mindmapId);
      } catch (error) {
        this.rollbackToSavepoint(conn, 'vfs_mindmap_purge_tx');
        throw error;
      }
      try {
        conn.exec('RELEASE SAVEPOINT vfs_mindmap_purge_tx');
      } catch (error) {
        this.rollbackToSavepoint(conn, 'vfs_mindmap_purge_tx');
        throw error;
      }
    });
  }

  private purgeMindmapInner(conn: SqlExecutor, mindmapId: string): void {
    const row = conn.get<Row>('SELECT resource_id FROM mindmaps WHERE id = ?1', [mindmapId]);
    const resourceId = row === undefined ? null : optionalText(row.resource_id);

    const versionResourceIds: string[] = [];
    for (const versionRow of conn.all<Row>(
      'SELECT resource_id FROM mindmap_versions WHERE mindmap_id = ?1', [mindmapId])) {
      const versionResourceId = optionalText(versionRow.resource_id);
      if (versionResourceId === null) {
        logWarn('[VFS::MindMapRepo] Failed to read version resource_id during purge');
        continue;
      }
      versionResourceIds.push(versionResourceId);
    }

    conn.run('DELETE FROM mindmap_versions WHERE mindmap_id = ?1', [mindmapId]);
    conn.run('DELETE FROM mindmaps WHERE id = ?1', [mindmapId]);
    conn.run("DELETE FROM folder_items WHERE item_id = ?1 AND item_type = 'mindmap'", [mindmapId]);

    if (resourceId !== null) {
      this.resources.decrementRef(conn, resourceId);
      const mindmapRefs = Number(conn.pluck<number>(
        'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1', [resourceId]) ?? 0);
      const versionRefs = Number(conn.pluck<number>(
        'SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1', [resourceId]) ?? 0);
      if (mindmapRefs === 0 && versionRefs === 0) {
        purgeIndexArtifactsByResource(conn, resourceId);
        conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
      }
    }

    for (const versionResourceId of versionResourceIds) {
      const newCount = this.resources.decrementRef(conn, versionResourceId);
      if (newCount <= 0) {
        const mindmapRefs = Number(conn.pluck<number>(
          'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1', [versionResourceId]) ?? 0);
        const versionRefs = Number(conn.pluck<number>(
          'SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1', [versionResourceId]) ?? 0);
        if (mindmapRefs === 0 && versionRefs === 0) {
          purgeIndexArtifactsByResource(conn, versionResourceId);
          conn.run('DELETE FROM resources WHERE id = ?1', [versionResourceId]);
        }
      }
    }
  }

  setFavorite(conn: SqlExecutor, mindmapId: string, isFavorite: boolean): void {
    databaseResult(() => this.setFavoriteWithConn(conn, mindmapId, isFavorite));
  }

  setFavoriteWithConn(conn: SqlExecutor, mindmapId: string, isFavorite: boolean): void {
    databaseResult(() => {
      const affected = conn.run(
        'UPDATE mindmaps SET is_favorite = ?1 WHERE id = ?2 AND deleted_at IS NULL',
        [isFavorite ? 1 : 0, mindmapId]).changes;
      if (affected === 0) throw notFound('MindMap', mindmapId);
    });
  }

  listDeletedMindmaps(conn: SqlExecutor, limit: number, offset: number): VfsMindMap[] {
    return databaseResult(() => this.listDeletedMindmapsWithConn(conn, limit, offset));
  }

  listDeletedMindmapsWithConn(conn: SqlExecutor, limit: number, offset: number): VfsMindMap[] {
    return databaseResult(() => {
      const rows = conn.all<Row>(
        `SELECT ${MINDMAP_COLUMNS} FROM mindmaps
         WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`,
        [limit, offset]);
      const mindmaps: VfsMindMap[] = [];
      for (const row of rows) {
        try { mindmaps.push(rowToDeletedMindmap(row)); }
        catch (error) { logWarn('[VFS::MindMapRepo] Row parse error (skipped):', error); }
      }
      return mindmaps;
    });
  }

  purgeDeletedMindmaps(conn: SqlExecutor): number {
    return databaseResult(() => this.purgeDeletedMindmapsWithConn(conn));
  }

  purgeDeletedMindmapsWithConn(conn: SqlExecutor): number {
    return databaseResult(() => {
      const ids = conn.all<Row>('SELECT id FROM mindmaps WHERE deleted_at IS NOT NULL')
        .map(row => String(row.id));
      const count = ids.length;
      if (count === 0) return 0;

      conn.exec('SAVEPOINT purge_deleted_mindmaps');
      try {
        for (const id of ids) this.purgeMindmapInner(conn, id);
      } catch (error) {
        this.rollbackToSavepoint(conn, 'purge_deleted_mindmaps');
        throw error;
      }
      try {
        conn.exec('RELEASE SAVEPOINT purge_deleted_mindmaps');
      } catch (error) {
        this.rollbackToSavepoint(conn, 'purge_deleted_mindmaps');
        throw error;
      }
      return count;
    });
  }

  createVersion(conn: SqlExecutor, mindmapId: string, content: string, title: string,
    label: string | null, source: string | null): VfsMindMapVersion {
    return databaseResult(() => this.createVersionWithConn(
      conn, mindmapId, content, title, label, source));
  }

  createVersionWithConn(conn: SqlExecutor, mindmapId: string, content: string, title: string,
    label: string | null, source: string | null): VfsMindMapVersion {
    return databaseResult(() => {
      const isChatSource = source !== null && source.startsWith('chat');
      const isMergeableSource = source === null || source === 'manual' || source === 'auto';

      if (isMergeableSource && label === null) {
        const latest = this.latestVersionInMergeWindow(conn, mindmapId, source);
        if (latest !== null) return latest;
      }

      const versionId = `mv_${nanoid(10)}`;
      const now = utcTimestamp();
      const snapshot = this.resources.createOrReuse(
        conn, 'mindmap', content, versionId, 'mindmap_versions', null);

      conn.run(`INSERT INTO mindmap_versions
          (version_id, mindmap_id, resource_id, title, label, source, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      [versionId, mindmapId, snapshot.resourceId, title, label, source, now]);

      if (!isChatSource) {
        try {
          this.pruneAutosaveVersions(conn, mindmapId, MAX_AUTOSAVE_VERSIONS);
        } catch (error) {
          logWarn(
            `[VFS::MindMapRepo] Failed to prune autosave versions for ${mindmapId}: ${errorMessage(error)}`);
        }
      }

      return {
        versionId,
        mindmapId,
        resourceId: snapshot.resourceId,
        title,
        ...(label === null ? {} : { label }),
        ...(source === null ? {} : { source }),
        createdAt: now,
      };
    });
  }

  private latestVersionInMergeWindow(conn: SqlExecutor, mindmapId: string,
    source: string | null): VfsMindMapVersion | null {
    const row = conn.get<Row>(
      `SELECT ${VERSION_COLUMNS} FROM mindmap_versions
       WHERE mindmap_id = ?1 ORDER BY created_at DESC, version_id DESC LIMIT 1`,
      [mindmapId]);
    if (row === undefined) return null;
    const latest = rowToVersion(row);
    if (latest.label !== undefined) return null;

    const normalizedLatest = latest.source ?? 'manual';
    const normalizedSource = source ?? 'manual';
    if (normalizedLatest !== normalizedSource) return null;

    const createdAt = parseRfc3339(latest.createdAt)?.millis ?? null;
    if (createdAt === null) {
      logWarn(
        `[VFS::MindMapRepo] Unparseable created_at for version ${latest.versionId} (mindmap ${mindmapId}): ${JSON.stringify(latest.createdAt)}`);
      return null;
    }
    const age = Date.now() - createdAt;
    if (age >= AUTOSAVE_MERGE_WINDOW_MINUTES * 60 * 1000 || age < 0) return null;
    return latest;
  }

  private pruneAutosaveVersions(conn: SqlExecutor, mindmapId: string, keepCount: number): void {
    const pruned: Array<[string, string]> = [];
    for (const row of conn.all<Row>(
      `SELECT version_id, resource_id FROM mindmap_versions
       WHERE mindmap_id = ?1
         AND (source IS NULL OR source NOT LIKE 'chat%')
         AND version_id NOT IN (
           SELECT version_id FROM mindmap_versions
           WHERE mindmap_id = ?1 AND (source IS NULL OR source NOT LIKE 'chat%')
           ORDER BY created_at DESC, version_id DESC
           LIMIT ?2
         )`,
      [mindmapId, keepCount])) {
      const versionId = optionalText(row.version_id);
      const resourceId = optionalText(row.resource_id);
      if (versionId === null || resourceId === null) {
        logWarn('[VFS::MindMapRepo] Row parse error (skipped)');
        continue;
      }
      pruned.push([versionId, resourceId]);
    }
    if (pruned.length === 0) return;

    for (const [versionId] of pruned) {
      conn.run('DELETE FROM mindmap_versions WHERE version_id = ?1', [versionId]);
    }

    const resourceIds = [...new Set(pruned.map(([, resourceId]) => resourceId))].sort();
    for (const resourceId of resourceIds) {
      this.resources.decrementRef(conn, resourceId);
      const mindmapRefs = Number(conn.pluck<number>(
        'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1', [resourceId]) ?? 0);
      const versionRefs = Number(conn.pluck<number>(
        'SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1', [resourceId]) ?? 0);
      if (mindmapRefs === 0 && versionRefs === 0) {
        purgeIndexArtifactsByResource(conn, resourceId);
        conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
      }
    }
  }

  getVersions(conn: SqlExecutor, mindmapId: string): VfsMindMapVersion[] {
    return databaseResult(() => this.getVersionsPagedWithConn(
      conn, mindmapId, DEFAULT_VERSION_PAGE_SIZE));
  }

  getVersionsWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMapVersion[] {
    return databaseResult(() => this.getVersionsPagedWithConn(
      conn, mindmapId, DEFAULT_VERSION_PAGE_SIZE));
  }

  getVersionsPaged(conn: SqlExecutor, mindmapId: string, limit: number): VfsMindMapVersion[] {
    return databaseResult(() => this.getVersionsPagedWithConn(conn, mindmapId, limit));
  }

  getVersionsPagedWithConn(conn: SqlExecutor, mindmapId: string,
    limit: number): VfsMindMapVersion[] {
    return databaseResult(() => {
      const effectiveLimit = limit === 0 ? DEFAULT_VERSION_PAGE_SIZE : limit;
      const rows = conn.all<Row>(
        `SELECT ${VERSION_COLUMNS} FROM mindmap_versions
         WHERE mindmap_id = ?1
         ORDER BY created_at DESC, version_id DESC LIMIT ?2`,
        [mindmapId, effectiveLimit]);
      const versions: VfsMindMapVersion[] = [];
      for (const row of rows) {
        try { versions.push(rowToVersion(row)); }
        catch (error) { logWarn('[VFS::MindMapRepo] Row parse error (skipped):', error); }
      }
      return versions;
    });
  }

  getVersion(conn: SqlExecutor, versionId: string): VfsMindMapVersion | null {
    return databaseResult(() => this.getVersionWithConn(conn, versionId));
  }

  getVersionWithConn(conn: SqlExecutor, versionId: string): VfsMindMapVersion | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT ${VERSION_COLUMNS} FROM mindmap_versions WHERE version_id = ?1`, [versionId]);
      return row === undefined ? null : rowToVersion(row);
    });
  }

  getVersionContent(conn: SqlExecutor, versionId: string): string | null {
    return databaseResult(() => this.getVersionContentWithConn(conn, versionId));
  }

  getVersionContentWithConn(conn: SqlExecutor, versionId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT r.data FROM mindmap_versions v
         JOIN resources r ON v.resource_id = r.id
         WHERE v.version_id = ?1`, [versionId]);
      return row === undefined ? null : optionalText(row.data);
    });
  }

  restoreVersion(conn: SqlExecutor, versionId: string): VfsMindMap {
    return databaseResult(() => {
      const mindmap = this.restoreVersionWithConn(conn, versionId);
      try { this.indexStates.markPending(conn, mindmap.resourceId); }
      catch (error) {
        logWarn(
          `[VfsMindMapRepo] Failed to mark mindmap for re-indexing after version restore: ${errorMessage(error)}`);
      }
      return mindmap;
    });
  }

  restoreVersionWithConn(conn: SqlExecutor, versionId: string): VfsMindMap {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      let restored: VfsMindMap;
      try {
        restored = this.restoreVersionInner(conn, versionId);
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      try {
        conn.exec('COMMIT');
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
      return restored;
    });
  }

  private restoreVersionInner(conn: SqlExecutor, versionId: string): VfsMindMap {
    const version = this.getVersionWithConn(conn, versionId);
    if (version === null) throw notFound('MindMapVersion', versionId);
    const targetContent = this.getVersionContentWithConn(conn, versionId);
    if (targetContent === null) throw notFound('MindMapVersionContent', versionId);

    const current = this.getMindmapWithConn(conn, version.mindmapId);
    if (current === null) throw notFound('MindMap', version.mindmapId);

    const currentResource = this.resources.getResource(conn, current.resourceId);
    if (currentResource === null) throw notFound('Resource', current.resourceId);

    const normalizedContent = this.normalizeContent(targetContent);
    const newHash = this.resources.computeHash(normalizedContent);
    if (newHash === currentResource.hash) return current;

    if (currentResource.data !== undefined) {
      this.createVersionWithConn(
        conn, version.mindmapId, currentResource.data, current.title, null, 'restore_backup');
    }

    let finalResourceId = current.resourceId;
    if (this.shouldCopyOnWriteResource(conn, current.resourceId)) {
      const resource = this.resources.createOrReuse(
        conn, 'mindmap', normalizedContent, version.mindmapId, 'mindmaps', null);
      finalResourceId = resource.resourceId;
    } else {
      this.resources.updateResourceData(conn, current.resourceId, normalizedContent);
    }

    const occBaseline = current.updatedAt >= current.contentUpdatedAt
      ? current.updatedAt
      : current.contentUpdatedAt;
    const now = nextTimestampAfter(occBaseline);
    conn.run(`UPDATE mindmaps
        SET resource_id = ?1, updated_at = ?2, content_updated_at = ?2
        WHERE id = ?3`,
    [finalResourceId, now, version.mindmapId]);

    return {
      ...current,
      resourceId: finalResourceId,
      updatedAt: now,
      contentUpdatedAt: now,
    };
  }

  private rollbackToSavepoint(conn: SqlExecutor, name: string): void {
    try {
      conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
    } catch (error) {
      logWarn(`[VFS::MindMapRepo] Savepoint ${name} rollback failed:`, error);
    }
  }
}
