/**
 * 资源库的内存后端：dstu_* / dstu_folder_* / 回收站 / 知识库索引 / 教材 PDF 字节。
 *
 * 第 04 章（资源库窗口）和第 05 章（教材阅读器）共用。每个演示页各建一份
 * （createLibraryBackend），刷新即复原。返回形状对齐 src-tauri/src/dstu 的
 * DstuNode（camelCase）与 VfsFolder / ResourceIndexStatus。
 *
 * 只依赖演示数据模块，不碰 app 代码（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import { getDemoPdfBase64 } from '../../../attachmentAssets';
import type { DemoArgs } from '../../types';
import {
  LIBRARY_FOLDERS,
  LIBRARY_RESOURCES,
  type LibraryIndexState,
  type LibraryNodeType,
} from './seed';

const DAY = 86_400_000;

interface FolderRow {
  id: string;
  title: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  sortOrder: number;
  isExpanded: boolean;
  deleted: boolean;
}

interface ResourceRow {
  id: string;
  type: LibraryNodeType;
  name: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  size?: number;
  mimeType?: string;
  previewType?: string;
  pageCount?: number;
  favorite: boolean;
  content: string;
  metadata: Record<string, unknown>;
  index: LibraryIndexState;
  chunks: number;
  ocr: boolean;
  indexedAt?: number;
  deleted: boolean;
  deletedAt?: number;
  revision: number;
}

/** 新建资源时的 id 前缀（与后端一致，资源类型靠前缀识别） */
const ID_PREFIX: Record<string, string> = {
  note: 'note',
  textbook: 'tb',
  exam: 'exam',
  translation: 'tr',
  essay: 'essay',
  mindmap: 'mm',
  image: 'img',
  file: 'file',
};

/** FolderItemType（文件夹内容项类型）↔ 节点类型 */
const FOLDER_ITEM_TYPE: Record<string, string> = {
  note: 'note',
  textbook: 'textbook',
  exam: 'exam',
  translation: 'translation',
  essay: 'essay',
  mindmap: 'mindmap',
  image: 'file',
  file: 'file',
};

export interface LibraryBackend {
  handle(cmd: string, args: DemoArgs): unknown;
  /** 读一条资源当前的 metadata（测试 / 包内联动用） */
  getMetadata(id: string): Record<string, unknown> | null;
}

