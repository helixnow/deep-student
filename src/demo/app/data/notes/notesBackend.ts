/**
 * 笔记章的内存后端：DSTU 资源（笔记 + 导图）、文件夹树、标签、双链图谱。
 * 编辑、新建、改名、删除、移动、收藏、属性都只改内存；刷新页面即还原。
 * 只依赖演示模块，不碰 app 模块（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';
import { DEMO_FOLDERS, DEMO_NOTES, FOLDER_LA, FOLDER_MLSYS } from './notesContent';
import {
  MM_DP_ID,
  MM_EIGEN_ID,
  createDemoMindmap,
  deleteDemoMindmap,
  getDemoMindmapContent,
  handleDemoMindmaps,
  listDemoMindmaps,
  renameDemoMindmap,
} from './mindmaps';

const DAY = 86_400_000;

interface NoteRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  props: Record<string, unknown>;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
}

interface FolderRecord {
  id: string;
  parentId: string | null;
  title: string;
  icon?: string;
  color?: string;
  isExpanded: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

type ItemType = 'note' | 'mindmap';

const now0 = Date.now();
const notes = new Map<string, NoteRecord>();
const trash = new Map<string, NoteRecord>();
const folders = new Map<string, FolderRecord>();
/** `${type}:${id}` → folderId */
const membership = new Map<string, string>();
const prefs = new Map<string, unknown>();
const leases = new Map<string, { token: string; phase: string; notes: unknown[]; waiting_for: string[]; [key: string]: unknown }>();
const leaseDrafts = new Map<string, string>();

interface NoteVersion {
  version_id: string;
  note_id: string;
  parent_version_id: string | null;
  restored_from_version_id: string | null;
  title: string;
  source: string;
  created_at: string;
  pinned: boolean;
  content_md: string;
  tags: string[];
}
/** noteId → 版本（新的在前） */
const history = new Map<string, NoteVersion[]>();

function pushVersion(note: NoteRecord, source: string, at = Date.now(), content = note.content, extra: Partial<NoteVersion> = {}): NoteVersion {
  const list = history.get(note.id) ?? [];
  const version: NoteVersion = {
    version_id: `nv_${note.id}_${list.length + 1}_${++seq}`,
    note_id: note.id,
    parent_version_id: list[0]?.version_id ?? null,
    restored_from_version_id: null,
    title: note.title,
    source,
    created_at: new Date(at).toISOString(),
    pinned: false,
    content_md: content,
    tags: [...note.tags],
    ...extra,
  };
  // 普通编辑 5 分钟内合并成一版（与桌面版默认的合并窗口同理）
  const head = list[0];
  if (source === 'edit' && head?.source === 'edit' && !head.pinned && at - Date.parse(head.created_at) < 300_000) {
    list[0] = { ...version, version_id: head.version_id, parent_version_id: head.parent_version_id };
  } else {
    list.unshift(version);
  }
  history.set(note.id, list);
  return list[0];
}

function summary(version: NoteVersion) {
  const { content_md, tags: _tags, ...rest } = version;
  return { ...rest, content_bytes: encoder.encode(content_md).length };
}
let seq = 0;

for (const folder of DEMO_FOLDERS) {
  folders.set(folder.id, { ...folder, isExpanded: true, createdAt: now0 - 40 * DAY, updatedAt: now0 - 40 * DAY });
}
for (const seed of DEMO_NOTES) {
  notes.set(seed.id, {
    id: seed.id,
    title: seed.title,
    content: seed.content,
    tags: [...seed.tags],
    props: { ...(seed.props ?? {}) },
    isFavorite: Boolean(seed.favorite),
    createdAt: now0 - seed.createdDaysAgo * DAY - 3_600_000,
    updatedAt: now0 - seed.updatedDaysAgo * DAY - 600_000,
  });
  if (seed.folderId) membership.set(`note:${seed.id}`, seed.folderId);
}
// 历史版本：创建时只写了前半篇，后来补全
for (const note of notes.values()) {
  const cut = note.content.indexOf('\n## ', Math.floor(note.content.length / 2));
  pushVersion(note, 'created', note.createdAt, cut > 0 ? note.content.slice(0, cut + 1) : note.content);
  pushVersion(note, 'edit', note.updatedAt);
}

