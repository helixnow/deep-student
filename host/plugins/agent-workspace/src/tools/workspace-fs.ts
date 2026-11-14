/**
 * `workspace_fs` 工具执行器：移植
 * `chat_v2/tools/workspace_fs_executor.rs`。
 *
 * 八个工具（list/read/artifact_write/file_write/file_edit/file_move/
 * file_delete/change_revert）的分支、默认值、错误文案、JSON 字段顺序与
 * 上限/钳制都逐条对齐 Rust；宿主依赖（session、settings、事件、块持久化）
 * 通过 `WorkspaceToolContext` 注入，不直接依赖 Tauri / kernel / 数据库。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { RuntimeRoot } from '../../api.ts';
import type { NativeWindowsFiles } from '../../../../platform/native/windows/api.ts';
import {
  effectiveRuntimeRootId, explicitRuntimeRootIdFromArgs, io, ioMessage, isWithin,
  normalizeRuntimeRelativePath, sha256Hex,
} from '../runtime-paths.ts';
import {
  openRuntimeReadFile, readRuntimeFileToEnd, revalidateRuntimeRoot, runtimeRootById, tempRoot,
  type RuntimeRootDeps, type SettingsLike,
} from '../runtime-roots.ts';
import { createWriteBackupFromFile, type WriteBackupSnapshot } from '../write-backups.ts';
import {
  deleteFile, moveFile, parseMutationReceipt, rollback, rollbackChangeSet, writeText,
  type ChangeSet, type MutationReceipt,
} from '../workspace-change-set.ts';
import {
  checkExpectedHash, decodeUtf8Window, fitPagedReadToDefaultBudget, isContinuationByte,
  optionalExpectedHash, parseMaxBytes, parseOffset,
} from '../utf8-paged-read.ts';
import {
  stripToolNamespace, successResult,
  type JsonValue, type ToolCall, type ToolResultInfo, type ToolSensitivity,
} from './shared.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { writeAll } from '../file-write.ts';
import { parseChangeSet } from '../workspace-receipt.ts';
export { parseChangeSet } from '../workspace-receipt.ts';

export const toolNames = {
  FILE_LIST: 'workspace_file_list',
  FILE_READ: 'workspace_file_read',
  ARTIFACT_WRITE: 'workspace_artifact_write',
  FILE_WRITE: 'workspace_file_write',
  FILE_EDIT: 'workspace_file_edit',
  FILE_MOVE: 'workspace_file_move',
  FILE_DELETE: 'workspace_file_delete',
  CHANGE_REVERT: 'workspace_change_revert',
} as const;

export const MAX_FILE_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_ARTIFACT_WRITE_BYTES = 16 * 1024 * 1024;
/** 局部编辑需在内存中对全文做 search/replace，因此上限比流式读取更严格。 */
export const MAX_EDIT_SOURCE_BYTES = 4 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_DIRECTORY_SCAN_ENTRIES = 2_000;
/** `chat_v2/tools/executor.rs` re-export 的默认工具结果字符预算。 */
export const DEFAULT_TOOL_RESULT_CHAR_BUDGET = 30_000;

type JsonObject = { [key: string]: JsonValue };

/**
 * 工具执行的宿主上下文：Rust `ExecutionContext` 中本模块实际用到的部分。
 *
 * `preferredRuntimeRootId` 对应 `ctx.chat_v2_db` 解析出的
 * `resolve_group_preferred_runtime_root_id` 结果（DB 查询属于调用方职责）。
 */
export interface WorkspaceToolContext {
  sessionId: string;
  dataDir: string;
  settings: SettingsLike;
  windowsFiles?: NativeWindowsFiles;
  skillPackageRoots?: ReadonlyMap<string, string> | null;
  preferredRuntimeRootId?: string | null;
  /** Lazy owner lookup: explicit roots must not query session/group state. */
  preferredRuntimeRootIdForSession?: () => string | null;
  /** Rust window_ref panics before root resolution; this error must propagate. */
  requireWindow?: () => void;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: unknown, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo<unknown>) => void;
  warn?: (message: string) => void;
}

export interface BoundedFileRead {
  visible: Buffer;
  bytes: number;
  sha256: string;
  offset: number;
}

export interface BoundedDirectoryList {
  entries: JsonObject[];
  skipped: number;
  scanned: number;
  truncated: boolean;
}

/** 清理失败不应覆盖正在抛出的主错误。 */
function ignoreCleanupError(_error: unknown): void { /* 明确忽略清理错误 */ }

function runtimeDeps(ctx: WorkspaceToolContext): RuntimeRootDeps {
  return { settings: ctx.settings, dataDir: ctx.dataDir, windowsFiles: ctx.windowsFiles };
}

