/** dstu/handlers.rs `dstu_create` (handlers.rs:727-1437). */
const randomUUID = () => globalThis.crypto.randomUUID();
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { toBase64, fromBase64 } from '../../../platform/crypto/encoding.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import type { DstuCreateOptions, DstuNode } from '../api.ts';
import { DstuFailure } from './dstu-error.ts';
import {
  createResourceNode,
  createdEvent,
  dstuNodeTypeFromString,
  withNodeMetadata,
  type DstuNodeType,
} from './dstu-types.ts';
import {
  examToDstuNode,
  fileToDstuNode,
  mindmapToDstuNode,
  noteToDstuNode,
  translationToDstuNode,
} from './node-converters.ts';
import { emitDstuWatchEvent } from './locations.ts';
import {
  createEssaySessionInFolderWithConn,
  createExamSheetInFolderWithConn,
  createFileInFolderWithConn,
  createMindmapInFolderWithConn,
  createNoteInFolderWithConn,
  createTranslationInFolderWithConn,
  setTranslationFavoriteWithConn,
  setTranslationQualityRatingWithConn,
  storeBlobWithConn,
} from '../repository/create.ts';
import type { StagedFile } from '../../../platform/storage/staged-upload.ts';
import { fs } from './local-runtime.ts';

const MAX_NAME_LENGTH = 256;
const MAX_CONTENT_SIZE = 1024 * 1024;
const MAX_METADATA_SIZE = 64 * 1024;
const MAX_IMAGE_SIZE = 50 * 1024 * 1024;
const MAX_FILE_SIZE = 200 * 1024 * 1024;

export interface DstuCreateDeps {
  readonly database: VfsDatabase;
  readonly log: { warn(message: string, ...args: unknown[]): void };
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(2);
}

function nodeTypeOf(value: DstuCreateOptions['type']): DstuNodeType | undefined {
  if (typeof value === 'string') return dstuNodeTypeFromString(value);
  const key = Object.keys(value as unknown as Record<string, unknown>)[0];
  return key === undefined ? undefined : dstuNodeTypeFromString(key);
}

function debugName(value: DstuNodeType | undefined): string {
  if (value === undefined) return 'Unknown';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function metadataObject(metadata: unknown): Record<string, unknown> {
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function uint8ToBase64(data: Uint8Array): string {
  return toBase64(data);
}

/** Rust base64 STANDARD decode; Buffer is lenient so the payload is re-encoded. */
export function decodeBase64(input: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    const index = [...input].findIndex(char => !/[A-Za-z0-9+/=]/.test(char));
    const code = input.charCodeAt(index === -1 ? 0 : index);
    throw new Error(`Invalid symbol ${code}, offset ${index === -1 ? 0 : index}.`);
  }
  if (input.length % 4 !== 0) {
    throw new Error('Invalid padding');
  }
  let data: Uint8Array;
  try { data = fromBase64(input); }
  catch { throw new Error('Invalid byte sequence'); }
  if (uint8ToBase64(data) !== input) {
    throw new Error('Invalid byte sequence');
  }
  return new Uint8Array(data);
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/bmp': return 'bmp';
    case 'image/svg+xml': return 'svg';
    case 'application/pdf': return 'pdf';
    case 'application/epub+zip': return 'epub';
    case 'application/zip': return 'zip';
    case 'application/json': return 'json';
    case 'text/plain': return 'txt';
    case 'text/markdown': return 'md';
    case 'application/octet-stream': return 'bin';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'pptx';
    default: {
      // subtype 可能带 `+` 等字符（`epub+zip`、`octet-stream`）：这类扩展名会被
      // `filestream://` 的扩展名白名单拒绝（403），所以只接受纯字母数字的短扩展名。
      const raw = mimeType.split('/').at(-1) ?? '';
      return /^[A-Za-z0-9]{1,9}$/u.test(raw) ? raw.toLowerCase() : 'bin';
    }
  }
}

function essayNodeFromCreate(
  session: ReturnType<typeof createEssaySessionInFolderWithConn>,
  essayType: string | undefined,
  gradeLevel: string | undefined,
): DstuNode {
  const createdAt = parseRfc3339(session.createdAt)?.millis ?? 0;
  const updatedAt = parseRfc3339(session.updatedAt)?.millis ?? createdAt;
  const node = createResourceNode(
    session.id, `/${session.id}`, session.title, 'essay', session.id,
  );
  return withNodeMetadata(
    { ...node, createdAt, updatedAt, previewType: node.previewType },
    {
      essayType: essayType ?? null,
      gradeLevel: gradeLevel ?? null,
      totalRounds: session.totalRounds,
      isFavorite: session.isFavorite,
    },
  );
}