membership.set(`mindmap:${MM_EIGEN_ID}`, FOLDER_LA);
membership.set(`mindmap:${MM_DP_ID}`, FOLDER_MLSYS);

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function noteNode(note: NoteRecord) {
  return {
    id: note.id,
    path: `/${note.id}`,
    name: note.title,
    type: 'note',
    size: new TextEncoder().encode(note.content).length,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    resourceId: `res_${note.id}`,
    sourceId: note.id,
    resourceHash: hashOf(note.content + note.updatedAt),
    previewType: 'markdown',
    metadata: { isFavorite: note.isFavorite, tags: [...note.tags], props: { ...note.props } },
  };
}

function mindmapNodes() {
  return listDemoMindmaps().map((mm) => ({
    id: mm.id,
    path: `/${mm.id}`,
    name: mm.title,
    type: 'mindmap',
    createdAt: Date.parse(mm.createdAt),
    updatedAt: Date.parse(mm.updatedAt),
    resourceId: mm.resourceId,
    sourceId: mm.id,
    resourceHash: hashOf(mm.id + mm.updatedAt),
    previewType: 'mindmap',
    metadata: { description: mm.description ?? null, isFavorite: mm.isFavorite, defaultView: mm.defaultView, theme: mm.theme ?? null },
  }));
}

function idFromPath(path: unknown): string {
  const raw = String(path ?? '');
  return raw.split('/').filter(Boolean).at(-1) ?? '';
}

function getNodeById(id: string) {
  const note = notes.get(id);
  if (note) return noteNode(note);
  return mindmapNodes().find((node) => node.id === id) ?? null;
}

function requireNote(path: unknown): NoteRecord {
  const note = notes.get(idFromPath(path));
  if (!note) throw new Error(tr('笔记不存在', 'Note not found'));
  return note;
}

