/** chat_v2/tools/dstu_executor.rs. Mutations delegate to the same DSTU command cores. */
import * as path from '../../../../platform/util/path.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import { stripToolNamespace } from '../../../agent-skills/portable.ts';
import type { RuntimeRoot } from '../../../agent-workspace/api.ts';
import { normalizeRuntimeRelativePath } from './runtime-relative-path.ts';
import { fs } from '../local-runtime.ts';
import { rustTrim, utf8ByteLength } from '../../../../platform/util/portable.ts';
import { toBase64 } from '../../../../platform/crypto/encoding.ts';
import { CommandError } from '../../../../kernel/api.ts';
import type { VfsUploadFileParams, VfsUploadFileResult, VfsFolder, DstuNode } from '../../api.ts';
import { DstuFailure } from '../dstu-error.ts';
import { createFolderCommand, renameFolderCommand } from '../folders.ts';
import { moveCommand, renameCommand } from '../dstu-move.ts';
import { deleteCommand } from '../dstu-delete.ts';
import { restoreCommand, purgeCommand, listTrashCommand, type DstuTrashDeps } from '../dstu-trash.ts';
import { setFavoriteCommand } from '../dstu-favorite.ts';
import { createFolderNode, createdEvent, updatedEvent } from '../dstu-types.ts';
import { fileToDstuNode } from '../node-converters.ts';
import { emitDstuWatchEvent } from '../locations.ts';
import { vfsRepositories } from '../../repository/services.ts';
import { parseSerdeJson } from '../../repository/json.ts';

export const DSTU_TOOL_NAMES = ['dstu_folder_create', 'dstu_folder_rename', 'dstu_rename', 'dstu_move',
  'dstu_delete', 'dstu_restore', 'dstu_list_trash', 'dstu_set_favorite', 'dstu_purge', 'dstu_upload_file'] as const;
type Args = Record<string, unknown>;
const object = (value: unknown): Args => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function dstuToolError(code: string, message: string, hint: string, retryable: boolean): string {
  return JSON.stringify({ code, message, hint, retryable });
}
export function invalidArgs(message: string, hint: string): string { return dstuToolError('INVALID_ARGS', message, hint, false); }
function fail(raw: string): never { throw new Error(raw); }
function backendError(action: string, error: unknown): Error {
  let raw = message(error);
  if (error instanceof CommandError && typeof error.value === 'object' && error.value !== null) {
    const value = error.value as { type: DstuFailure['type']; message: string };
    if (typeof value.type === 'string' && typeof value.message === 'string') raw = new DstuFailure(value.type, value.message).message;
  }
  try { parseSerdeJson(raw); return new Error(raw); }
  catch { return new Error(dstuToolError('DSTU_OPERATION_FAILED', `${action} failed: ${raw}`,
    'Refresh the target resource and verify that its path still exists before retrying.', false)); }
}
function unavailable(name: string): never {
  return fail(dstuToolError('SERVICE_UNAVAILABLE', `required backend service is unavailable: ${name}`,
    'Restart the desktop app and retry after all backend services initialize.', true));
}
export function requiredString(args: unknown, key: string): string {
  const value = object(args)[key];
  if (typeof value !== 'string' || rustTrim(value) === '') return fail(invalidArgs(`${key} must be a non-empty string`, `Provide the required '${key}' argument.`));
  return rustTrim(value);
}
function optionalString(args: unknown, key: string): string | null {
  const value = object(args)[key];
  if (value == null) return null;
  if (typeof value !== 'string') return fail(invalidArgs(`${key} must be a string`, `Correct the type of '${key}'.`));
  const trimmed = rustTrim(value);
  if (trimmed === '') return fail(invalidArgs(`${key} cannot be empty when provided`, `Omit '${key}' or provide a non-empty string.`));
  return trimmed;
}
function requiredBool(args: unknown, key: string): boolean {
  const value = object(args)[key];
  if (typeof value !== 'boolean') return fail(invalidArgs(`${key} must be a boolean`, `Provide '${key}' as true or false.`));
  return value;
}
export function rejectUnknownArgs(args: unknown, allowed: readonly string[]): void {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail(invalidArgs('tool arguments must be a JSON object', 'Send named arguments matching the tool schema.'));
  const unknown = Object.keys(args).find(key => !allowed.includes(key));
  if (unknown !== undefined) fail(invalidArgs(`unknown argument: ${unknown}`, 'Use only the fields declared by the DSTU tool schema.'));
}
export function parseTrashPagination(args: unknown): [number, number] {
  rejectUnknownArgs(args, ['limit', 'offset']);
  const values = object(args);
  const limit = Object.hasOwn(values, 'limit') ? values.limit : 20;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return fail(invalidArgs('limit must be an integer', 'Use a value from 1 to 20.'));
  if (limit < 1 || limit > 20) return fail(invalidArgs('limit must be between 1 and 20', 'Reduce the page size and use offset to continue reading.'));
  const offset = Object.hasOwn(values, 'offset') ? values.offset : 0;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return fail(invalidArgs('offset must be a non-negative integer', 'Use offset >= 0.'));
  if (offset > 4294967295) return fail(invalidArgs('offset exceeds the supported range', 'Use a smaller pagination offset.'));
  return [limit, offset];
}
export function requiredUploadLocator(args: unknown): [string, string] {
  const root = optionalString(args, 'root_id'), relative = optionalString(args, 'relative_path');
  if (root !== null && relative !== null) return [root, relative];
  return root === null && relative === null
    ? fail(invalidArgs('an upload source is required', 'Provide root_id and relative_path from an authorized runtime source.'))
    : fail(invalidArgs('upload source is incomplete', 'Provide both root_id and relative_path.'));
}
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', ods: 'application/vnd.oasis.opendocument.spreadsheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', epub: 'application/epub+zip', rtf: 'application/rtf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const asciiLower = (s: string) => s.replace(/[A-Z]/g, ch => ch.toLowerCase());
export function mimeTypeFromName(name: string): string { return MIME[asciiLower(path.extname(name).slice(1))] ?? 'application/octet-stream'; }