function createMedia(
  deps: DstuCreateDeps,
  resourceType: 'images' | 'files',
  options: DstuCreateOptions,
  metadata: Record<string, unknown>,
  folderId: string | undefined,
): DstuNode {
  const maxFileSize = resourceType === 'images' ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;

  let staged: ReturnType<typeof fs.takeStagedUpload> | undefined;
  const uploadId = optionalString(options.stagedUploadId);
  if (uploadId !== undefined && uploadId !== '') staged = fs.takeStagedUpload(uploadId);

  let fileData: Uint8Array;
  if (staged !== undefined) {
    try { fileData = staged.readBounded(maxFileSize); }
    finally { staged.dispose(); }
  } else {
    const fileBase64 = optionalString(options.fileBase64);
    if (fileBase64 === undefined || fileBase64 === '') {
      throw new Error('file_base64 is required for images/files creation');
    }
    const maxBase64Len = Math.ceil(maxFileSize / 3) * 4 + 16;
    if (fileBase64.length > maxBase64Len) {
      throw new Error(
        `Base64 payload exceeds limit: ${fileBase64.length} bytes (max: ${maxBase64Len} bytes)`,
      );
    }
    try { fileData = decodeBase64(fileBase64); }
    catch (error) {
      throw new Error(`Invalid base64 data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (fileData.length > maxFileSize) {
    throw new Error(`File size exceeds limit: ${fileData.length} bytes (max: ${maxFileSize} bytes)`);
  }

  const defaultMime = resourceType === 'images' ? 'image/jpeg' : 'application/octet-stream';
  const rawMime = optionalString(metadata.mimeType) ?? defaultMime;
  const mimeType = resourceType === 'images'
    ? (rawMime.startsWith('image/') ? rawMime : defaultMime)
    : (rawMime.includes('/') ? rawMime : defaultMime);
  const extension = extensionForMime(mimeType);

  const conn = deps.database.getConnSafe();
  let blob;
  try {
    blob = storeBlobWithConn(conn, deps.database.blobsDir(), fileData, mimeType, extension);
  } catch (error) {
    throw new Error(`Failed to store blob: ${error instanceof Error ? error.message : String(error)}`);
  }

  const fileType = resourceType === 'images' ? 'image' : 'file';
  const fileName = rustTrim(options.name) === '' ? `unnamed.${extension}` : options.name;
  const file = createFileInFolderWithConn(conn, {
    sha256: blob.hash,
    fileName,
    size: fileData.length,
    fileType,
    mimeType,
    blobHash: blob.hash,
    originalPath: null,
  }, folderId);
  return fileToDstuNode(file);
}

/** `dstu_create` (handlers.rs:727-1437). `path` only feeds the folderId fallback. */
export function createCommand(
  deps: DstuCreateDeps,
  path: string,
  options: DstuCreateOptions,
): DstuNode {
  return command(() => {
    if (byteLength(options.name) > MAX_NAME_LENGTH) {
      throw new Error(
        `名称长度超出限制: ${byteLength(options.name)} 字符 (最大允许: ${MAX_NAME_LENGTH} 字符)`,
      );
    }
    if (options.content !== null && options.content !== undefined) {
      const contentBytes = byteLength(options.content);
      if (contentBytes > MAX_CONTENT_SIZE) {
        throw new Error(
          `内容大小超出限制: ${contentBytes} 字节 (${formatMb(contentBytes)} MB) `
          + `(最大允许: ${MAX_CONTENT_SIZE} 字节 (${MAX_CONTENT_SIZE / (1024 * 1024)} MB))`,
        );
      }
    }
    let metadataJson: string | undefined;
    if (options.metadata !== null && options.metadata !== undefined) {
      try { metadataJson = JSON.stringify(options.metadata); }
      catch (error) {
        throw new Error(`元数据序列化失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      const metadataBytes = byteLength(metadataJson);
      if (metadataBytes > MAX_METADATA_SIZE) {
        throw new Error(
          `元数据大小超出限制: ${metadataBytes} 字节 (${formatKb(metadataBytes)} KB) `
          + `(最大允许: ${MAX_METADATA_SIZE} 字节 (${MAX_METADATA_SIZE / 1024} KB))`,
        );
      }
    }

    const metadata = metadataObject(options.metadata);
    const rawFolderId = optionalString(metadata.folderId);
    const folderIdFromMetadata = rawFolderId === undefined
      || rawFolderId === ''
      || rawFolderId === 'root'
      ? undefined
      : rawFolderId.startsWith('fld_') ? rawFolderId : undefined;
    const folderIdFromPath = folderIdFromMetadata !== undefined || path === '/'
      ? undefined
      : path.replace(/^\/+/, '').startsWith('fld_') ? path.replace(/^\/+/, '') : undefined;
    const folderId = folderIdFromMetadata ?? folderIdFromPath;

    const nodeType = nodeTypeOf(options.type);
    const resourceType = (() => {
      switch (nodeType) {
        case 'note': return 'notes';
        case 'textbook': return 'textbooks';
        case 'exam': return 'exams';
        case 'translation': return 'translations';
        case 'essay': return 'essays';
        case 'folder': return 'folders';
        case 'mindmap': return 'mindmaps';
        case 'image': return 'images';
        case 'file': return 'files';
        default: throw new Error(`Unsupported resource type: ${debugName(nodeType)}`);
      }
    })();

    const content = options.content ?? '';
    const conn = deps.database.getConnSafe();
    let node: DstuNode;

    switch (resourceType) {
      case 'notes': {
        const title = rustTrim(options.name) === '' ? 'Untitled' : options.name;
        const rawTags = metadata.tags;
        let tags: string[] = [];
        if (rawTags !== undefined && rawTags !== null) {
          if (!Array.isArray(rawTags) || !rawTags.every(tag => typeof tag === 'string')) {
            throw new Error('INVALID_ARGUMENT: metadata.tags 必须是字符串数组');
          }
          tags = rawTags as string[];
        }
        node = noteToDstuNode(createNoteInFolderWithConn(conn, { title, content, tags }, folderId));
        break;
      }
      case 'textbooks':
        throw new Error(
          'Textbook creation requires file upload, use textbooks_add or vfs_upload_file instead',
        );
      case 'translations': {
        const title = rustTrim(options.name) === '' ? null : options.name;
        const translation = createTranslationInFolderWithConn(conn, {
          title,
          source: optionalString(metadata.sourceText) ?? '',
          translated: optionalString(metadata.translatedText) ?? '',
          srcLang: optionalString(metadata.srcLang) ?? 'auto',
          tgtLang: optionalString(metadata.tgtLang) ?? 'en',
        }, folderId);
        if (metadata.isFavorite === true) {
          setTranslationFavoriteWithConn(conn, translation.id, true);
        }
        const rating = asInteger(metadata.qualityRating);
        if (rating !== undefined) {
          setTranslationQualityRatingWithConn(conn, translation.id, rating);
        }
        node = translationToDstuNode(translation);
        break;
      }
      case 'essays': {
        const essayType = optionalString(metadata.essayType);
        const gradeLevel = optionalString(metadata.gradeLevel);
        const session = createEssaySessionInFolderWithConn(conn, {
          title: options.name,
          essayType: essayType ?? null,
          gradeLevel: gradeLevel ?? null,
          customPrompt: optionalString(metadata.customPrompt) ?? null,
        }, folderId);
        node = essayNodeFromCreate(session, essayType, gradeLevel);
        break;
      }
      case 'exams': {
        const examName = rustTrim(options.name) === ''
          ? optionalString(metadata.examName) ?? null
          : options.name;
        const tempId = `temp_${randomUUID()}`;
        const exam = createExamSheetInFolderWithConn(conn, {
          examName,
          tempId,
          metadataJson: { status: 'empty', pageCount: 0, questionCount: 0 },
          previewJson: { temp_id: tempId, exam_name: options.name, pages: [] },
          status: 'empty',
        }, folderId);
        node = examToDstuNode(exam);
        break;
      }
      case 'mindmaps': {
        const mindmap = createMindmapInFolderWithConn(conn, {
          title: options.name,
          content,
          description: optionalString(metadata.description) ?? null,
          defaultView: optionalString(metadata.defaultView) ?? 'outline',
          theme: optionalString(metadata.theme) ?? 'default',
        }, folderId);
        node = mindmapToDstuNode(mindmap);
        break;
      }
      case 'images':
      case 'files':
        node = createMedia(deps, resourceType, options, metadata, folderId);
        break;
      default:
        throw new DstuFailure('InvalidNodeType', resourceType);
    }

    emitDstuWatchEvent(deps, createdEvent(node.path, node));
    return node;
  });
}
