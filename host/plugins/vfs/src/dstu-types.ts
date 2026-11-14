/** DSTU protocol types from dstu/types.rs. */

export type DstuNodeType =
  | 'folder'
  | 'note'
  | 'textbook'
  | 'exam'
  | 'translation'
  | 'essay'
  | 'image'
  | 'file'
  | 'retrieval'
  | 'mindmap';

export interface DstuNode {
  id: string;
  path: string;
  name: string;
  type: DstuNodeType;
  size?: number;
  createdAt: number;
  updatedAt: number;
  children?: DstuNode[];
  childCount?: number;
  resourceId?: string;
  sourceId: string;
  resourceHash?: string;
  previewType?: string;
  metadata?: unknown;
}

export interface DstuPropFilter {
  key: string;
  value: string;
}

export class DstuListOptions {
  folderId?: string;
  typeFilter?: DstuNodeType;
  isFavorite?: boolean;
  recursive?: boolean;
  types?: DstuNodeType[];
  search?: string;
  tags?: string[];
  propFilters?: DstuPropFilter[];
  sortBy?: string;
  sortOrder?: string;
  limit?: number;
  offset?: number;

  static new(): DstuListOptions { return new DstuListOptions(); }
  static from(value: Partial<DstuListOptions> | null | undefined): DstuListOptions {
    return Object.assign(new DstuListOptions(), value ?? {});
  }

  withFolderId(folderId: string): this { this.folderId = folderId; return this; }
  withTypeFilter(typeFilter: DstuNodeType): this { this.typeFilter = typeFilter; return this; }
  getFolderId(): string | undefined { return this.folderId; }
  getTypeFilter(): DstuNodeType | undefined { return this.typeFilter; }
  isFolderFirstMode(): boolean { return this.folderId !== undefined || this.typeFilter !== undefined; }
  withRecursive(recursive: boolean): this { this.recursive = recursive; return this; }
  withTypes(types: DstuNodeType[]): this { this.types = types; return this; }
  withSearch(search: string): this { this.search = search; return this; }
  withSort(sortBy: string, sortOrder: string): this { this.sortBy = sortBy; this.sortOrder = sortOrder; return this; }
  paginate(limit: number, offset: number): this { this.limit = limit; this.offset = offset; return this; }
  getLimit(): number { return this.limit ?? 50; }
  getOffset(): number { return this.offset ?? 0; }
  isRecursive(): boolean { return this.recursive ?? false; }
  isAscending(): boolean { return this.sortOrder === undefined || this.sortOrder === 'asc'; }
}

export interface DstuCreateOptions {
  type: DstuNodeType;
  name: string;
  content?: string;
  fileBase64?: string;
  stagedUploadId?: string;
  metadata?: unknown;
}

export type DstuWatchEventType = 'created' | 'updated' | 'deleted' | 'moved' | 'restored' | 'purged';

export interface DstuWatchEvent {
  type: DstuWatchEventType;
  path: string;
  oldPath?: string;
  node?: DstuNode;
}

const NODE_TYPE_ALIASES: Readonly<Record<string, DstuNodeType>> = {
  folder: 'folder', '文件夹': 'folder',
  note: 'note', notes: 'note', '笔记': 'note',
  textbook: 'textbook', textbooks: 'textbook', '教材': 'textbook',
  exam: 'exam', exams: 'exam', '题目集': 'exam', '试卷': 'exam',
  translation: 'translation', translations: 'translation', '翻译': 'translation',
  essay: 'essay', essays: 'essay', '作文': 'essay', '作文批改': 'essay',
  image: 'image', images: 'image', '图片': 'image',
  file: 'file', files: 'file', '文件': 'file',
  retrieval: 'retrieval', retrievals: 'retrieval', '检索': 'retrieval', '检索结果': 'retrieval',
  mindmap: 'mindmap', mindmaps: 'mindmap', '知识导图': 'mindmap', '导图': 'mindmap',
  attachment: 'image', attachments: 'image', '附件': 'image',
};

export function dstuNodeTypeFromString(value: string): DstuNodeType | undefined {
  return NODE_TYPE_ALIASES[value.toLowerCase()];
}