/** L05 runtime authorization; no local root whitelist is substituted. */
export interface DstuUploadRoots {
  rootById(rootId: string, context: DstuToolContext): RuntimeRoot;
  revalidate(root: RuntimeRoot): string;
}
/** L11 policy + L13b vfs_upload_file business entry, including all indexing/OCR side effects. */
export interface DstuUploadPort {
  isSupportedUploadType(name: string, mimeType: string): boolean;
  maxUploadSizeBytes(mimeType: string): number;
  upload(params: VfsUploadFileParams, context: DstuToolContext): Promise<VfsUploadFileResult>;
}
export type DstuToolContext = Pick<ExecutionContext, 'message_id' | 'block_id' | 'variant_id' | 'skill_state_version'
  | 'round_id' | 'emitter' | 'emitToolCallStart' | 'saveToolBlock' | 'isCancelled'> & Partial<Pick<ExecutionContext, 'session_id' | 'skill_package_roots' | 'tauri_window'>>;
export interface DstuToolDeps extends DstuTrashDeps {
  roots?: DstuUploadRoots;
  upload?: DstuUploadPort;
}
async function operation<T>(action: string, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) { throw backendError(action, error); }
}

export class DstuToolExecutor implements ToolExecutor {
  private readonly deps: DstuToolDeps;
  constructor(deps: DstuToolDeps) { this.deps = deps; }
  name(): string { return 'DstuToolExecutor'; }
  canHandle(name: string): boolean { return (DSTU_TOOL_NAMES as readonly string[]).includes(stripToolNamespace(name)); }
  sensitivityLevel(name: string): 'low' | 'medium' | 'high' {
    const short = stripToolNamespace(name);
    return short === 'dstu_purge' ? 'high' : ['dstu_list_trash', 'dstu_set_favorite'].includes(short) ? 'low' : 'medium';
  }
  concurrencyClass(name: string): 'read_only' | 'serial' { return stripToolNamespace(name) === 'dstu_list_trash' ? 'read_only' : 'serial'; }
  private async folderNode(folder: VfsFolder): Promise<DstuNode> {
    const folderPath = await operation('build folder path', () => vfsRepositories().folders.buildFolderPath(this.deps.database.getConnSafe(), folder.id));
    return { ...createFolderNode(folder.id, `/${folderPath.replace(/^\/+|\/+$/g, '')}`, folder.title),
      createdAt: folder.createdAt, updatedAt: folder.updatedAt, metadata: { parentId: folder.parentId ?? null,
        icon: folder.icon ?? null, color: folder.color ?? null, isExpanded: folder.isExpanded, isFavorite: folder.isFavorite, sortOrder: folder.sortOrder } };
  }
  private async dispatch(name: string, args: unknown, ctx: DstuToolContext): Promise<unknown> {
    const deps = this.deps;
    switch (name) {
      case 'dstu_folder_create': {
        rejectUnknownArgs(args, ['title', 'parent_id', 'icon', 'color']);
        const title = requiredString(args, 'title'), parent = optionalString(args, 'parent_id'), icon = optionalString(args, 'icon'), color = optionalString(args, 'color');
        const folder = await operation('create folder', () => createFolderCommand(deps, title, parent, icon, color));
        const node = await this.folderNode(folder); emitDstuWatchEvent(deps, createdEvent(node.path, node));
        return { success: true, action: 'folder_create', folder, node, path: node.path, entity_ids: [node.id] };
      }
      case 'dstu_folder_rename': {
        rejectUnknownArgs(args, ['folder_id', 'title']);
        const id = requiredString(args, 'folder_id'), title = requiredString(args, 'title');
        await operation('rename folder', () => renameFolderCommand(deps, id, title));
        const folder = await operation('read renamed folder', () => vfsRepositories().folders.getFolder(deps.database.getConnSafe(), id));
        if (folder === null) fail(dstuToolError('DSTU_INCONSISTENT_RESULT', 'folder was renamed but could not be loaded', 'Refresh the folder tree before retrying any mutation.', true));
        const node = await this.folderNode(folder); emitDstuWatchEvent(deps, updatedEvent(node.path, node));
        return { success: true, action: 'folder_rename', folder, node, path: node.path, entity_ids: [node.id] };
      }
      case 'dstu_rename': {
        rejectUnknownArgs(args, ['path', 'new_name']);
        const source = requiredString(args, 'path'), newName = requiredString(args, 'new_name');
        const node = await operation('rename resource', () => renameCommand(deps, source, newName));
        return { success: true, action: 'rename', previous_path: source, path: node.path, node, entity_ids: [node.id] };
      }
      case 'dstu_move': {
        rejectUnknownArgs(args, ['src', 'dst']);
        const src = requiredString(args, 'src'), dst = requiredString(args, 'dst');
        const node = await operation('move resource', () => moveCommand(deps, src, dst));
        return { success: true, action: 'move', source_path: src, destination_path: dst, path: node.path, node, entity_ids: [node.id] };
      }
      case 'dstu_delete': case 'dstu_purge': {
        rejectUnknownArgs(args, ['path']); const source = requiredString(args, 'path');
        const action = name === 'dstu_delete' ? 'delete' : 'purge';
        await operation(`${action} resource`, () => name === 'dstu_delete' ? deleteCommand(deps, source) : purgeCommand(deps, source));
        return { success: true, action, path: source };
      }
      case 'dstu_restore': {
        rejectUnknownArgs(args, ['path']); const source = requiredString(args, 'path');
        const node = await operation('restore resource', () => restoreCommand(deps, source));
        return { success: true, action: 'restore', path: node.path, trash_path: source, node, entity_ids: [node.id] };
      }
      case 'dstu_list_trash': {
        const [limit, offset] = parseTrashPagination(args);
        const items = await operation('list trash', () => listTrashCommand(deps, limit + 1, offset, null));
        const has_more = items.length > limit; if (has_more) items.length = limit;
        return { success: true, action: 'list_trash', items, count: items.length, limit, offset, has_more,
          next_offset: has_more ? Math.min(4294967295, offset + items.length) : null };
      }
      case 'dstu_set_favorite': {
        rejectUnknownArgs(args, ['path', 'favorite']); const source = requiredString(args, 'path'), favorite = requiredBool(args, 'favorite');
        await operation('set favorite', () => setFavoriteCommand(deps, { path: source, favorite }));
        return { success: true, action: 'set_favorite', path: source, favorite };
      }
      case 'dstu_upload_file': return this.uploadFile(args, ctx);
      default: return fail(dstuToolError('UNKNOWN_TOOL', `unsupported DSTU tool: ${name}`, 'Use one of the registered builtin-dstu_* tools.', false));
    }
  }
  private async uploadFile(args: unknown, ctx: DstuToolContext): Promise<unknown> {
    rejectUnknownArgs(args, ['root_id', 'relative_path', 'folder_id', 'name', 'mime_type']);
    const [rootId, relativePath] = requiredUploadLocator(args);
    const roots = this.deps.roots ?? unavailable('runtime roots');
    let relative: string;
    try { relative = normalizeRuntimeRelativePath(relativePath); }
    catch (error) { return fail(dstuToolError('INVALID_UPLOAD_PATH', message(error), "Use a relative path below the selected runtime root without '..'.", false)); }
    if (relative === '') return fail(invalidArgs('relative_path must identify a file', 'Provide the file path relative to root_id.'));
    const root = await operation('resolve runtime root', () => roots.rootById(rootId, ctx));
    const base = await operation('revalidate runtime root', () => roots.revalidate(root));
    let current = base;
    for (const part of relative.split(path.sep).filter(p => p !== '' && p !== '.')) {
      current = path.join(current, part);
      const stat = await operation('inspect upload source', () => fs.lstatSync(current));
      if (stat.isSymbolicLink()) return fail(dstuToolError('UNSAFE_UPLOAD_PATH', 'upload source must not traverse symbolic links', 'Use the canonical file inside an authorized runtime root.', false));
    }
    const source = await operation('resolve upload source', () => fs.realpathSync(path.join(base, relative)));
    const containment = path.relative(base, source);
    if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) return fail(dstuToolError('UNSAFE_UPLOAD_PATH', 'upload source escapes the selected runtime root', 'Use a file contained by root_id.', false));
    const sourceName = path.basename(source);
    if (rustTrim(sourceName) === '') return fail(invalidArgs('upload source has no valid UTF-8 file name', 'Provide an explicit name or select a normally named file.'));
    const name = optionalString(args, 'name') ?? sourceName;
    const components = name.split(path.sep).filter((p, index) => p !== '' && (p !== '.' || index === 0));
    const componentCount = components.length + (path.isAbsolute(name) ? 1 : 0);
    if (utf8ByteLength(name) > 255 || /\p{Cc}/u.test(name) || componentCount !== 1) return fail(invalidArgs('name must be a plain file name of at most 255 bytes', 'Remove path separators and control characters from name.'));
    const mimeType = asciiLower(optionalString(args, 'mime_type') ?? mimeTypeFromName(name));
    const upload = this.deps.upload ?? unavailable('VFS upload service');
    if (!upload.isSupportedUploadType(name, mimeType)) return fail(dstuToolError('UNSUPPORTED_FILE_TYPE', `unsupported file type: ${name} (${mimeType})`, 'Use a supported image, PDF, Office, text, ebook, audio, or video file.', false));
    const folderId = optionalString(args, 'folder_id');
    const stat = await operation('stat upload source', () => fs.statBig(source));
    if (!stat.isFile()) return fail(dstuToolError('INVALID_UPLOAD_SOURCE', 'upload source is not a regular file', 'Choose a supported file rather than a directory or device.', false));
    const max = upload.maxUploadSizeBytes(mimeType);
    if (stat.size > BigInt(max)) return fail(dstuToolError('UPLOAD_TOO_LARGE', `file is ${stat.size} bytes; maximum for this type is ${max} bytes`, 'Choose a smaller file.', false));
    const data = await operation('read upload source', () => fs.readFileBounded(source, max));
    if (data.length > max) return fail(dstuToolError('UPLOAD_TOO_LARGE', 'file grew beyond the upload limit while being read', 'Retry only after the source file is no longer changing.', false));
    if (ctx.isCancelled()) return fail(dstuToolError('CANCELLED', 'upload cancelled before VFS mutation', 'No VFS file was created; retry only if still needed.', true));
    const result = await operation('upload file', () => upload.upload({ name, mimeType, base64Content: toBase64(data), fileType: null, folderId }, ctx));
    const node = fileToDstuNode(result.file);
    emitDstuWatchEvent(this.deps, result.isNew ? createdEvent(node.path, node) : updatedEvent(node.path, node));
    return { success: true, action: 'upload_file', node, source_id: result.sourceId, resource_id: result.file.resourceId ?? null,
      path: node.path, name: result.file.fileName, mime_type: result.file.mimeType ?? null, size: result.file.size,
      folder_id: folderId, is_new: result.isNew, resource_hash: result.resourceHash, ocr_status: result.ocrStatus,
      index_status: result.indexStatus, entity_ids: [node.id] };
  }
  async execute(call: ToolCall, ctx: DstuToolContext): Promise<ToolResultInfo> {
    const start = performance.now(); ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let result: ToolResultInfo;
    try {
      if (!this.canHandle(call.name)) fail(dstuToolError('UNKNOWN_TOOL', `unsupported DSTU tool: ${call.name}`, 'Use one of the registered builtin-dstu_* tools.', false));
      const output = await this.dispatch(stripToolNamespace(call.name), call.arguments, ctx);
      const durationMs = Math.floor(performance.now() - start);
      ctx.emitter.emitEndWithMeta('tool_call', ctx.block_id, { result: output, durationMs }, ctx.variant_id, ctx.skill_state_version, ctx.round_id);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } catch (error) {
      const detail = message(error), durationMs = Math.floor(performance.now() - start);
      ctx.emitter.emitErrorWithMeta('tool_call', ctx.block_id, detail, ctx.variant_id, ctx.skill_state_version, ctx.round_id);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null, success: false, error: detail, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { this.deps.log.warn('[DstuToolExecutor] failed to save tool block: %s', message(error)); }
    return result;
  }
}