function argsObject(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function stringArg(args: unknown, key: string): string | null {
  const value = argsObject(args)?.[key];
  return typeof value === 'string' ? value : null;
}

function boolArg(args: unknown, key: string): boolean | null {
  const value = argsObject(args)?.[key];
  return typeof value === 'boolean' ? value : null;
}

function u64Arg(args: unknown, key: string): number | null {
  const value = argsObject(args)?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function failureResult(
  toolCallId: string | null,
  blockId: string | null,
  toolName: string,
  input: unknown,
  error: string,
  durationMs: number,
): ToolResultInfo<unknown> {
  const result: ToolResultInfo<unknown> = { toolName, input, output: null, success: false, error, durationMs };
  if (toolCallId !== null && toolCallId !== '') result.toolCallId = toolCallId;
  if (blockId !== null && blockId !== '') result.blockId = blockId;
  return result;
}

/** `RuntimeRoot` 的 serde 形态（snake_case 字段，enum 用 snake_case 名）。 */
export function rootJson(root: RuntimeRoot): JsonObject {
  return {
    id: root.id,
    kind: root.kind,
    path: root.path,
    access: root.access,
    label: root.label,
    description: root.description,
    session_scoped: root.session_scoped,
    configured: root.configured,
  };
}

const SECRET_NAMES: ReadonlySet<string> = new Set([
  'credential',
  'credentials',
  'credential.json',
  'credentials.json',
  'secret',
  'secrets',
  'secret.json',
  'secrets.json',
  'token',
  'tokens',
  'token.json',
  'tokens.json',
  'password',
  'passwords',
  'passwd',
  'shadow',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/** `is_private_component`：隐藏文件/目录与常见凭据路径一律视为私有。 */
export function isPrivateComponent(component: string | null): boolean {
  if (component === null) return true;
  const lower = rustTrim(component).toLowerCase();
  if (lower === '' || lower.startsWith('.')) return true;
  return SECRET_NAMES.has(lower)
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx')
    || lower.includes('private_key')
    || lower.includes('private-key')
    || lower.startsWith('service-account')
    || lower.startsWith('service_account');
}

/** Windows `Path` 同时把 `/` 与 `\` 当作分隔符；POSIX 只有 `/`。 */
function pathComponents(relative: string): string[] {
  const parts = process.platform === 'win32' ? relative.split(/[\\/]/) : relative.split(path.sep);
  return parts.filter(part => part !== '' && part !== '.');
}

/** `ensure_public_runtime_path`：任一普通路径组件私有则整体拒绝。 */
export function ensurePublicRuntimePath(relative: string): void {
  if (pathComponents(relative).some(isPrivateComponent)) {
    throw new Error('Hidden files and common credential/secret paths are not available to workspace tools');
  }
}

function utf8Name(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readDirEntry(dir: fs.Dir): fs.Dirent | null {
  try {
    return dir.readSync();
  } catch (error) {
    throw new Error(`Failed to read directory entry: ${ioMessage(error)}`);
  }
}

/**
 * `first_char_incomplete`：对应 `std::str::from_utf8` 的
 * `valid_up_to() == 0 && error_len().is_none()`（首字符被截断）。
 */
export function firstCharIncomplete(bytes: Uint8Array): boolean {
  const lead = bytes[0];
  if (lead === undefined) return false;
  let need: number;
  let firstMin = 0x80;
  let firstMax = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) {
    need = 2;
  } else if (lead === 0xe0) {
    need = 3;
    firstMin = 0xa0;
  } else if (lead >= 0xe1 && lead <= 0xec) {
    need = 3;
  } else if (lead === 0xed) {
    need = 3;
    firstMax = 0x9f;
  } else if (lead >= 0xee && lead <= 0xef) {
    need = 3;
  } else if (lead === 0xf0) {
    need = 4;
    firstMin = 0x90;
  } else if (lead >= 0xf1 && lead <= 0xf3) {
    need = 4;
  } else if (lead === 0xf4) {
    need = 4;
    firstMax = 0x8f;
  } else {
    return false;
  }
  if (bytes.length >= need) return false;
  for (let index = 1; index < bytes.length; index++) {
    const byte = bytes[index]!;
    const min = index === 1 ? firstMin : 0x80;
    const max = index === 1 ? firstMax : 0xbf;
    if (byte < min || byte > max) return false;
  }
  return true;
}

function countContinuationBytes(bytes: Uint8Array): number {
  let count = 0;
  while (count < bytes.length && isContinuationByte(bytes[count]!)) count++;
  return count;
}

function stageFile(directory: string, prefix: string): { fd: number; target: string } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const target = path.join(directory, `${prefix}${randomBytes(8).toString('hex')}`);
    try {
      return { fd: fs.openSync(target, 'wx'), target };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new Error(`Failed to create staged artifact: ${ioMessage(error)}`);
    }
  }
  throw new Error('Failed to create staged artifact: too many collisions');
}

function persistNoClobber(stage: string, target: string): void {
  try {
    fs.linkSync(stage, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
      // 平台不支持硬链接时退化为独占创建 + 复制；仍保证不覆盖已有文件。
      let fd: number;
      try {
        fd = fs.openSync(target, 'wx');
      } catch (openError) {
        throw new Error(`Failed to atomically create artifact: ${ioMessage(openError)}`);
      }
      try {
        fs.writeFileSync(fd, fs.readFileSync(stage));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(stage);
      return;
    }
    throw new Error(`Failed to atomically create artifact: ${ioMessage(error)}`);
  }
  fs.unlinkSync(stage);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  let result = '';
  let cursor = 0;
  for (;;) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) return result + haystack.slice(cursor);
    result += haystack.slice(cursor, index) + replacement;
    cursor = index + needle.length;
  }
}

/**
 * `resolve_effective_runtime_root_id_for_session`：
 * 显式 root 优先；否则会话组默认 root（本地可解析时）；不可解析则退回 workspace。
 */
export function resolveEffectiveRuntimeRootIdForSession(
  ctx: Pick<WorkspaceToolContext, 'settings' | 'dataDir' | 'sessionId' | 'skillPackageRoots' | 'preferredRuntimeRootId' | 'preferredRuntimeRootIdForSession' | 'windowsFiles' | 'warn'>,
  explicit: string | null | undefined,
): string {
  const explicitId = explicit == null ? undefined : rustTrim(explicit);
  if (explicitId) return explicitId;
  const preferredId = ctx.preferredRuntimeRootIdForSession ? ctx.preferredRuntimeRootIdForSession() : ctx.preferredRuntimeRootId;
  const preferred = preferredId == null ? undefined : rustTrim(preferredId);
  if (preferred) {
    let resolvable = true;
    try {
      runtimeRootById(runtimeDeps(ctx), ctx.sessionId, ctx.skillPackageRoots ?? null, preferred, false);
    } catch {
      resolvable = false;
    }
    if (resolvable) return preferred;
    ctx.warn?.(`[runtime_roots] group preferred runtime root '${preferred}' for session '${ctx.sessionId}' is not resolvable on this device; falling back to workspace`);
  }
  return effectiveRuntimeRootId(null, null);
}

export class WorkspaceFsExecutor {
  private readonly getWindowsFiles?: () => NativeWindowsFiles | undefined;
  constructor(getWindowsFiles?: () => NativeWindowsFiles | undefined) {
    this.getWindowsFiles = getWindowsFiles;
  }
  static order(): string[] {
    return Object.values(toolNames);
  }

  static normalizeRelativePath(raw?: string | null): string {
    return normalizeRuntimeRelativePath(raw);
  }

  static sha256Hex(bytes: Uint8Array): string {
    return sha256Hex(bytes);
  }

  static decodeUtf8Prefix(bytes: Uint8Array, truncated: boolean): string {
    return decodeUtf8Window(bytes, truncated);
  }

  /** `ensure_no_symlink_components`：逐级 lstat，拒绝对符号链接的穿越。 */
  static ensureNoSymlinkComponents(rootCanon: string, relative: string): void {
    let current = rootCanon;
    for (const part of relative.split(path.sep)) {
      if (part === '' || part === '.') continue;
      current = path.join(current, part);
      let metadata: fs.Stats;
      try {
        metadata = fs.lstatSync(current);
      } catch (error) {
        throw new Error(`Path does not exist or cannot be inspected: ${ioMessage(error)}`);
      }
      if (metadata.isSymbolicLink()) {
        throw new Error('Workspace tools do not follow symlinks');
      }
    }
  }

  /** `ensure_inside_existing`：canonicalize 后再验根内 + 公开路径。 */
  static ensureInsideExisting(rootCanon: string, relative: string): string {
    WorkspaceFsExecutor.ensureNoSymlinkComponents(rootCanon, relative);
    const target = path.join(rootCanon, relative);
    let targetCanon: string;
    try {
      targetCanon = fs.realpathSync.native(target);
    } catch (error) {
      throw new Error(`Path does not exist or cannot be read: ${ioMessage(error)}`);
    }
    if (!isWithin(rootCanon, targetCanon)) {
      throw new Error('Path escapes the selected runtime root');
    }
    ensurePublicRuntimePath(path.relative(rootCanon, targetCanon));
    return targetCanon;
  }

  /** `ensure_write_target`：只允许 artifacts 根，父目录逐级真实创建。 */
  static ensureWriteTarget(root: RuntimeRoot, rootCanon: string, relative: string): string {
    if (root.kind !== 'artifact') {
      throw new Error('Only the artifacts runtime root is writable');
    }
    if (relative === '') {
      throw new Error('Artifact path is required');
    }

    const target = path.join(rootCanon, relative);
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to inspect artifact target: ${ioMessage(error)}`);
      }
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new Error('Writing through symlinks is not allowed');
      }
      if (existing.isDirectory()) {
        throw new Error('Cannot write text content to a directory');
      }
    }
    let parent = rootCanon;
    const relativeParent = path.dirname(relative);
    if (relativeParent !== '.' && relativeParent !== '') {
      for (const part of relativeParent.split(path.sep)) {
        if (part === '' || part === '.') continue;
        parent = path.join(parent, part);
        try {
          fs.mkdirSync(parent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw new Error(`Failed to create artifact parent: ${ioMessage(error)}`);
          }
        }
        let metadata: fs.Stats;
        try {
          metadata = fs.lstatSync(parent);
        } catch (error) {
          throw new Error(`Failed to inspect artifact parent: ${ioMessage(error)}`);
        }
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error('Artifact parent must be a real directory');
        }
      }
    }
    let parentCanon: string;
    try {
      parentCanon = fs.realpathSync.native(parent);
    } catch (error) {
      throw new Error(`Failed to canonicalize parent directory: ${ioMessage(error)}`);
    }
    if (!isWithin(rootCanon, parentCanon)) {
      throw new Error('Artifact path escapes the runtime root');
    }
    const fileName = path.basename(relative);
    if (!fileName) throw new Error('Artifact target has no file name');
    return path.join(parentCanon, fileName);
  }

  /** `ensure_writable_workspace`：必须是配置好的可写 workspace 根。 */
  static ensureWritableWorkspace(root: RuntimeRoot): void {
    if (root.kind !== 'workspace' || root.id !== 'workspace') {
      throw new Error('Workspace mutation tools require root_id=workspace');
    }
    if (root.access !== 'read_write') {
      throw new Error('Workspace is read-only; the user must explicitly grant write access');
    }
    if (!root.configured) {
      throw new Error('Workspace write access requires a configured workspace root');
    }
  }

  private static resolveRoot(
    ctx: WorkspaceToolContext,
    rootId: string,
  ): { root: RuntimeRoot; rootCanon: string } {
    const root = runtimeRootById(
      runtimeDeps(ctx),
      ctx.sessionId,
      ctx.skillPackageRoots ?? null,
      rootId,
      true,
    );
    const rootCanon = revalidateRuntimeRoot(ctx.settings, root, ctx.windowsFiles);
    return { root, rootCanon };
  }

  /** 流式读取：整文件哈希 + 至多 max_bytes 的可见窗口（不跟随符号链接）。 */
  static readFileBounded(target: string, offset: number, maxBytes: number, windowsFiles?: NativeWindowsFiles): BoundedFileRead {
    const file = openRuntimeReadFile(target, 'workspace_file_read path', windowsFiles);
    try {
      const size = io('Failed to read file metadata', () => file.size());
      if (size > MAX_FILE_SOURCE_BYTES) {
        throw new Error(`workspace_file_read refuses files larger than ${MAX_FILE_SOURCE_BYTES / (1024 * 1024)} MiB`);
      }

      const offsetU64 = offset;
      let visible = Buffer.alloc(0);
      const hasher = createHash('sha256');
      let total = 0;
      const buffer = Buffer.alloc(READ_BUFFER_BYTES);
      for (;;) {
        const read = io('Failed to read file', () => file.read(buffer));
        if (read === 0) break;
        total += read;
        if (!Number.isSafeInteger(total)) {
          throw new Error('File length overflow while reading');
        }
        if (total > MAX_FILE_SOURCE_BYTES) {
          throw new Error(`workspace_file_read stopped because the file grew beyond ${MAX_FILE_SOURCE_BYTES / (1024 * 1024)} MiB`);
        }
        const chunk = Buffer.from(buffer.subarray(0, read));
        hasher.update(chunk);
        const bufferStart = total - read;
        if (total <= offsetU64) continue;
        const startInBuffer = offsetU64 > bufferStart ? offsetU64 - bufferStart : 0;
        if (startInBuffer >= read) continue;
        if (visible.length === 0 && offset > 0 && isContinuationByte(chunk[startInBuffer]!)) {
          throw new Error(`offset ${offset} is not a UTF-8 character boundary`);
        }
        const available = chunk.subarray(startInBuffer);
        if (visible.length < maxBytes) {
          const take = Math.min(available.length, maxBytes - visible.length);
          visible = Buffer.concat([visible, available.subarray(0, take)]);
          if (take < available.length && firstCharIncomplete(visible)) {
            const extra = countContinuationBytes(available.subarray(take));
            visible = Buffer.concat([visible, available.subarray(take, take + extra)]);
          }
        } else if (firstCharIncomplete(visible)) {
          const extra = countContinuationBytes(available);
          visible = Buffer.concat([visible, available.subarray(0, extra)]);
        }
      }

      if (offsetU64 > total) {
        throw new Error(`offset ${offset} exceeds content length ${total}`);
      }
      if (offsetU64 < total && visible.length === 0 && offset > 0) {
        throw new Error(`offset ${offset} is not a UTF-8 character boundary`);
      }

      return { visible, bytes: total, sha256: hasher.digest('hex'), offset };
    } finally {
      file.close();
    }
  }

  /** 有界目录扫描：先后读取 4× 条目、至多 2000，隐私/符号链接计入 skipped。 */
  static listDirectoryBounded(target: string, relative: string, maxEntries: number): BoundedDirectoryList {
    let dir: fs.Dir;
    try {
      // `Dir` 的 encoding 运行时接受 'buffer'（Dirent.name 为 Buffer），类型声明只列 BufferEncoding。
      dir = fs.opendirSync(target, { encoding: 'buffer' as unknown as BufferEncoding, bufferSize: READ_BUFFER_BYTES });
    } catch (error) {
      throw new Error(`Failed to list directory: ${ioMessage(error)}`);
    }
    const scanLimit = Math.min(
      Math.max(Math.trunc(maxEntries) * 4, maxEntries),
      MAX_DIRECTORY_SCAN_ENTRIES,
    );
    const entries: JsonObject[] = [];
    let skipped = 0;
    let scanned = 0;
    try {
      for (;;) {
        if (!(scanned < scanLimit && entries.length < maxEntries)) break;
        const entry = readDirEntry(dir);
        if (!entry) return { entries, skipped, scanned, truncated: false };
        scanned += 1;
        const name = utf8Name(entry.name as unknown as Buffer);
        if (isPrivateComponent(name)) {
          skipped += 1;
          continue;
        }
        const entryPath = path.join(target, name!);
        let fileType: fs.Stats;
        try {
          fileType = fs.lstatSync(entryPath);
        } catch (error) {
          throw new Error(`Failed to read entry type: ${ioMessage(error)}`);
        }
        if (fileType.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        let metadata: fs.Stats;
        try {
          metadata = fs.statSync(entryPath);
        } catch (error) {
          throw new Error(`Failed to read entry metadata: ${ioMessage(error)}`);
        }
        entries.push({
          name: name!,
          relative_path: path.join(relative, name!),
          kind: metadata.isDirectory() ? 'directory' : 'file',
          bytes: metadata.isFile() ? metadata.size : null,
        });
      }
      const peek = readDirEntry(dir);
      return { entries, skipped, scanned, truncated: peek !== null };
    } finally {
      try { dir.closeSync(); } catch (error) { ignoreCleanupError(error); }
    }
  }

  /** 同目录 stage + fsync + 原子替换/独占创建。 */
  static atomicWriteBytes(target: string, bytes: Uint8Array, overwrite: boolean): void {
    const parent = path.dirname(target);
    if (parent === '' || parent === '.') {
      throw new Error('Artifact target has no parent directory');
    }
    const staged = stageFile(parent, '.artifact-');
    try {
      io('Failed to stage artifact', () => writeAll(staged.fd, bytes));
      io('Failed to sync staged artifact', () => fs.fsyncSync(staged.fd));
      fs.closeSync(staged.fd);
      staged.fd = -1;

      // 紧接原子替换前再复核目标。
      let existing: fs.Stats | null = null;
      try {
        existing = fs.lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Failed to inspect artifact target: ${ioMessage(error)}`);
        }
      }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error('Refusing to replace a symlink or non-file artifact');
        }
        if (!overwrite) {
          throw new Error('Artifact already exists and overwrite=false');
        }
      }

      if (overwrite) {
        try {
          fs.renameSync(staged.target, target);
        } catch (error) {
          throw new Error(`Failed to atomically replace artifact: ${ioMessage(error)}`);
        }
        staged.target = '';
      } else {
        persistNoClobber(staged.target, target);
        staged.target = '';
      }
      if (process.platform !== 'win32') {
        try {
          const directory = fs.openSync(parent, 'r');
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        } catch (error) { ignoreCleanupError(error); }
      }
    } finally {
      if (staged.fd >= 0) {
        try { fs.closeSync(staged.fd); } catch (error) { ignoreCleanupError(error); }
      }
      if (staged.target !== '') {
        try { fs.unlinkSync(staged.target); } catch (error) { ignoreCleanupError(error); }
      }
    }
  }

  /** 读取全文用于局部编辑（不跟随符号链接，限制 4 MiB）。 */
  static readFileFullForEdit(target: string, windowsFiles?: NativeWindowsFiles): { content: string; sha256: string } {
    const file = openRuntimeReadFile(target, 'workspace_file_edit path', windowsFiles);
    try {
      const size = io('Failed to read file metadata', () => file.size());
      if (size > MAX_EDIT_SOURCE_BYTES) {
        throw new Error(`workspace_file_edit 仅支持不超过 ${MAX_EDIT_SOURCE_BYTES / (1024 * 1024)} MiB 的文件（局部编辑需读入全文）；更大文件请用 workspace_file_write 整体覆写`);
      }
      const bytes = io('Failed to read file', () => readRuntimeFileToEnd(file));
      if (bytes.length > MAX_EDIT_SOURCE_BYTES) {
        throw new Error(`workspace_file_edit 文件在读取过程中增长超过 ${MAX_EDIT_SOURCE_BYTES / (1024 * 1024)} MiB`);
      }
      const digest = sha256Hex(bytes);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error('workspace_file_edit 目前仅支持 UTF-8 文本文件');
      }
      return { content, sha256: digest };
    } finally {
      file.close();
    }
  }

  /** 顺序应用一组 search/replace；`old_string` 默认必须唯一。 */
  static applyEdits(
    content: string,
    edits: readonly JsonValue[],
    replaceAll: boolean,
  ): { content: string; counts: number[] } {
    let current = content;
    const counts: number[] = [];
    edits.forEach((edit, index) => {
      const oldString = argsObject(edit)?.['old_string'];
      if (typeof oldString !== 'string') {
        throw new Error(`edits[${index}].old_string is required`);
      }
      const newString = argsObject(edit)?.['new_string'];
      if (typeof newString !== 'string') {
        throw new Error(`edits[${index}].new_string is required`);
      }
      if (oldString === '') {
        throw new Error(`edits[${index}].old_string 不能为空（空匹配有歧义）`);
      }
      if (oldString === newString) {
        throw new Error(`edits[${index}] 的 old_string 与 new_string 相同，无实际变更`);
      }
      const occurrences = countOccurrences(current, oldString);
      if (occurrences === 0) {
        throw new Error(`edits[${index}] 未找到匹配的 old_string。可能原因：内容已被修改、空白/缩进不一致、或大小写差异。请先用 workspace_file_read 读取最新内容。`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`edits[${index}] 的 old_string 出现了 ${occurrences} 次，不唯一。请提供更长的、包含更多上下文的 old_string 以唯一定位，或确认要全部替换时传 replace_all=true。`);
      }
      current = replaceAll
        ? replaceAllLiteral(current, oldString, newString)
        : replaceFirst(current, oldString, newString);
      counts.push(replaceAll ? occurrences : 1);
    });
    return { content: current, counts };
  }

  /** `workspace_change_output`：单个 receipt → change_set + file_change_summary。 */
  static workspaceChangeOutput(root: RuntimeRoot, receipt: MutationReceipt): JsonObject {
    const created = receipt.op === 'created' ? 1 : 0;
    const modified = receipt.op === 'modified' || receipt.op === 'moved' ? 1 : 0;
    const deleted = receipt.op === 'deleted' ? 1 : 0;
    const bytesWritten = deleted > 0 ? 0 : receipt.bytes;
    const changeSet: ChangeSet = { id: receipt.change_id, changes: [receipt] };
    return {
      root: rootJson(root),
      root_id: root.id,
      change_set: changeSet as unknown as JsonValue,
      mutation_receipt: receipt as unknown as JsonValue,
      file_change_summary: {
        created,
        modified,
        deleted,
        bytes_written: bytesWritten,
        changes: changeSet.changes as unknown as JsonValue,
      },
    };
  }

  private static async executeFileList(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const rootId = resolveEffectiveRuntimeRootIdForSession(ctx, explicitRuntimeRootIdFromArgs(args));
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, rootId);
    const relative = WorkspaceFsExecutor.normalizeRelativePath(stringArg(args, 'path'));
    ensurePublicRuntimePath(relative);
    const rawMaxEntries = u64Arg(args, 'max_entries');
    const maxEntries = rawMaxEntries === null ? 200 : Math.min(Math.max(rawMaxEntries, 1), 500);
    const target = WorkspaceFsExecutor.ensureInsideExisting(rootCanon, relative);
    let metadata: fs.Stats;
    try {
      metadata = fs.statSync(target);
    } catch (error) {
      throw new Error(`Failed to read path: ${ioMessage(error)}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error('workspace_file_list path must be a directory');
    }

    const listed = WorkspaceFsExecutor.listDirectoryBounded(target, relative, maxEntries);

    return {
      root: rootJson(root),
      root_id: root.id,
      relative_path: relative,
      entries: listed.entries,
      skipped: listed.skipped,
      scanned: listed.scanned,
      truncated: listed.truncated,
    };
  }

  private static async executeFileRead(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const rootId = resolveEffectiveRuntimeRootIdForSession(ctx, explicitRuntimeRootIdFromArgs(args));
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, rootId);
    const relative = WorkspaceFsExecutor.normalizeRelativePath(stringArg(args, 'path'));
    if (relative === '') {
      throw new Error('path is required');
    }
    ensurePublicRuntimePath(relative);
    const offset = parseOffset(args);
    const maxBytes = parseMaxBytes(args);
    const expectedHash = optionalExpectedHash(args);
    const target = WorkspaceFsExecutor.ensureInsideExisting(rootCanon, relative);
    const read = WorkspaceFsExecutor.readFileBounded(target, offset, maxBytes, ctx.windowsFiles);
    if (expectedHash !== null) {
      checkExpectedHash(expectedHash, read.sha256);
    }
    const moreRemains = read.offset + read.visible.length < read.bytes;
    const content = read.offset === read.bytes
      ? ''
      : decodeUtf8Window(read.visible, moreRemains);
    const returnedBytes = Buffer.byteLength(content, 'utf8');
    const output: JsonObject = {
      root: rootJson(root),
      root_id: root.id,
      relative_path: relative,
      content,
      bytes: read.bytes,
      sha256: read.sha256,
      offset: read.offset,
      returned_bytes: returnedBytes,
      next_offset: read.offset + returnedBytes,
      eof: read.offset + returnedBytes >= read.bytes,
      truncated: read.offset + returnedBytes < read.bytes,
    };
    if (!fitPagedReadToDefaultBudget(output, 'content', read.offset, read.bytes)) {
      throw new Error('workspace_file_read metadata exceeds the tool result budget');
    }
    return output;
  }

  private static async executeArtifactWrite(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, 'artifacts');
    const relative = WorkspaceFsExecutor.normalizeRelativePath(stringArg(args, 'path'));
    ensurePublicRuntimePath(relative);
    const content = stringArg(args, 'content');
    if (content === null) throw new Error('content is required');
    const overwrite = boolArg(args, 'overwrite') ?? true;
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_ARTIFACT_WRITE_BYTES) {
      throw new Error(`Artifact content exceeds the ${MAX_ARTIFACT_WRITE_BYTES / (1024 * 1024)} MiB write limit`);
    }
    const target = WorkspaceFsExecutor.ensureWriteTarget(root, rootCanon, relative);
    let existed = false;
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to inspect artifact target: ${ioMessage(error)}`);
      }
    }
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('Existing artifact must be a regular file');
      }
      existed = true;
    }
    if (existed && !overwrite) {
      throw new Error('Artifact already exists and overwrite=false');
    }
    const fileName = path.basename(relative) || relative;
    // 覆盖已存在文件前先把旧内容备份到 temp 根备份区；备份失败则整个写入中止，
    // 保证只要返回了 modified change，就一定有可用的 backup_ref 供撤销恢复。
    let backup: { tempPath: string; snapshot: WriteBackupSnapshot } | null = null;
    if (existed) {
      const temp = tempRoot(ctx.dataDir, ctx.sessionId, true);
      backup = { tempPath: temp.path, snapshot: createWriteBackupFromFile(temp.path, fileName, target, ctx.windowsFiles) };
    }

    try {
      WorkspaceFsExecutor.atomicWriteBytes(target, Buffer.from(content, 'utf8'), overwrite);
    } catch (error) {
      if (backup !== null) {
        try {
          fs.unlinkSync(path.join(backup.tempPath, backup.snapshot.backupRef));
        } catch (cleanupError) {
          ignoreCleanupError(cleanupError);
        }
      }
      throw error;
    }
    const afterHash = sha256Hex(Buffer.from(content, 'utf8'));
    const afterBytes = contentBytes;
    const op = existed ? 'modified' : 'created';

    const change: JsonObject = {
      op,
      root_id: root.id,
      relative_path: relative,
      before_hash: backup === null ? null : backup.snapshot.sha256,
      after_hash: afterHash,
      bytes: afterBytes,
    };
    // backup_ref 仅在覆盖写时出现，None 时不落 key，保持旧前端向后兼容。
    if (backup !== null) {
      change['backup_ref'] = backup.snapshot.backupRef;
    }

    return {
      root: rootJson(root),
      root_id: root.id,
      path: relative,
      file_name: fileName,
      bytes_written: afterBytes,
      sha256: afterHash,
      file_change_summary: {
        created: existed ? 0 : 1,
        modified: existed ? 1 : 0,
        deleted: 0,
        bytes_written: afterBytes,
        changes: [change],
      },
    };
  }

  private static async executeWorkspaceWrite(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, 'workspace');
    WorkspaceFsExecutor.ensureWritableWorkspace(root);
    const targetPath = stringArg(args, 'path');
    if (targetPath === null) throw new Error('path is required');
    const content = stringArg(args, 'content');
    if (content === null) throw new Error('content is required');
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_WRITE_BYTES) {
      throw new Error(`Workspace content exceeds the ${MAX_ARTIFACT_WRITE_BYTES / (1024 * 1024)} MiB write limit`);
    }
    const expected = stringArg(args, 'expected_current_hash');
    const temp = tempRoot(ctx.dataDir, ctx.sessionId, true);
    const receipt = writeText(rootCanon, temp.path, root.id, targetPath, content, expected);
    return WorkspaceFsExecutor.workspaceChangeOutput(root, receipt);
  }

  private static async executeWorkspaceEdit(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, 'workspace');
    WorkspaceFsExecutor.ensureWritableWorkspace(root);
    const targetPath = stringArg(args, 'path');
    if (targetPath === null) throw new Error('path is required');
    const expected = stringArg(args, 'expected_current_hash');
    if (expected === null) {
      throw new Error('expected_current_hash is required：局部编辑必须基于最近一次 workspace_file_read 返回的 sha256，防止覆盖他人/他处的并发修改');
    }
    const rawEdits = argsObject(args)?.['edits'];
    if (!Array.isArray(rawEdits)) {
      throw new Error('edits is required（非空数组，每项含 old_string/new_string）');
    }
    const edits = rawEdits;
    if (edits.length === 0) {
      throw new Error('edits 不能为空数组');
    }
    if (edits.length > 100) {
      throw new Error('单次最多 100 处编辑');
    }
    const replaceAll = boolArg(args, 'replace_all') ?? false;

    // 读取全文 + 当前 hash，先做 OCC 前置校验（友好失败，附实际 hash）。
    const relative = WorkspaceFsExecutor.normalizeRelativePath(targetPath);
    ensurePublicRuntimePath(relative);
    const target = WorkspaceFsExecutor.ensureInsideExisting(rootCanon, relative);
    const { content, sha256: currentHash } = WorkspaceFsExecutor.readFileFullForEdit(target, ctx.windowsFiles);
    if (currentHash !== expected) {
      throw new Error(`expected_current_hash 不匹配：文件当前 sha256 为 ${currentHash}。文件可能已被并发修改，请重新 workspace_file_read 获取最新内容与 hash 后再编辑。`);
    }

    const applied = WorkspaceFsExecutor.applyEdits(content, edits, replaceAll);
    const totalReplacements = applied.counts.reduce((sum, count) => sum + count, 0);

    // 复用 write_text 落盘：内部会重新 read+hash 校验（防 TOCTOU），
    // 并创建 checkpoint 备份、返回可回滚的 MutationReceipt。
    const temp = tempRoot(ctx.dataDir, ctx.sessionId, true);
    const receipt = writeText(rootCanon, temp.path, root.id, targetPath, applied.content, expected);
    const output = WorkspaceFsExecutor.workspaceChangeOutput(root, receipt);
    output['edits_applied'] = edits.length;
    output['replacements'] = totalReplacements;
    output['per_edit_replacements'] = applied.counts;
    return output;
  }

  private static async executeWorkspaceMove(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, 'workspace');
    WorkspaceFsExecutor.ensureWritableWorkspace(root);
    const source = stringArg(args, 'source_path');
    if (source === null) throw new Error('source_path is required');
    const destination = stringArg(args, 'destination_path');
    if (destination === null) throw new Error('destination_path is required');
    const expected = stringArg(args, 'expected_current_hash');
    if (expected === null) throw new Error('expected_current_hash is required');
    const receipt = moveFile(rootCanon, root.id, source, destination, expected);
    return WorkspaceFsExecutor.workspaceChangeOutput(root, receipt);
  }

  private static async executeWorkspaceDelete(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, 'workspace');
    WorkspaceFsExecutor.ensureWritableWorkspace(root);
    const targetPath = stringArg(args, 'path');
    if (targetPath === null) throw new Error('path is required');
    const expected = stringArg(args, 'expected_current_hash');
    if (expected === null) throw new Error('expected_current_hash is required');
    const temp = tempRoot(ctx.dataDir, ctx.sessionId, true);
    const receipt = deleteFile(rootCanon, temp.path, root.id, targetPath, expected);
    return WorkspaceFsExecutor.workspaceChangeOutput(root, receipt);
  }

  private static async executeWorkspaceRevert(args: unknown, ctx: WorkspaceToolContext): Promise<JsonObject> {
    const { root, rootCanon } = WorkspaceFsExecutor.resolveRoot(ctx, 'workspace');
    WorkspaceFsExecutor.ensureWritableWorkspace(root);
    const temp = tempRoot(ctx.dataDir, ctx.sessionId, true);
    const rawChangeSet = argsObject(args)?.['change_set'];
    if (rawChangeSet !== undefined) {
      const changeSet = parseChangeSet(rawChangeSet);
      if (changeSet.changes.some(receipt => receipt.root_id !== root.id)) {
        throw new Error('Change set contains a different runtime root');
      }
      const rollbackResult = rollbackChangeSet(rootCanon, temp.path, changeSet);
      return {
        reverted: rollbackResult.complete,
        root: rootJson(root),
        change_id: changeSet.id,
        change_set: changeSet as unknown as JsonValue,
        rollback_result: rollbackResult as unknown as JsonValue,
      };
    }

    const rawReceipt = argsObject(args)?.['receipt'];
    if (rawReceipt === undefined) {
      throw new Error('receipt or change_set is required');
    }
    const receipt = parseMutationReceipt(rawReceipt);
    if (receipt.root_id !== root.id) {
      throw new Error('Mutation receipt belongs to a different runtime root');
    }
    rollback(rootCanon, temp.path, receipt);
    return {
      reverted: true,
      root: rootJson(root),
      change_id: receipt.change_id,
      receipt: receipt as unknown as JsonValue,
    };
  }

  canHandle(toolName: string): boolean {
    return WorkspaceFsExecutor.order().includes(stripToolNamespace(toolName));
  }

  async execute(call: ToolCall<unknown>, ctx: WorkspaceToolContext): Promise<ToolResultInfo<unknown>> {
    const start = performance.now();
    const toolName = stripToolNamespace(call.name);

    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);

    // Every supported Rust branch resolves a root before doing any fallible
    // business work. window_ref's panic is not a returned tool error.
    if (this.canHandle(call.name)) ctx.requireWindow?.();

    let result: JsonObject;
    try {
      const executionContext = this.getWindowsFiles ? { ...ctx, windowsFiles: this.getWindowsFiles() } : ctx;
      result = await WorkspaceFsExecutor.dispatch(toolName, call.arguments, executionContext);
    } catch (error) {
      const durationMs = Math.trunc(performance.now() - start);
      const message = error instanceof Error ? error.message : String(error);
      ctx.emitToolCallError?.(message);
      const failed = failureResult(call.id, ctx.blockId ?? null, call.name, call.arguments, message, durationMs);
      if (ctx.saveToolBlock) {
        try {
          ctx.saveToolBlock(failed);
        } catch (saveError) {
          ctx.warn?.(`[WorkspaceFsExecutor] Failed to save tool block: ${ioMessage(saveError)}`);
        }
      }
      return failed;
    }

    const durationMs = Math.trunc(performance.now() - start);
    ctx.emitToolCallEnd?.({ result, durationMs });
    const succeeded = successResult(call.id, ctx.blockId ?? null, call.name, call.arguments, result, durationMs);
    if (ctx.saveToolBlock) {
      try {
        ctx.saveToolBlock(succeeded);
      } catch (error) {
        ctx.warn?.(`[WorkspaceFsExecutor] Failed to save tool block: ${ioMessage(error)}`);
      }
    }
    return succeeded;
  }

  private static async dispatch(
    toolName: string,
    args: unknown,
    ctx: WorkspaceToolContext,
  ): Promise<JsonObject> {
    switch (toolName) {
      case toolNames.FILE_LIST: return WorkspaceFsExecutor.executeFileList(args, ctx);
      case toolNames.FILE_READ: return WorkspaceFsExecutor.executeFileRead(args, ctx);
      case toolNames.ARTIFACT_WRITE: return WorkspaceFsExecutor.executeArtifactWrite(args, ctx);
      case toolNames.FILE_WRITE: return WorkspaceFsExecutor.executeWorkspaceWrite(args, ctx);
      case toolNames.FILE_EDIT: return WorkspaceFsExecutor.executeWorkspaceEdit(args, ctx);
      case toolNames.FILE_MOVE: return WorkspaceFsExecutor.executeWorkspaceMove(args, ctx);
      case toolNames.FILE_DELETE: return WorkspaceFsExecutor.executeWorkspaceDelete(args, ctx);
      case toolNames.CHANGE_REVERT: return WorkspaceFsExecutor.executeWorkspaceRevert(args, ctx);
      default: throw new Error(`Unknown workspace filesystem tool: ${toolName}`);
    }
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    const name = stripToolNamespace(toolName);
    if (name === toolNames.ARTIFACT_WRITE || name === toolNames.FILE_WRITE || name === toolNames.FILE_EDIT) {
      return 'medium';
    }
    if (name === toolNames.FILE_MOVE || name === toolNames.FILE_DELETE || name === toolNames.CHANGE_REVERT) {
      return 'high';
    }
    return 'low';
  }

  resultCharBudget(toolName: string): number | null {
    return stripToolNamespace(toolName) === toolNames.FILE_READ ? null : DEFAULT_TOOL_RESULT_CHAR_BUDGET;
  }

  name(): string {
    return 'WorkspaceFsExecutor';
  }
}

export const workspaceFsExecutor = new WorkspaceFsExecutor();