export function dstuNodeTypeToPathSegment(type: DstuNodeType): string {
  switch (type) {
    case 'folder': return 'folders';
    case 'note': return 'notes';
    case 'textbook': return 'textbooks';
    case 'exam': return 'exams';
    case 'translation': return 'translations';
    case 'essay': return 'essays';
    case 'image': return 'images';
    case 'file': return 'files';
    case 'retrieval': return 'retrievals';
    case 'mindmap': return 'mindmaps';
  }
}

export function dstuNodeTypeDisplayNameKey(type: DstuNodeType): string {
  return `dstu:types.${type}`;
}

export function dstuNodeTypePreviewType(type: DstuNodeType): string {
  switch (type) {
    case 'folder': return 'none';
    case 'note':
    case 'translation':
    case 'essay':
    case 'retrieval':
      return 'markdown';
    case 'textbook': return 'pdf';
    case 'exam': return 'exam';
    case 'image': return 'image';
    case 'file': return 'none';
    case 'mindmap': return 'mindmap';
  }
}

export function inferDstuResourceType(id: string): string | undefined {
  if (id.startsWith('note_')) return 'note';
  if (id.startsWith('file_') || id.startsWith('tb_') || id.startsWith('att_')) return 'file';
  if (id.startsWith('exam_')) return 'exam';
  if (id.startsWith('tr_')) return 'translation';
  if (id.startsWith('essay_session_') || id.startsWith('essay_')) return 'essay';
  if (id.startsWith('fld_')) return 'folder';
  if (id.startsWith('mm_')) return 'mindmap';
  return undefined;
}

export function createFolderNode(id: string, path: string, name: string): DstuNode {
  const now = Date.now();
  return { id, sourceId: id, path, name, type: 'folder', createdAt: now, updatedAt: now, previewType: 'none' };
}

export function createResourceNode(
  id: string,
  path: string,
  name: string,
  type: DstuNodeType,
  resourceId: string,
): DstuNode {
  const now = Date.now();
  return {
    id,
    sourceId: id,
    path,
    name,
    type,
    createdAt: now,
    updatedAt: now,
    resourceId,
    previewType: dstuNodeTypePreviewType(type),
  };
}

export function withNodeSize(node: DstuNode, size: number): DstuNode { return { ...node, size }; }
export function withNodeTimestamps(node: DstuNode, createdAt: number, updatedAt: number): DstuNode {
  return { ...node, createdAt, updatedAt };
}
export function withNodeChildren(node: DstuNode, children: DstuNode[]): DstuNode {
  return { ...node, children, childCount: children.length };
}
export function withNodeChildCount(node: DstuNode, count: number): DstuNode { return { ...node, childCount: count }; }
export function withNodeMetadata(node: DstuNode, metadata: unknown): DstuNode { return { ...node, metadata }; }
export function withNodeResourceHash(node: DstuNode, hash: string): DstuNode { return { ...node, resourceHash: hash }; }
export function withNodePreviewType(node: DstuNode, previewType: string): DstuNode { return { ...node, previewType }; }

export function createNoteOptions(name: string, content: string): DstuCreateOptions {
  return { type: 'note', name, content };
}
export function createFolderOptions(name: string): DstuCreateOptions {
  return { type: 'folder', name };
}
export function createFileOptions(name: string, fileBase64: string, type: DstuNodeType): DstuCreateOptions {
  return { type, name, fileBase64 };
}
export function withCreateOptionsMetadata(options: DstuCreateOptions, metadata: unknown): DstuCreateOptions {
  return { ...options, metadata };
}

export function createdEvent(path: string, node: DstuNode): DstuWatchEvent {
  return { type: 'created', path, node };
}
export function updatedEvent(path: string, node: DstuNode): DstuWatchEvent {
  return { type: 'updated', path, node };
}
export function deletedEvent(path: string): DstuWatchEvent {
  return { type: 'deleted', path };
}
export function movedEvent(oldPath: string, newPath: string, node: DstuNode): DstuWatchEvent {
  return { type: 'moved', path: newPath, oldPath, node };
}
export function restoredEvent(path: string, node?: DstuNode): DstuWatchEvent {
  return { type: 'restored', path, ...(node === undefined ? {} : { node }) };
}
export function purgedEvent(path: string): DstuWatchEvent {
  return { type: 'purged', path };
}