interface ListOptions {
  typeFilter?: string;
  types?: string[];
  folderId?: string;
  isFavorite?: boolean;
  search?: string;
  tags?: string[];
  propFilters?: Array<{ key: string; value: string }>;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

function listNodes(options: ListOptions = {}, contentQuery?: string) {
  const types = options.types?.length ? options.types : options.typeFilter ? [options.typeFilter] : ['note', 'mindmap'];
  let nodes: Array<ReturnType<typeof noteNode> | ReturnType<typeof mindmapNodes>[number]> = [];
  if (types.includes('note')) nodes.push(...[...notes.values()].map(noteNode));
  if (types.includes('mindmap')) nodes.push(...mindmapNodes());
  if (options.folderId) {
    nodes = nodes.filter((node) => membership.get(`${node.type}:${node.id}`) === options.folderId);
  }
  if (options.isFavorite) nodes = nodes.filter((node) => node.metadata.isFavorite);
  if (options.tags?.length) {
    nodes = nodes.filter((node) => {
      const tags = (node.metadata as { tags?: string[] }).tags ?? [];
      return options.tags!.every((tag) => tags.includes(tag));
    });
  }
  if (options.propFilters?.length) {
    nodes = nodes.filter((node) => {
      const props = ((node.metadata as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>;
      return options.propFilters!.every((f) => String(props[f.key] ?? '') === f.value);
    });
  }
  const term = (contentQuery ?? options.search ?? '').trim().toLocaleLowerCase();
  if (term) {
    nodes = nodes.filter((node) => {
      if (node.name.toLocaleLowerCase().includes(term)) return true;
      if (contentQuery === undefined) return false;
      const body = node.type === 'note' ? notes.get(node.id)?.content : getDemoMindmapContent(node.id);
      return Boolean(body?.toLocaleLowerCase().includes(term));
    });
  }
  const sortBy = options.sortBy ?? 'updatedAt';
  const dir = options.sortOrder === 'asc' ? 1 : -1;
  nodes.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-CN') * dir;
    return ((a[sortBy] as number) - (b[sortBy] as number)) * dir;
  });
  const offset = options.offset ?? 0;
  return nodes.slice(offset, offset + (options.limit ?? 1000));
}

// ---------------------------------------------------------------------------
// 文件夹
// ---------------------------------------------------------------------------

function folderItems(folderId: string | null) {
  const items: Array<{ id: string; folderId: string | null; itemType: ItemType; itemId: string; sortOrder: number; createdAt: number }> = [];
  let order = 0;
  for (const [key, owner] of membership) {
    if (owner !== folderId) continue;
    const [itemType, itemId] = key.split(':') as [ItemType, string];
    if (itemType === 'note' ? !notes.has(itemId) : !listDemoMindmaps().some((mm) => mm.id === itemId)) continue;
    items.push({ id: `fi_${itemType}_${itemId}`, folderId, itemType, itemId, sortOrder: order++, createdAt: now0 });
  }
  return items;
}

function folderTree(parentId: string | null): unknown[] {
  return [...folders.values()]
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((folder) => ({ folder, children: folderTree(folder.id), items: folderItems(folder.id) }));
}

function deleteFolderDeep(folderId: string): void {
  for (const child of [...folders.values()].filter((f) => f.parentId === folderId)) deleteFolderDeep(child.id);
  for (const [key, owner] of [...membership]) {
    if (owner !== folderId) continue;
    const [type, id] = key.split(':');
    if (type === 'note') {
      const note = notes.get(id);
      if (note) trash.set(id, note);
      notes.delete(id);
    } else {
      deleteDemoMindmap(id);
    }
    membership.delete(key);
  }
  folders.delete(folderId);
}

function breadcrumbs(folderId: string | null) {
  const crumbs: Array<{ id: string; title: string }> = [];
  let cursor = folderId ? folders.get(folderId) : undefined;
  while (cursor) {
    crumbs.unshift({ id: cursor.id, title: cursor.title });
    cursor = cursor.parentId ? folders.get(cursor.parentId) : undefined;
  }
  return crumbs;
}

// ---------------------------------------------------------------------------
// 双链
// ---------------------------------------------------------------------------

const WIKILINK = /\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;
const encoder = new TextEncoder();

function parseLinks(content: string) {
  const links: Array<{ title: string; heading: string | null; alias: string | null; position: number }> = [];
  for (const match of content.matchAll(WIKILINK)) {
    links.push({
      title: match[1].trim(),
      heading: match[2]?.trim() ?? null,
      alias: match[3]?.trim() ?? null,
      // Rust 侧给的是 UTF-8 字节偏移
      position: encoder.encode(content.slice(0, match.index ?? 0)).length,
    });
  }
  return links;
}

function noteByTitle(title: string): NoteRecord | undefined {
  const lower = title.toLocaleLowerCase();
  for (const note of notes.values()) if (note.title.toLocaleLowerCase() === lower) return note;
  return undefined;
}

function backlinks(noteId: string) {
  const target = notes.get(noteId);
  if (!target) return [];
  const rows = [];
  for (const source of notes.values()) {
    if (source.id === noteId) continue;
    for (const link of parseLinks(source.content)) {
      if (noteByTitle(link.title)?.id !== noteId) continue;
      rows.push({
        sourceId: source.id,
        sourceTitle: source.title,
        heading: link.heading,
        alias: link.alias,
        position: link.position,
        sourceUpdatedAt: new Date(source.updatedAt).toISOString(),
      });
    }
  }
  return rows;
}

function outgoing(noteId: string) {
  const note = notes.get(noteId);
  if (!note) return [];
  return parseLinks(note.content).map((link) => {
    const target = noteByTitle(link.title);
    return {
      targetId: target?.id ?? null,
      targetTitle: link.title,
      heading: link.heading,
      alias: link.alias,
      position: link.position,
      linkType: 'wikilink',
      resolved: Boolean(target),
    };
  });
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

function touch(note: NoteRecord): void {
  note.updatedAt = Math.max(Date.now(), note.updatedAt + 1);
}

function createNote(title: string, content: string, folderId?: string | null, props?: Record<string, unknown>, tags?: string[]): NoteRecord {
  const id = `note_demo_new_${Date.now().toString(36)}${++seq}`;
  const note: NoteRecord = {
    id,
    title,
    content,
    tags: tags ?? [],
    props: props ?? {},
    isFavorite: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  notes.set(id, note);
  if (folderId) membership.set(`note:${id}`, folderId);
  return note;
}

const DESKTOP_ONLY = () => new Error(tr('演示里不能读写本地文件，请在桌面版中使用。', 'Local files are available in the desktop app.'));

export function handleDemoNotes(cmd: string, args: DemoArgs): unknown {
  if (cmd === 'vfs_create_mindmap') {
    // 由笔记生成的导图建在笔记所在文件夹
    const params = (args.params ?? {}) as { title?: string; content?: string; folderId?: string };
    const mm = createDemoMindmap(params.title || tr('未命名导图', 'Untitled mind map'), params.content);
    if (params.folderId && folders.has(params.folderId)) membership.set(`mindmap:${mm.id}`, params.folderId);
    return mm;
  }
  const mindmapResult = handleDemoMindmaps(cmd, args);
  if (mindmapResult !== undefined) return mindmapResult;

  switch (cmd) {
    // ---------- DSTU 资源 ----------
    case 'dstu_list':
      return listNodes((args.options ?? {}) as ListOptions);
    case 'dstu_search':
      return listNodes((args.options ?? {}) as ListOptions, String(args.query ?? ''));
    case 'dstu_search_in_folder':
      return listNodes({ ...((args.options ?? {}) as ListOptions), folderId: String(args.folderId ?? '') }, String(args.query ?? ''));
    case 'dstu_get':
      return getNodeById(idFromPath(args.path));
    case 'dstu_get_resource_by_path':
      return getNodeById(idFromPath(args.path));
    case 'dstu_get_path_by_id':
      return `/${String(args.id ?? args.resourceId ?? args.sourceId ?? '')}`;
    case 'dstu_get_content': {
      const id = idFromPath(args.path);
      const note = notes.get(id);
      if (note) return note.content;
      const mm = getDemoMindmapContent(id);
      if (mm !== null) return mm;
      throw new Error(tr('资源不存在', 'Resource not found'));
    }
    case 'dstu_update': {
      const note = requireNote(args.path);
      const expected = args.expectedUpdatedAtMs;
      if (typeof expected === 'number' && expected < note.updatedAt) {
        // 演示里只有本窗口在写：基线落后就直接以最新为准，不制造冲突
      }
      note.content = String(args.content ?? '');
      touch(note);
      pushVersion(note, 'edit');
      return noteNode(note);
    }
    case 'notes_update': {
      const payload = (args.note ?? {}) as { id?: string; content_md?: string };
      const note = notes.get(String(payload.id ?? ''));
      if (!note) throw new Error(tr('笔记不存在', 'Note not found'));
      if (typeof payload.content_md === 'string') note.content = payload.content_md;
      touch(note);
      pushVersion(note, 'edit');
      return { id: note.id, updated_at: new Date(note.updatedAt).toISOString() };
    }
    case 'dstu_create': {
      const options = (args.options ?? {}) as { type?: string; name?: string; content?: string; folderId?: string; metadata?: Record<string, unknown> };
      const folderId = options.folderId ?? (args.folderId as string | undefined) ?? null;
      if (options.type === 'mindmap') {
        const mm = createDemoMindmap(options.name || tr('未命名导图', 'Untitled mind map'), options.content);
        if (folderId) membership.set(`mindmap:${mm.id}`, folderId);
        return getNodeById(mm.id);
      }
      if (options.type && options.type !== 'note') throw DESKTOP_ONLY();
      const meta = options.metadata ?? {};
      const note = createNote(
        options.name || tr('未命名笔记', 'Untitled note'),
        options.content ?? '',
        folderId,
        (meta.props as Record<string, unknown>) ?? undefined,
        Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
      );
      return noteNode(note);
    }
    case 'dstu_rename': {
      const id = idFromPath(args.path);
      const name = String(args.newName ?? '').trim();
      const note = notes.get(id);
      if (note) {
        note.title = name;
        touch(note);
        return noteNode(note);
      }
      if (renameDemoMindmap(id, name)) return getNodeById(id);
      throw new Error(tr('资源不存在', 'Resource not found'));
    }
    case 'dstu_set_metadata': {
      const id = idFromPath(args.path);
      const note = notes.get(id);
      const metadata = (args.metadata ?? {}) as Record<string, unknown>;
      if (note) {
        if (typeof metadata.title === 'string') note.title = metadata.title;
        if (Array.isArray(metadata.tags)) note.tags = metadata.tags.map(String);
        if (metadata.props && typeof metadata.props === 'object') note.props = { ...(metadata.props as Record<string, unknown>) };
        if (typeof metadata.isFavorite === 'boolean') note.isFavorite = metadata.isFavorite;
        touch(note);
        return null;
      }
      if (typeof metadata.title === 'string') renameDemoMindmap(id, metadata.title);
      return null;
    }
    case 'dstu_set_favorite': {
      const id = idFromPath(args.path);
      const note = notes.get(id);
      if (note) note.isFavorite = Boolean(args.favorite);
      else handleDemoMindmaps('vfs_set_mindmap_favorite', { mindmapId: id, isFavorite: args.favorite });
      return null;
    }
    case 'dstu_delete':
    case 'dstu_soft_delete': {
      const id = idFromPath(args.path);
      const note = notes.get(id);
      if (note) {
        trash.set(id, note);
        notes.delete(id);
      } else {
        deleteDemoMindmap(id);
      }
      return null;
    }
    case 'dstu_delete_many': {
      const paths = (args.paths ?? []) as string[];
      for (const path of paths) handleDemoNotes('dstu_delete', { path });
      return paths.length;
    }
    case 'dstu_restore':
    case 'dstu_trash_restore': {
      const id = idFromPath(args.path ?? args.id);
      const note = trash.get(id);
      if (!note) throw new Error(tr('回收站里没有这项', 'Not in trash'));
      trash.delete(id);
      notes.set(id, note);
      return noteNode(note);
    }
    case 'dstu_list_deleted':
    case 'dstu_list_trash':
      return [...trash.values()].map(noteNode);
    case 'dstu_purge':
    case 'dstu_permanently_delete':
      trash.delete(idFromPath(args.path ?? args.id));
      return null;
    case 'dstu_purge_all':
    case 'dstu_empty_trash': {
      const count = trash.size;
      trash.clear();
      return count;
    }
    case 'dstu_move_to_folder':
    case 'dstu_move': {
      const id = idFromPath(args.src ?? args.path);
      const node = getNodeById(id);
      const folderId = String(args.folderId ?? idFromPath(args.dst) ?? '');
      if (node && folders.has(folderId)) membership.set(`${node.type}:${id}`, folderId);
      return node;
    }
    case 'dstu_export_formats':
      return ['markdown'];
    case 'dstu_export':
    case 'notes_import_markdown':
    case 'notes_import_markdown_batch':
      throw DESKTOP_ONLY();

    // ---------- 文件夹 ----------
    case 'dstu_folder_list':
      return [...folders.values()];
    case 'dstu_folder_get_tree':
      return folderTree(null);
    case 'dstu_folder_get':
      return folders.get(String(args.folderId ?? '')) ?? null;
    case 'dstu_folder_get_items':
      return folderItems((args.folderId as string | null) ?? null);
    case 'dstu_folder_get_breadcrumbs':
      return breadcrumbs((args.folderId as string | null) ?? null);
    case 'dstu_folder_create': {
      const id = `fd_demo_${Date.now().toString(36)}${++seq}`;
      const folder: FolderRecord = {
        id,
        parentId: (args.parentId as string | null) ?? null,
        title: String(args.title ?? tr('新建文件夹', 'New folder')),
        isExpanded: true,
        sortOrder: folders.size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      folders.set(id, folder);
      return folder;
    }
    case 'dstu_folder_rename': {
      const folder = folders.get(String(args.folderId ?? ''));
      if (folder) Object.assign(folder, { title: String(args.title ?? folder.title), updatedAt: Date.now() });
      return null;
    }
    case 'dstu_folder_delete':
      deleteFolderDeep(String(args.folderId ?? ''));
      return null;
    case 'dstu_folder_move': {
      const folder = folders.get(String(args.folderId ?? ''));
      if (folder) folder.parentId = (args.newParentId as string | null) ?? null;
      return null;
    }
    case 'dstu_folder_set_expanded': {
      const folder = folders.get(String(args.folderId ?? ''));
      if (folder) folder.isExpanded = Boolean(args.isExpanded);
      return null;
    }
    case 'dstu_folder_add_item':
    case 'dstu_folder_move_item': {
      const key = `${String(args.itemType)}:${String(args.itemId)}`;
      const folderId = (args.newFolderId ?? args.folderId ?? null) as string | null;
      if (folderId) membership.set(key, folderId);
      else membership.delete(key);
      return cmd === 'dstu_folder_add_item'
        ? { id: `fi_${key}`, folderId, itemType: args.itemType, itemId: args.itemId, sortOrder: 0, createdAt: Date.now() }
        : null;
    }
    case 'dstu_folder_remove_item':
      membership.delete(`${String(args.itemType)}:${String(args.itemId)}`);
      return null;
    case 'dstu_folder_reorder':
    case 'dstu_folder_reorder_items':
      return null;

    // ---------- 标签 / 双链 ----------
    case 'notes_list_tags': {
      const tags = new Set<string>();
      for (const note of notes.values()) note.tags.forEach((tag) => tags.add(tag));
      return [...tags];
    }
    case 'notes_get_backlinks':
      return backlinks(String(args.noteId ?? ''));
    case 'notes_get_outgoing_links':
      return outgoing(String(args.noteId ?? ''));
    case 'notes_list_referencing_resource':
      return [];
    case 'notes_relation_list':
      return [];
    case 'notes_get_format': {
      const note = notes.get(String(args.noteId ?? ''));
      return {
        note_id: String(args.noteId ?? ''),
        content_format: 'markdown-legacy',
        format_version: 1,
        serializer_version: 'markdown-v1',
        required_capabilities: [],
        updated_at: new Date(note?.updatedAt ?? Date.now()).toISOString(),
      };
    }

    // ---------- 编辑器偏好 / 草稿 / 多窗口租约 ----------
    case 'notes_get_pref':
      return prefs.get(String(args.key ?? '')) ?? null;
    case 'notes_set_pref':
      prefs.set(String(args.key ?? ''), args.value);
      return true;
    case 'notes_state_list':
      return [];
    case 'notes_state_put':
    case 'notes_state_delete':
      return null;

    // ---------- 历史版本 ----------
    case 'notes_history_list': {
      const list = history.get(String(args.noteId ?? '')) ?? [];
      const filtered = args.pinnedOnly ? list.filter((v) => v.pinned) : list;
      return { items: filtered.map(summary), next_cursor: null };
    }
    case 'notes_history_get': {
      const version = (history.get(String(args.noteId ?? '')) ?? []).find((v) => v.version_id === args.versionId);
      if (!version) throw new Error(tr('版本不存在', 'Version not found'));
      return {
        ...summary(version),
        content_md: version.content_md,
        tags: version.tags,
        props: null,
        asset_refs: [],
        content_format: 'markdown-legacy',
        format_version: 1,
        serializer_version: 'markdown-v1',
      };
    }
    case 'notes_history_set_pinned': {
      const version = (history.get(String(args.noteId ?? '')) ?? []).find((v) => v.version_id === args.versionId);
      if (!version) throw new Error(tr('版本不存在', 'Version not found'));
      version.pinned = Boolean(args.pinned);
      return summary(version);
    }
    case 'notes_history_current': {
      const note = notes.get(String(args.noteId ?? ''));
      if (!note) throw new Error(tr('笔记不存在', 'Note not found'));
      return { content_md: note.content, updated_at: new Date(note.updatedAt).toISOString(), title: note.title };
    }
    case 'notes_history_restore_copy':
    case 'notes_history_restore_selection_copy': {
      const source = notes.get(String(args.noteId ?? ''));
      const version = (history.get(String(args.noteId ?? '')) ?? []).find((v) => v.version_id === args.versionId);
      if (!source || !version) throw new Error(tr('版本不存在', 'Version not found'));
      const selection = args.selection as { start_line: number; end_line: number } | undefined;
      const body = selection
        ? version.content_md.split('\n').slice(selection.start_line - 1, selection.end_line).join('\n')
        : version.content_md;
      const copy = createNote(tr(`${source.title}（恢复的副本）`, `${source.title} (restored copy)`), body, null, { ...source.props }, [...source.tags]);
      pushVersion(copy, 'restore_copy', Date.now(), body, { restored_from_version_id: version.version_id });
      return noteNode(copy);
    }
    case 'notes_history_restore_current': {
      const note = notes.get(String(args.noteId ?? ''));
      const version = (history.get(String(args.noteId ?? '')) ?? []).find((v) => v.version_id === args.versionId);
      if (!note || !version) throw new Error(tr('版本不存在', 'Version not found'));
      pushVersion(note, 'before_restore', Date.now(), note.content, { pinned: true });
      const selection = args.selection as { start_line: number; end_line: number } | null | undefined;
      note.content = selection
        ? version.content_md.split('\n').slice(selection.start_line - 1, selection.end_line).join('\n')
        : version.content_md;
      touch(note);
      pushVersion(note, 'edit', Date.now() + 1, note.content, { restored_from_version_id: version.version_id, source: 'edit' });
      return noteNode(note);
    }
    case 'notes_history_get_retention':
    case 'notes_history_set_retention':
      return (args.policy as unknown) ?? { edit_bucket_seconds: 300, max_edit_versions: null };

    // ---------- 需要模型 / 桌面能力 ----------
    case 'start_enhanced_document_processing':
      throw new Error(tr('生成卡片要调用你配置的模型，演示里没有连接模型，请在桌面版中使用。', 'Generating cards calls your configured model. Please use the desktop app.'));
    case 'quick_assistant_show':
      throw new Error(tr('助手小窗是桌面版的独立窗口，请在桌面版中使用。', 'The assistant window is available in the desktop app.'));

    // 跨窗口编辑租约：演示只有一个窗口，租约一发即就绪、无人需要等待
    case 'notes_editor_register':
    case 'notes_editor_heartbeat':
      return { participant_id: String(args.participantId ?? `pt_demo_${++seq}`), expires_at: Math.floor(Date.now() / 1000) + 60, active_lease: null };
    case 'notes_editor_unregister':
    case 'notes_editor_refresh_ack':
      return null;
    case 'notes_editor_begin': {
      const token = `lease_demo_${++seq}`;
      const noteIds = ((args.noteIds ?? []) as string[]).map(String);
      const status = {
        token,
        operation_id: String(args.operationId ?? token),
        owner_id: String(args.participantId ?? ''),
        phase: 'ready',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        notes: noteIds.map((id) => ({ note_id: id, updated_at: new Date(notes.get(id)?.updatedAt ?? Date.now()).toISOString() })),
        waiting_for: [] as string[],
      };
      leases.set(token, status);
      return status;
    }
    case 'notes_editor_lease_status':
      return leases.get(String(args.token ?? '')) ?? null;
    case 'notes_editor_finish': {
      const token = String((args.lease as { token?: string } | undefined)?.token ?? '');
      const status = leases.get(token);
      if (status) status.phase = 'finished';
      return status ?? null;
    }
    case 'notes_editor_freeze_ack': {
      const draft = args.draft as { markdown?: string } | null | undefined;
      const token = String((args.lease as { token?: string } | undefined)?.token ?? '');
      if (draft && typeof draft.markdown === 'string') leaseDrafts.set(token, draft.markdown);
      return null;
    }
    case 'notes_editor_flush': {
      const token = String((args.lease as { token?: string } | undefined)?.token ?? '');
      const note = notes.get(String(args.noteId ?? ''));
      const draft = leaseDrafts.get(token);
      if (note && draft !== undefined) {
        note.content = draft;
        touch(note);
      }
      return note ? { id: note.id, updated_at: new Date(note.updatedAt).toISOString() } : null;
    }
    case 'notes_editor_release': {
      const token = String((args.lease as { token?: string } | undefined)?.token ?? '');
      leases.delete(token);
      leaseDrafts.delete(token);
      return null;
    }

    // ---------- 侧栏其他分区 ----------
    case 'insight_list':
      return [];
    case 'memory_get_config':
      return { memoryRootFolderId: null, memoryRootFolderTitle: null };
    default:
      return undefined;
  }
}
