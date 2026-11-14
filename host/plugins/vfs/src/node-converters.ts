/** dstu/handler_utils/node_converters.rs: VFS records to DSTU protocol nodes. */
import { rustTrim } from '../../../platform/util/portable.ts';
import { parseRfc3339, parseNaiveDateTime } from '../../../platform/time/index.ts';
import { vfsRepositoryLog } from '../repository/services.ts';
import type {
  DstuNode,
  DstuNodeType,
} from './dstu-types.ts';
import {
  createFolderNode,
  createResourceNode,
  withNodeMetadata,
  withNodePreviewType,
  withNodeSize,
  withNodeTimestamps,
} from './dstu-types.ts';
import type { PreviewType } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type {
  VfsAttachment,
  VfsEssay,
  VfsExamSheet,
  VfsFile,
  VfsMindMap,
  VfsTextbook,
  VfsTranslation,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';
import { buildSimpleResourcePath } from './paths.ts';
import { nanoid } from './nanoid.ts';

/** The subset of `VfsEssaySession` consumed by `session_to_dstu_node`. */
export interface VfsEssaySession {
  id: string;
  title: string;
  essayType?: string | null;
  gradeLevel?: string | null;
  customPrompt?: string | null;
  totalRounds: number;
  latestScore?: number | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

const PREVIEW_EXTENSIONS: Readonly<Record<string, PreviewType>> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  xls: 'text',
  ods: 'text',
  xlsb: 'text',
  pptx: 'pptx',
  epub: 'epub',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',
  wma: 'audio',
  opus: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  m4v: 'video',
  wmv: 'video',
  flv: 'video',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  html: 'text',
  htm: 'text',
  csv: 'text',
  json: 'text',
  xml: 'text',
  rtf: 'text',
};

/** `PreviewType::from_extension` (vfs/types.rs:2135-2161). */
export function previewTypeFromExtension(extension: string): PreviewType {
  return PREVIEW_EXTENSIONS[extension.toLowerCase()] ?? 'none';
}

/** `PreviewType::from_filename` (vfs/types.rs:2164-2170). */
export function previewTypeFromFilename(filename: string): PreviewType {
  const dot = filename.lastIndexOf('.');
  return previewTypeFromExtension(dot === -1 ? filename : filename.slice(dot + 1));
}

/** `parse_timestamp` (node_converters.rs:52-101). */
export function parseTimestamp(value: string): number {
  const trimmed = rustTrim(value);
  if (trimmed === '') return Date.now();

  const rfc = parseRfc3339(trimmed);
  if (rfc !== null) return rfc.millis;
  if (trimmed.includes(' ')) {
    const sql = parseNaiveDateTime(trimmed) ?? parseRfc3339(`${trimmed}Z`);
    if (sql !== null) return sql.millis;
  }

  if (/^[+-]?\d+$/.test(trimmed)) {
    const raw = BigInt(trimmed);
    const millis = raw < 0n && raw > -100_000_000_000n || raw >= 0n && raw < 100_000_000_000n
      ? raw * 1000n
      : raw;
    return Number(millis);
  }

  const now = Date.now();
  vfsRepositoryLog()?.warn("[DSTU::node_converters] Failed to parse timestamp '%s', fallback to now: %s", value, now);
  return now;
}

/** `is_opaque_document_id` (dstu-storage/src/unified_file_manager.rs:991-1004). */
export function isOpaqueDocumentId(name: string): boolean {
  const colon = name.indexOf(':');
  if (colon !== -1) {
    const after = name.slice(colon + 1);
    if (after !== '' && /^\d+$/.test(after)) return true;
  }
  return name !== '' && /^\d+$/.test(name);
}

function formatUtcTimestamp(millis: number): string {
  const date = new Date(millis);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** `sanitize_textbook_display_name` (node_converters.rs:28-50). */
export function sanitizeTextbookDisplayName(fileName: string, createdAt: string): string {
  const trimmed = rustTrim(fileName);
  const dot = trimmed.lastIndexOf('.');
  const split = dot > 0 && dot < trimmed.length - 1;
  const base = split ? trimmed.slice(0, dot) : trimmed;
  const extension = split ? trimmed.slice(dot) : '';

  if (base === '文件' || isOpaqueDocumentId(base)) {
    const timestamp = parseTimestamp(createdAt);
    const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
    const safe = Number.isNaN(date.getTime()) ? new Date() : date;
    return `导入文档_${formatUtcTimestamp(safe.getTime())}${extension}`;
  }
  return fileName;
}

const TYPE_FOLDER_NAMES: Readonly<Record<DstuNodeType, string>> = {
  note: '笔记',
  textbook: '教材',
  exam: '题目集',
  translation: '翻译',
  essay: '作文',
  image: '图片',
  file: '文件',
  folder: '文件夹',
  retrieval: '检索结果',
  mindmap: '知识导图',
};

const TYPE_PATH_SEGMENTS: Readonly<Record<DstuNodeType, string>> = {
  note: 'notes',
  textbook: 'textbooks',
  exam: 'exams',
  translation: 'translations',
  essay: 'essays',
  image: 'images',
  file: 'files',
  folder: 'folders',
  retrieval: 'retrievals',
  mindmap: 'mindmaps',
};

/** `create_type_folder` (node_converters.rs:104-133). */
export function createTypeFolder(nodeType: DstuNodeType): DstuNode {
  const segment = TYPE_PATH_SEGMENTS[nodeType];
  return createFolderNode(`type_${segment}`, `/${segment}`, TYPE_FOLDER_NAMES[nodeType]);
}

const RESOURCE_ID_PREFIXES: Readonly<Record<DstuNodeType, string>> = {
  note: 'note',
  textbook: 'tb',
  exam: 'exam',
  translation: 'tr',
  essay: 'essay',
  image: 'img',
  file: 'file',
  folder: 'folder',
  retrieval: 'ret',
  mindmap: 'mm',
};

/** `generate_resource_id` (node_converters.rs:136-150). */
export function generateResourceId(nodeType: DstuNodeType): string {
  return `${RESOURCE_ID_PREFIXES[nodeType]}_${nanoid(10)}`;
}

/** `item_type_to_dstu_node_type` (node_converters.rs:164-178). */
export function itemTypeToDstuNodeType(itemType: string): DstuNodeType | undefined {
  switch (itemType) {
    case 'note': return 'note';
    case 'textbook': return 'textbook';
    case 'exam': return 'exam';
    case 'translation': return 'translation';
    case 'essay': return 'essay';
    case 'image': return 'image';
    case 'file': return 'file';
    case 'folder': return 'folder';
    case 'mindmap': return 'mindmap';
    default: return undefined;
  }
}

function resourceNode(
  id: string,
  name: string,
  type: DstuNodeType,
  resourceId: string,
  createdAt: string,
  updatedAt: string,
): DstuNode {
  return withNodeTimestamps(
    createResourceNode(id, buildSimpleResourcePath(id), name, type, resourceId),
    parseTimestamp(createdAt),
    parseTimestamp(updatedAt),
  );
}

/** `note_to_dstu_node` (node_converters.rs:183-204). */
export function noteToDstuNode(note: VfsNote): DstuNode {
  const node = resourceNode(note.id, note.title, 'note', note.resourceId, note.createdAt, note.updatedAt);
  return withNodeMetadata(node, {
    isFavorite: note.isFavorite,
    tags: note.tags,
    props: note.props ?? {},
  });
}

/** `textbook_to_dstu_node` (node_converters.rs:218-265). */
export function textbookToDstuNode(textbook: VfsTextbook): DstuNode {
  const resourceId = textbook.resourceId ?? `res_${textbook.id}`;
  const displayName = sanitizeTextbookDisplayName(textbook.fileName, textbook.createdAt);
  const node = withNodeSize(
    resourceNode(textbook.id, displayName, 'textbook', resourceId, textbook.createdAt, textbook.updatedAt),
    textbook.size,
  );
  return withNodeMetadata(withNodePreviewType(node, previewTypeFromFilename(textbook.fileName)), {
    filePath: textbook.originalPath ?? null,
    isFavorite: textbook.isFavorite,
    pageCount: textbook.pageCount ?? null,
    readingProgress: textbook.lastPage === undefined || textbook.lastPage === null
      ? null
      : { page: textbook.lastPage },
    bookmarks: textbook.bookmarks,
    highlights: textbook.highlights,
    annotationRevision: textbook.updatedAt,
  });
}

function parseUpdatedAtOr(updatedAt: string | null | undefined, fallback: number): number {
  if (updatedAt === undefined || updatedAt === null) return fallback;
  return parseRfc3339(updatedAt)?.millis ?? fallback;
}

/** `translation_to_dstu_node` (node_converters.rs:268-305). */
export function translationToDstuNode(translation: VfsTranslation): DstuNode {
  const createdAt = parseTimestamp(translation.createdAt);
  const updatedAt = parseUpdatedAtOr(translation.updatedAt, createdAt);
  const name = translation.title ?? translation.id;
  const node = withNodeTimestamps(
    createResourceNode(
      translation.id,
      buildSimpleResourcePath(translation.id),
      name,
      'translation',
      translation.resourceId,
    ),
    createdAt,
    updatedAt,
  );
  return withNodeMetadata(node, {
    srcLang: translation.srcLang,
    tgtLang: translation.tgtLang,
    engine: translation.engine ?? null,
    model: translation.model ?? null,
    isFavorite: translation.isFavorite,
    qualityRating: translation.qualityRating ?? null,
    title: translation.title ?? null,
    sourceText: translation.sourceText ?? null,
    translatedText: translation.translatedText ?? null,
  });
}

/** `exam_to_dstu_node` (node_converters.rs:308-332). */
export function examToDstuNode(exam: VfsExamSheet): DstuNode {
  const resourceId = exam.resourceId ?? `res_${exam.id}`;
  const name = exam.examName ?? exam.id;
  const node = resourceNode(exam.id, name, 'exam', resourceId, exam.createdAt, exam.updatedAt);
  return withNodeMetadata(node, {
    status: exam.status,
    tempId: exam.tempId,
    linkedMistakeIds: exam.linkedMistakeIds ?? null,
    isFavorite: exam.isFavorite,
  });
}

/** `essay_to_dstu_node` (node_converters.rs:335-360). */
export function essayToDstuNode(essay: VfsEssay): DstuNode {
  const name = essay.title ?? '未命名作文';
  const node = resourceNode(essay.id, name, 'essay', essay.resourceId, essay.createdAt, essay.updatedAt);
  return withNodeMetadata(node, {
    essayType: essay.essayType ?? null,
    score: essay.score ?? null,
    gradingResult: essay.gradingResult ?? null,
    isFavorite: essay.isFavorite,
  });
}

/** `session_to_dstu_node` (node_converters.rs:363-387). */
export function sessionToDstuNode(session: VfsEssaySession): DstuNode {
  const node = resourceNode(
    session.id, session.title, 'essay', session.id, session.createdAt, session.updatedAt,
  );
  return withNodeMetadata(node, {
    essayType: session.essayType ?? null,
    gradeLevel: session.gradeLevel ?? null,
    totalRounds: session.totalRounds,
    latestScore: session.latestScore ?? null,
    isFavorite: session.isFavorite,
  });
}

/** `attachment_to_dstu_node` (node_converters.rs:390-418). */
export function attachmentToDstuNode(attachment: VfsAttachment): DstuNode {
  const nodeType: DstuNodeType = attachment.type === 'image' ? 'image' : 'file';
  const node = resourceNode(
    attachment.id,
    attachment.name,
    nodeType,
    attachment.contentHash,
    attachment.createdAt,
    attachment.updatedAt,
  );
  return withNodeMetadata(node, {
    mimeType: attachment.mimeType,
    size: attachment.size,
    contentHash: attachment.contentHash,
    isFavorite: attachment.isFavorite,
  });
}

/** `mindmap_to_dstu_node` (node_converters.rs:421-441). */
export function mindmapToDstuNode(mindmap: VfsMindMap): DstuNode {
  const node = resourceNode(
    mindmap.id, mindmap.title, 'mindmap', mindmap.resourceId, mindmap.createdAt, mindmap.updatedAt,
  );
  return withNodeMetadata(node, {
    description: mindmap.description ?? null,
    isFavorite: mindmap.isFavorite,
    defaultView: mindmap.defaultView,
    theme: mindmap.theme ?? null,
  });
}

/** `file_to_dstu_node` (node_converters.rs:443-485). */
export function fileToDstuNode(file: VfsFile): DstuNode {
  const isPdf = (file.mimeType !== undefined && file.mimeType !== null && file.mimeType.includes('pdf'))
    || file.fileName.toLowerCase().endsWith('.pdf');
  const nodeType: DstuNodeType = isPdf ? 'textbook' : file.fileType === 'image' ? 'image' : 'file';
  const displayName = sanitizeTextbookDisplayName(file.fileName, file.createdAt);
  const node = withNodeSize(
    resourceNode(file.id, displayName, nodeType, file.sha256, file.createdAt, file.updatedAt),
    file.size,
  );
  return withNodeMetadata(withNodePreviewType(node, previewTypeFromFilename(file.fileName)), {
    filePath: file.originalPath ?? null,
    mimeType: file.mimeType ?? null,
    size: file.size,
    fileType: file.fileType,
    sha256: file.sha256,
    contentHash: file.sha256,
    isFavorite: file.isFavorite,
    pageCount: file.pageCount ?? null,
    readingProgress: file.lastPage === undefined || file.lastPage === null
      ? null
      : { page: file.lastPage },
    bookmarks: file.bookmarks,
  });
}