export function createLibraryBackend(): LibraryBackend {
  const now = Date.now();
  const folders = new Map<string, FolderRow>();
  const resources = new Map<string, ResourceRow>();
  let seq = 1;

  LIBRARY_FOLDERS.forEach((f, i) => {
    folders.set(f.id, {
      id: f.id,
      title: f.title,
      parentId: f.parentId,
      createdAt: now - f.createdDaysAgo * DAY,
      updatedAt: now - f.updatedDaysAgo * DAY,
      sortOrder: i,
      isExpanded: false,
      deleted: false,
    });
  });
  for (const r of LIBRARY_RESOURCES) {
    const updatedAt = now - r.updatedDaysAgo * DAY;
    resources.set(r.id, {
      id: r.id,
      type: r.type,
      name: r.name,
      folderId: r.folderId,
      createdAt: now - r.createdDaysAgo * DAY,
      updatedAt,
      size: r.size ?? (r.content ? new Blob([r.content]).size : undefined),
      mimeType: r.mimeType,
      previewType: r.previewType,
      pageCount: r.pageCount,
      favorite: Boolean(r.favorite),
      content: r.content ?? '',
      metadata: { ...(r.metadata ?? {}) },
      index: r.index,
      chunks: r.chunks ?? 0,
      ocr: Boolean(r.ocr),
      indexedAt: r.index === 'indexed' ? updatedAt + 60_000 : undefined,
      deleted: Boolean(r.deleted),
      deletedAt: r.deleted ? now - (r.updatedDaysAgo - 0.5) * DAY : undefined,
      revision: 1,
    });
  }
  // 演示 PDF 的真实字节数
  const pdf = resources.get('tb_demo_mlsys');
  if (pdf) pdf.size = Math.floor((getDemoPdfBase64().length * 3) / 4);

  // ---------------------------------------------------------------- helpers

  const idFromPath = (path: unknown): string => {
    const segments = String(path ?? '').split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  };

  const folderPath = (folderId: string | null): string => {
    const names: string[] = [];
    let cursor = folderId ? folders.get(folderId) : undefined;
    let guard = 0;
    while (cursor && guard++ < 20) {
      names.unshift(cursor.title);
      cursor = cursor.parentId ? folders.get(cursor.parentId) : undefined;
    }
    return names.length ? `/${names.join('/')}` : '';
  };

  const liveFolder = (id: string | null | undefined): FolderRow | undefined => {
    if (!id) return undefined;
    const folder = folders.get(id);
    return folder && !folder.deleted ? folder : undefined;
  };

  /** 资源可见：自身未删，且不在已删文件夹里 */
  const isVisible = (r: ResourceRow): boolean => {
    if (r.deleted) return false;
    let cursor = r.folderId;
    let guard = 0;
    while (cursor && guard++ < 20) {
      const folder = folders.get(cursor);
      if (!folder) return true;
      if (folder.deleted) return false;
      cursor = folder.parentId;
    }
    return true;
  };

  const childCount = (folderId: string): number =>
    [...folders.values()].filter((f) => f.parentId === folderId && !f.deleted).length +
    [...resources.values()].filter((r) => r.folderId === folderId && !r.deleted).length;

  const resourceNode = (r: ResourceRow) => {
    const base = folderPath(r.folderId);
    const metadata: Record<string, unknown> = { ...r.metadata, isFavorite: r.favorite };
    if (r.mimeType) metadata.mimeType = r.mimeType;
    if (r.size !== undefined) metadata.size = r.size;
    if (r.pageCount !== undefined) metadata.pageCount = r.pageCount;
    if (r.type === 'textbook') {
      metadata.filePath = null;
      metadata.annotationRevision = `rev-${r.id}-${r.revision}`;
      if (!Array.isArray(metadata.highlights)) metadata.highlights = [];
      if (!Array.isArray(metadata.bookmarks)) metadata.bookmarks = [];
    }
    if (r.type === 'note') {
      metadata.tags = metadata.tags ?? [];
      metadata.props = metadata.props ?? {};
      const preview = r.content.replace(/[#>*`$\\-]/g, '').replace(/\s+/g, ' ').trim();
      if (preview) metadata.contentPreview = preview.slice(0, 160);
    }
    return {
      id: r.id,
      path: `${base}/${r.id}`,
      name: r.name,
      type: r.type,
      size: r.size,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      resourceId: `res_${r.id}`,
      sourceId: r.id,
      resourceHash: `hash_${r.id}_${r.revision}`,
      previewType: r.previewType ?? (r.type === 'note' ? 'markdown' : r.type === 'mindmap' ? 'mindmap' : r.type === 'exam' ? 'exam' : r.type === 'image' ? 'image' : undefined),
      metadata,
    };
  };

  const folderNode = (f: FolderRow) => ({
    id: f.id,
    path: folderPath(f.id),
    name: f.title,
    type: 'folder' as const,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    childCount: childCount(f.id),
    sourceId: f.id,
    metadata: {},
  });

  const vfsFolder = (f: FolderRow) => ({
    id: f.id,
    parentId: f.parentId,
    title: f.title,
    isExpanded: f.isExpanded,
    sortOrder: f.sortOrder,
    isBuiltin: false,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  });

  const folderItem = (r: ResourceRow, i: number) => ({
    id: `fi_${r.id}`,
    folderId: r.folderId,
    itemType: FOLDER_ITEM_TYPE[r.type] ?? 'file',
    itemId: r.id,
    sortOrder: i,
    createdAt: r.createdAt,
  });

  type Node = ReturnType<typeof resourceNode> | ReturnType<typeof folderNode>;

  const sortNodes = (nodes: Node[], options: Record<string, unknown>): Node[] => {
    const sortBy = String(options.sortBy ?? 'updatedAt');
    const asc = options.sortOrder === 'asc';
    return [...nodes].sort((a, b) => {
      const cmp =
        sortBy === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : sortBy === 'createdAt'
            ? a.createdAt - b.createdAt
            : a.updatedAt - b.updatedAt;
      return asc ? cmp : -cmp;
    });
  };

  const touchFolder = (folderId: string | null) => {
    const f = folderId ? folders.get(folderId) : undefined;
    if (f) f.updatedAt = Date.now();
  };

  const findResource = (path: unknown): ResourceRow | undefined => resources.get(idFromPath(path));

  const requireResource = (path: unknown): ResourceRow => {
    const r = findResource(path);
    if (!r) throw new Error(tr('资源不存在', 'Resource not found'));
    return r;
  };

  /** 从「/文件夹路径」或「/fld_xxx」里认出目标文件夹（根目录为 null） */
  const folderFromPath = (path: unknown): string | null => {
    const raw = String(path ?? '');
    const segments = raw.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (folders.has(segments[i])) return segments[i];
    }
    if (!segments.length) return null;
    const byPath = [...folders.values()].find((f) => folderPath(f.id) === `/${segments.join('/')}`);
    return byPath?.id ?? null;
  };

  const matchQuery = (r: ResourceRow, q: string) => {
    if (r.name.toLowerCase().includes(q)) return { hit: true, snippet: undefined as string | undefined };
    const idx = r.content.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 18);
      return { hit: true, snippet: `${start > 0 ? '…' : ''}${r.content.slice(start, idx + q.length + 30).replace(/\s+/g, ' ')}…` };
    }
    return { hit: false, snippet: undefined };
  };

  const search = (query: unknown, folderId: string | null, options: Record<string, unknown>): Node[] => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const within = (r: ResourceRow): boolean => {
      if (!folderId) return true;
      let cursor = r.folderId;
      let guard = 0;
      while (cursor && guard++ < 20) {
        if (cursor === folderId) return true;
        cursor = folders.get(cursor)?.parentId ?? null;
      }
      return false;
    };
    const nodes: Node[] = [];
    for (const r of resources.values()) {
      if (!isVisible(r) || !within(r)) continue;
      if (options.typeFilter && r.type !== options.typeFilter) continue;
      if (options.isFavorite && !r.favorite) continue;
      const { hit, snippet } = matchQuery(r, q);
      if (!hit) continue;
      const node = resourceNode(r);
      if (snippet) Object.assign(node.metadata, { snippet, matchSource: 'index' });
      nodes.push(node);
    }
    if (!options.typeFilter && !options.isFavorite) {
      for (const f of folders.values()) {
        if (!f.deleted && f.title.toLowerCase().includes(q) && (!folderId || f.parentId === folderId)) {
          nodes.push(folderNode(f));
        }
      }
    }
    return sortNodes(nodes, options);
  };

  const list = (options: Record<string, unknown>): Node[] => {
    const folderId = typeof options.folderId === 'string' && options.folderId && options.folderId !== 'root'
      ? options.folderId
      : null;
    const typeFilter = typeof options.typeFilter === 'string' ? options.typeFilter : null;
    let nodes: Node[];
    if (options.isFavorite) {
      nodes = [...resources.values()].filter((r) => isVisible(r) && r.favorite).map(resourceNode);
    } else if (typeFilter && !folderId) {
      nodes = [...resources.values()].filter((r) => isVisible(r) && r.type === typeFilter).map(resourceNode);
    } else {
      if (folderId && !liveFolder(folderId)) throw new Error(tr('文件夹不存在', 'Folder not found'));
      const subFolders = typeFilter
        ? []
        : [...folders.values()].filter((f) => !f.deleted && f.parentId === folderId).map(folderNode);
      const items = [...resources.values()]
        .filter((r) => !r.deleted && r.folderId === folderId && (!typeFilter || r.type === typeFilter))
        .map(resourceNode);
      nodes = [...subFolders, ...items];
    }
    if (typeof options.search === 'string' && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      nodes = nodes.filter((n) => n.name.toLowerCase().includes(q));
    }
    nodes = sortNodes(nodes, options);
    const offset = Number(options.offset ?? 0) || 0;
    const limit = Number(options.limit ?? 0) || nodes.length;
    return nodes.slice(offset, offset + limit);
  };

  const trashNodes = (types?: string[] | null): Node[] => {
    const nodes: Node[] = [];
    for (const r of resources.values()) {
      if (r.deleted && (!types?.length || types.includes(r.type))) {
        const node = resourceNode(r);
        node.updatedAt = r.deletedAt ?? r.updatedAt;
        nodes.push(node);
      }
    }
    if (!types?.length || types.includes('folder')) {
      for (const f of folders.values()) if (f.deleted) nodes.push(folderNode(f));
    }
    return nodes.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  const softDelete = (id: string): void => {
    const r = resources.get(id);
    if (r) {
      r.deleted = true;
      r.deletedAt = Date.now();
      touchFolder(r.folderId);
      return;
    }
    const f = folders.get(id);
    if (f) {
      f.deleted = true;
      f.updatedAt = Date.now();
      return;
    }
    throw new Error(tr('资源不存在', 'Resource not found'));
  };

  const restore = (id: string): void => {
    const r = resources.get(id);
    if (r) {
      r.deleted = false;
      r.deletedAt = undefined;
      if (r.folderId && !liveFolder(r.folderId)) r.folderId = null;
      touchFolder(r.folderId);
      return;
    }
    const f = folders.get(id);
    if (f) {
      f.deleted = false;
      if (f.parentId && !liveFolder(f.parentId)) f.parentId = null;
    }
  };

  const purge = (id: string): void => {
    if (resources.delete(id)) return;
    if (folders.has(id)) {
      folders.delete(id);
      for (const r of resources.values()) if (r.folderId === id) resources.delete(r.id);
      for (const f of folders.values()) if (f.parentId === id) purge(f.id);
    }
  };

  const createResource = (type: LibraryNodeType, name: string, folderId: string | null, extra?: Partial<ResourceRow>): ResourceRow => {
    const id = `${ID_PREFIX[type] ?? 'res'}_demo_new${seq++}`;
    const t = Date.now();
    const row: ResourceRow = {
      id,
      type,
      name,
      folderId: liveFolder(folderId) ? folderId : null,
      createdAt: t,
      updatedAt: t,
      favorite: false,
      content: '',
      metadata: {},
      index: 'pending',
      chunks: 0,
      ocr: false,
      deleted: false,
      revision: 1,
      ...extra,
    };
    resources.set(id, row);
    touchFolder(row.folderId);
    // 新资源进入索引队列：两秒后完成，知识库索引页能看到状态变化
    scheduleIndex(row);
    return row;
  };

  const scheduleIndex = (r: ResourceRow) => {
    r.index = 'indexing';
    setTimeout(() => {
      if (!resources.has(r.id)) return;
      r.index = 'indexed';
      r.indexedAt = Date.now();
      r.chunks = Math.max(r.chunks, 1);
    }, 2200);
  };

  const indexStatus = (r: ResourceRow) => ({
    resourceId: `res_${r.id}`,
    sourceId: r.id,
    resourceType: r.type,
    name: r.name,
    hasOcr: r.ocr,
    ocrCount: r.ocr ? Math.max(1, r.pageCount ?? 1) : 0,
    textIndexState: r.index,
    textIndexedAt: r.indexedAt,
    textChunkCount: r.index === 'indexed' ? r.chunks : 0,
    nativeTextChunkCount: r.index === 'indexed' ? (r.ocr ? Math.floor(r.chunks / 2) : r.chunks) : 0,
    ocrTextChunkCount: r.index === 'indexed' && r.ocr ? Math.ceil(r.chunks / 2) : 0,
    textEmbeddingDim: r.index === 'indexed' ? 1024 : undefined,
    textIndexSource: r.ocr ? 'ocr' : 'native',
    mmIndexState: r.type === 'textbook' || r.type === 'image' ? (r.index === 'indexed' ? 'indexed' : 'pending') : 'disabled',
    mmIndexedPages: r.type === 'textbook' && r.index === 'indexed' ? Math.min(r.pageCount ?? 0, 60) : r.type === 'image' && r.index === 'indexed' ? 1 : 0,
    mmEmbeddingDim: r.type === 'textbook' || r.type === 'image' ? 1024 : undefined,
    embeddingDim: 1024,
    modality: 'text',
    updatedAt: r.updatedAt,
    isStale: false,
  });

  const indexSummary = (args: DemoArgs) => {
    const all = [...resources.values()].filter(isVisible);
    const typeFilter = typeof args.resourceType === 'string' ? args.resourceType : null;
    const stateFilter = typeof args.stateFilter === 'string' ? args.stateFilter : null;
    const folderId = typeof args.folderId === 'string' ? args.folderId : null;
    const filtered = all.filter((r) =>
      (!typeFilter || r.type === typeFilter) &&
      (!stateFilter || r.index === stateFilter) &&
      (!folderId || r.folderId === folderId),
    );
    const count = (state: LibraryIndexState) => all.filter((r) => r.index === state).length;
    const mm = all.filter((r) => r.type === 'textbook' || r.type === 'image');
    const offset = Number(args.offset ?? 0) || 0;
    const limit = Number(args.limit ?? 100) || 100;
    return {
      totalResources: all.length,
      indexedCount: count('indexed'),
      pendingCount: count('pending'),
      indexingCount: count('indexing'),
      failedCount: count('failed'),
      disabledCount: count('disabled'),
      staleCount: 0,
      mmTotalResources: mm.length,
      mmIndexedCount: mm.filter((r) => r.index === 'indexed').length,
      mmPendingCount: mm.filter((r) => r.index !== 'indexed').length,
      mmIndexingCount: 0,
      mmFailedCount: 0,
      mmDisabledCount: 0,
      resources: filtered
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(offset, offset + limit)
        .map(indexStatus),
    };
  };

  // ---------------------------------------------------------------- handler

  const handle = (cmd: string, args: DemoArgs): unknown => {
    switch (cmd) {
      // ---------- 列表 / 读取 ----------
      case 'dstu_list':
        return list((args.options ?? {}) as Record<string, unknown>);
      case 'dstu_get': {
        const id = idFromPath(args.path);
        const r = resources.get(id);
        if (r) return resourceNode(r);
        const f = folders.get(id);
        if (f) return folderNode(f);
        return null;
      }
      case 'dstu_get_resource_by_path': {
        const r = findResource(args.path);
        return r ? resourceNode(r) : null;
      }
      case 'dstu_get_content': {
        const r = requireResource(args.path);
        return r.content;
      }
      case 'dstu_search':
        return search(args.query, null, (args.options ?? {}) as Record<string, unknown>);
      case 'dstu_search_in_folder':
        return search(args.query, (args.folderId ?? args.folder_id ?? null) as string | null, (args.options ?? {}) as Record<string, unknown>);
      case 'dstu_get_resource_location': {
        const r = resources.get(String(args.resourceId ?? ''));
        if (!r) throw new Error(tr('资源不存在', 'Resource not found'));
        return {
          id: r.id,
          resourceType: r.type,
          folderId: r.folderId,
          folderPath: folderPath(r.folderId) || '/',
          fullPath: `${folderPath(r.folderId)}/${r.id}`,
          hash: `hash_${r.id}_${r.revision}`,
        };
      }
      case 'dstu_get_path_by_id': {
        const r = resources.get(String(args.resourceId ?? ''));
        return r ? `${folderPath(r.folderId)}/${r.id}` : `/${String(args.resourceId ?? '')}`;
      }
      case 'dstu_refresh_path_cache':
        return 0;
      case 'dstu_export_formats':
        return [];
      case 'dstu_export':
        throw new Error(tr('导出文件需要在桌面版中使用。', 'Exporting files is available in the desktop app.'));

      // ---------- 修改 ----------
      case 'dstu_create': {
        const options = (args.options ?? {}) as { type?: string; name?: string; content?: string; metadata?: Record<string, unknown> };
        const type = (options.type ?? 'note') as LibraryNodeType;
        const metadata = { ...(options.metadata ?? {}) };
        const folderId = typeof metadata.folderId === 'string' ? metadata.folderId : folderFromPath(args.path);
        delete metadata.folderId;
        const row = createResource(type, options.name ?? tr('未命名', 'Untitled'), folderId, {
          content: options.content ?? '',
          metadata,
          previewType: type === 'note' ? 'markdown' : undefined,
        });
        return resourceNode(row);
      }
      case 'dstu_update': {
        const r = requireResource(args.path);
        r.content = String(args.content ?? '');
        r.updatedAt = Date.now();
        r.revision += 1;
        return resourceNode(r);
      }
      case 'dstu_rename': {
        const r = requireResource(args.path);
        r.name = String(args.newName ?? args.new_name ?? r.name);
        r.updatedAt = Date.now();
        return resourceNode(r);
      }
      case 'dstu_set_favorite': {
        const r = requireResource(args.path);
        r.favorite = Boolean(args.favorite);
        return null;
      }
      case 'dstu_set_metadata': {
        const r = requireResource(args.path);
        const incoming = { ...((args.metadata ?? {}) as Record<string, unknown>) };
        const expected = args.expectedUpdatedAt;
        if (typeof expected === 'string' && r.type === 'textbook' && expected !== `rev-${r.id}-${r.revision}`) {
          throw new Error(tr('批注已在其他窗口更新', 'Annotations were updated elsewhere'));
        }
        for (const key of ['isFavorite', 'annotationRevision', 'filePath', 'mimeType', 'size', 'pageCount']) delete incoming[key];
        r.metadata = { ...r.metadata, ...incoming };
        r.revision += 1;
        r.updatedAt = Date.now();
        return null;
      }
      case 'dstu_copy': {
        const src = requireResource(args.src);
        const copy = createResource(src.type, `${src.name.replace(/(\.[a-z0-9]+)$/i, '')} ${tr('副本', 'copy')}${/\.[a-z0-9]+$/i.exec(src.name)?.[0] ?? ''}`, folderFromPath(args.dst), {
          content: src.content,
          metadata: { ...src.metadata },
          size: src.size,
          mimeType: src.mimeType,
          previewType: src.previewType,
          pageCount: src.pageCount,
          chunks: src.chunks,
        });
        return resourceNode(copy);
      }
      case 'dstu_move': {
        const r = requireResource(args.src);
        touchFolder(r.folderId);
        r.folderId = folderFromPath(args.dst);
        touchFolder(r.folderId);
        return resourceNode(r);
      }
      case 'dstu_move_many': {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        const target = folderFromPath(args.destFolder ?? args.dest_folder);
        let moved = 0;
        for (const p of paths) {
          const id = idFromPath(p);
          const r = resources.get(id);
          if (r) {
            r.folderId = target;
            moved += 1;
          } else if (folders.has(id) && id !== target) {
            folders.get(id)!.parentId = target;
            moved += 1;
          }
        }
        touchFolder(target);
        return moved;
      }
      case 'dstu_move_to_folder': {
        const r = resources.get(String(args.resourceId ?? ''));
        if (!r) throw new Error(tr('资源不存在', 'Resource not found'));
        r.folderId = liveFolder(args.targetFolderId as string) ? (args.targetFolderId as string) : null;
        return {
          id: r.id,
          resourceType: r.type,
          folderId: r.folderId,
          folderPath: folderPath(r.folderId) || '/',
          fullPath: `${folderPath(r.folderId)}/${r.id}`,
        };
      }

      // ---------- 删除 / 回收站 ----------
      case 'dstu_delete':
        softDelete(idFromPath(args.path));
        return null;
      case 'dstu_delete_many': {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        let n = 0;
        for (const p of paths) {
          try {
            softDelete(idFromPath(p));
            n += 1;
          } catch {
            /* 已不存在的跳过 */
          }
        }
        return n;
      }
      case 'dstu_soft_delete':
        softDelete(String(args.id ?? ''));
        return null;
      case 'dstu_trash_restore':
        restore(String(args.id ?? ''));
        return null;
      case 'dstu_restore': {
        const id = idFromPath(args.path);
        restore(id);
        const r = resources.get(id);
        return r ? resourceNode(r) : folders.get(id) ? folderNode(folders.get(id)!) : null;
      }
      case 'dstu_restore_many': {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        paths.forEach((p) => restore(idFromPath(p)));
        return paths.length;
      }
      case 'dstu_list_trash':
        return trashNodes(Array.isArray(args.itemTypes) ? (args.itemTypes as string[]) : null);
      case 'dstu_list_deleted':
        return trashNodes([String(args.resourceType ?? '')]);
      case 'dstu_permanently_delete':
        purge(String(args.id ?? ''));
        return null;
      case 'dstu_purge':
        purge(idFromPath(args.path));
        return null;
      case 'dstu_purge_all':
      case 'dstu_empty_trash': {
        const types = cmd === 'dstu_purge_all'
          ? [String(args.resourceType ?? '')]
          : Array.isArray(args.itemTypes) ? (args.itemTypes as string[]) : null;
        const victims = trashNodes(types);
        victims.forEach((n) => purge(n.id));
        return victims.length;
      }

      // ---------- 文件夹 ----------
      case 'dstu_folder_list':
        return [...folders.values()].filter((f) => !f.deleted).map(vfsFolder);
      case 'dstu_folder_get': {
        const f = liveFolder(String(args.folderId ?? ''));
        return f ? vfsFolder(f) : null;
      }
      case 'dstu_folder_get_tree': {
        const build = (parentId: string | null): unknown[] =>
          [...folders.values()]
            .filter((f) => !f.deleted && f.parentId === parentId)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((f) => ({
              folder: vfsFolder(f),
              children: build(f.id),
              items: [...resources.values()].filter((r) => !r.deleted && r.folderId === f.id).map(folderItem),
            }));
        return build(null);
      }
      case 'dstu_folder_get_items': {
        const folderId = (args.folderId ?? null) as string | null;
        return [...resources.values()].filter((r) => !r.deleted && r.folderId === folderId).map(folderItem);
      }
      case 'dstu_folder_get_breadcrumbs': {
        const crumbs: Array<{ id: string; name: string }> = [];
        let cursor = liveFolder(String(args.folderId ?? ''));
        let guard = 0;
        while (cursor && guard++ < 20) {
          crumbs.unshift({ id: cursor.id, name: cursor.title });
          cursor = liveFolder(cursor.parentId);
        }
        return crumbs;
      }
      case 'dstu_folder_get_all_resources': {
        const folderId = String(args.folderId ?? '');
        const f = liveFolder(folderId);
        const items = [...resources.values()].filter((r) => isVisible(r) && r.folderId === folderId);
        return {
          folderId,
          folderTitle: f?.title ?? '',
          path: folderPath(folderId),
          totalCount: items.length,
          resources: items.map((r) => ({
            itemType: FOLDER_ITEM_TYPE[r.type] ?? 'file',
            itemId: r.id,
            resourceId: `res_${r.id}`,
            title: r.name,
            path: `${folderPath(r.folderId)}/${r.id}`,
            content: args.includeContent ? r.content : undefined,
          })),
        };
      }
      case 'dstu_folder_create': {
        const id = `fld_demo_new${seq++}`;
        const t = Date.now();
        const parentId = liveFolder(args.parentId as string) ? (args.parentId as string) : null;
        const row: FolderRow = {
          id,
          title: String(args.title ?? tr('新建文件夹', 'New Folder')),
          parentId,
          createdAt: t,
          updatedAt: t,
          sortOrder: folders.size,
          isExpanded: false,
          deleted: false,
        };
        folders.set(id, row);
        touchFolder(parentId);
        return vfsFolder(row);
      }
      case 'dstu_folder_rename': {
        const f = liveFolder(String(args.folderId ?? ''));
        if (!f) throw new Error(tr('文件夹不存在', 'Folder not found'));
        f.title = String(args.title ?? f.title);
        f.updatedAt = Date.now();
        return null;
      }
      case 'dstu_folder_delete':
        softDelete(String(args.folderId ?? ''));
        return null;
      case 'dstu_folder_move': {
        const f = liveFolder(String(args.folderId ?? ''));
        if (!f) throw new Error(tr('文件夹不存在', 'Folder not found'));
        const target = (args.newParentId ?? null) as string | null;
        // 不能移进自己或自己的子孙
        let cursor = target;
        let guard = 0;
        while (cursor && guard++ < 20) {
          if (cursor === f.id) throw new Error(tr('不能把文件夹移动到它自己里面', 'A folder cannot be moved into itself'));
          cursor = folders.get(cursor)?.parentId ?? null;
        }
        f.parentId = liveFolder(target) ? target : null;
        f.updatedAt = Date.now();
        return null;
      }
      case 'dstu_folder_set_expanded': {
        const f = folders.get(String(args.folderId ?? ''));
        if (f) f.isExpanded = Boolean(args.isExpanded);
        return null;
      }
      case 'dstu_folder_add_item':
      case 'dstu_folder_move_item': {
        const r = resources.get(String(args.itemId ?? ''));
        if (!r) throw new Error(tr('资源不存在', 'Resource not found'));
        const target = (args.folderId ?? args.newFolderId ?? null) as string | null;
        touchFolder(r.folderId);
        r.folderId = liveFolder(target) ? target : null;
        touchFolder(r.folderId);
        return cmd === 'dstu_folder_add_item' ? folderItem(r, 0) : null;
      }
      case 'dstu_folder_remove_item': {
        const r = resources.get(String(args.itemId ?? ''));
        if (r) r.folderId = null;
        return null;
      }
      case 'dstu_folder_reorder':
      case 'dstu_folder_reorder_items':
        return null;

      // ---------- 知识库索引 ----------
      case 'vfs_get_embedding_readiness':
        return { ready: true, modelConfigId: 'demo-bge-m3', modelName: 'BAAI/bge-m3', reason: null, vectorIndexAvailable: true };
      case 'vfs_get_all_index_status':
        return indexSummary(args);
      case 'vfs_list_dimensions':
        return [
          {
            dimension: 1024,
            modality: 'text',
            modelConfigId: 'demo-bge-m3',
            modelName: 'BAAI/bge-m3',
            recordCount: [...resources.values()].reduce((sum, r) => sum + (r.index === 'indexed' ? r.chunks : 0), 0),
            lanceTableName: 'vfs_text_1024',
            createdAt: now - 34 * DAY,
            lastUsedAt: now - 600_000,
          },
        ];
      case 'vfs_reindex_resource': {
        const id = String(args.resourceId ?? '').replace(/^res_/, '');
        const r = resources.get(id);
        if (!r) throw new Error(tr('资源不存在', 'Resource not found'));
        scheduleIndex(r);
        return Math.max(r.chunks, 1);
      }
      case 'vfs_batch_index_pending':
      case 'vfs_unified_batch_index': {
        const pending = [...resources.values()].filter((r) => isVisible(r) && (r.index === 'pending' || r.index === 'failed'));
        pending.forEach(scheduleIndex);
        return cmd === 'vfs_batch_index_pending'
          ? { successCount: pending.length, failCount: 0, total: pending.length }
          : { successCount: pending.length, failCount: 0, totalProcessed: pending.length, errors: [] };
      }
      // 删除前提示「被 N 个对话引用」：演示资料没有被对话引用
      case 'vfs_get_resource_ref_count':
        return 0;
      case 'memory_get_config':
        return {
          memoryRootFolderId: null,
          memoryRootFolderTitle: null,
          autoCreateSubfolders: true,
          defaultCategory: 'fact',
          privacyMode: false,
          autoExtractFrequency: 'balanced',
        };

      // 阅读器书签（教材走 textbooks 表）
      case 'textbooks_update_bookmarks': {
        const r = resources.get(String(args.id ?? ''));
        if (!r) throw new Error(tr('资源不存在', 'Resource not found'));
        r.metadata = { ...r.metadata, bookmarks: Array.isArray(args.bookmarks) ? args.bookmarks : [] };
        r.revision += 1;
        return null;
      }

      // ---------- 教材字节（无本地文件 → base64 整文件加载） ----------
      case 'vfs_get_file_blob_path':
        return null;
      case 'pdfstream_check_access':
        return { available: false, reason: 'demo' };
      case 'vfs_get_attachment_content': {
        const r = resources.get(String(args.attachmentId ?? ''));
        if (r && (r.previewType === 'pdf' || r.mimeType === 'application/pdf')) {
          return { content: getDemoPdfBase64(), found: true };
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };

  return {
    handle,
    getMetadata: (id) => {
      const r = resources.get(id);
      return r ? resourceNode(r).metadata : null;
    },
  };
}
