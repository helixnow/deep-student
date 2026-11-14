/**
 * 结构化 workspace 变更与回滚：移植 `chat_v2/workspace_change_set.rs`。
 *
 * 回执哈希绑定当前内容，回滚绝不覆盖之后的用户编辑；检查点放在 session
 * temp 根的 `.workspace_changes`，单文件上限 64 MiB。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ioMessage, isWithin, normalizeRuntimeRelativePath } from './runtime-paths.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { readRuntimeFileToEnd, runtimeReadFileFromFd, type RuntimeReadFile } from './runtime-roots.ts';
import { writeAll } from './file-write.ts';
export { parseMutationReceipt } from './workspace-receipt.ts';

export const MAX_MUTATION_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_DIR = '.workspace_changes';

let changeSequence = 0;

/** 清理失败不应覆盖正在抛出的主错误。 */
function ignoreCleanupError(_error: unknown): void { /* 明确忽略清理错误 */ }

export type MutationKind = 'created' | 'modified' | 'moved' | 'deleted';

export interface MutationReceipt<Bytes extends number | bigint = number> {
  change_id: string;
  root_id: string;
  op: MutationKind;
  relative_path: string;
  destination_path?: string;
  before_hash?: string;
  after_hash?: string;
  backup_ref?: string;
  bytes: Bytes;
}

export interface ChangeSet<Bytes extends number | bigint = number> {
  id: string;
  changes: MutationReceipt<Bytes>[];
}

export interface RollbackItemResult {
  change_id: string;
  relative_path: string;
  reverted: boolean;
  error?: string;
}

export interface RollbackChangeSetResult {
  change_set_id: string;
  complete: boolean;
  reverted_count: number;
  failed_count: number;
  items: RollbackItemResult[];
}

export interface ExternalFileState {
  bytes: Buffer;
  sha256: string;
}

export type ExternalFileSnapshot = Map<string, ExternalFileState>;

export function nextChangeId(): string {
  return `change-${Date.now()}-${changeSequence++}`;
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function displayRelative(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeMutationPath(raw: string): string {
  const relative = normalizeRuntimeRelativePath(raw);
  if (relative === '') throw new Error('A relative workspace path is required');
  for (const part of relative.split(path.sep)) {
    const value = part.toLowerCase();
    if (value.startsWith('.') || ['credentials', 'secrets', 'tokens', 'node_modules'].includes(value)) {
      throw new Error(`Protected workspace path component is not writable: ${value}`);
    }
  }
  return relative;
}

function canonicalRoot(root: string): string {
  const canonical = ioMessageOrThrow('Failed to resolve workspace root', () => fs.realpathSync.native(root));
  const metadata = ioMessageOrThrow('Failed to inspect workspace root', () => fs.lstatSync(canonical));
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Workspace root must be a real directory');
  return canonical;
}

function ioMessageOrThrow<T>(label: string, operation: () => T): T {
  try { return operation(); } catch (error) { throw new Error(`${label}: ${ioMessage(error)}`); }
}

function ensureRealParent(root: string, relative: string, create: boolean): string {
  let parent = root;
  const relativeParent = path.dirname(relative);
  if (relativeParent !== '.' && relativeParent !== '') {
    for (const name of relativeParent.split(path.sep)) {
      if (!name || name === '.') continue;
      parent = path.join(parent, name);
      if (create) {
        try { fs.mkdirSync(parent); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw new Error(`Failed to create workspace parent: ${ioMessage(error)}`);
          }
        }
      }
      const metadata = ioMessageOrThrow('Failed to inspect workspace parent', () => fs.lstatSync(parent));
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Workspace mutation paths cannot traverse symlinks');
      }
    }
  }
  const canonical = ioMessageOrThrow('Failed to resolve workspace parent', () => fs.realpathSync.native(parent));
  if (!isWithin(root, canonical)) throw new Error('Workspace mutation path escapes the selected root');
  return canonical;
}

function targetPath(root: string, relative: string, createParent: boolean): string {
  const parent = ensureRealParent(root, relative, createParent);
  const fileName = path.basename(relative);
  if (!fileName) throw new Error('Workspace target has no file name');
  return path.join(parent, fileName);
}

function openRegularNoFollow(target: string): RuntimeReadFile {
  const metadata = ioMessageOrThrow('Workspace file does not exist', () => fs.lstatSync(target));
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Workspace mutations support regular files only');
  }
  if (metadata.size > MAX_MUTATION_BYTES) throw new Error('Workspace file exceeds the mutation size limit');
  const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0));
  // workspace_change_set.rs:298–305: only Unix adds O_NOFOLLOW. Do not apply
  // runtime_roots' distinct Windows reparse/identity validation at this entry.
  const fd = ioMessageOrThrow('Failed to open workspace file safely', () => fs.openSync(target, flags));
  return runtimeReadFileFromFd(fd);
}

function readAndHash(target: string): { bytes: Buffer; sha256: string } {
  const file = openRegularNoFollow(target);
  try {
    const bytes = ioMessageOrThrow('Failed to read workspace file', () => readRuntimeFileToEnd(file));
    if (bytes.length > MAX_MUTATION_BYTES) throw new Error('Workspace file grew beyond the mutation size limit');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    file.close();
  }
}

function normalizeHash(expected: string): string {
  const normalized = rustTrim(expected).toLowerCase();
  if (normalized.length !== 64 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error('Expected current hash must be a SHA-256 hex digest');
  }
  return normalized;
}

function verifyCurrentHash(target: string, expected: string): string {
  const wanted = normalizeHash(expected);
  const { sha256 } = readAndHash(target);
  if (sha256 !== wanted) {
    throw new Error(`Workspace file changed concurrently (expected ${wanted}, found ${sha256})`);
  }
  return sha256;
}

function stageFile(directory: string, prefix: string): { fd: number; target: string } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const target = path.join(directory, `${prefix}${randomBytes(8).toString('hex')}`);
    try { return { fd: fs.openSync(target, 'wx'), target }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new Error(`Failed to stage workspace write: ${ioMessage(error)}`);
    }
  }
  throw new Error('Failed to stage workspace write: too many collisions');
}

function persistNoClobber(stage: string, target: string): void {
  try {
    fs.linkSync(stage, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error('Failed to create workspace file: File exists (os error 17)');
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
      let fd: number;
      try { fd = fs.openSync(target, 'wx'); } catch (openError) {
        if ((openError as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Failed to create workspace file: File exists (os error 17)');
        }
        throw new Error(`Failed to create workspace file: ${ioMessage(openError)}`);
      }
      try {
        fs.writeFileSync(fd, fs.readFileSync(stage));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.unlinkSync(stage);
      return;
    }
    throw new Error(`Failed to create workspace file: ${ioMessage(error)}`);
  }
  fs.unlinkSync(stage);
}

function atomicWrite(target: string, bytes: Uint8Array, overwrite: boolean): void {
  if (bytes.length > MAX_MUTATION_BYTES) throw new Error('Workspace content exceeds the mutation size limit');
  const parent = path.dirname(target);
  if (!parent) throw new Error('Workspace target has no parent');
  const staged = stageFile(parent, '.stage-');
  try {
    ioMessageOrThrow('Failed to stage workspace content', () => writeAll(staged.fd, bytes));
    ioMessageOrThrow('Failed to sync workspace content', () => fs.fsyncSync(staged.fd));
    fs.closeSync(staged.fd);
    staged.fd = -1;
    if (overwrite) {
      ioMessageOrThrow('Failed to replace workspace file', () => fs.renameSync(staged.target, target));
    } else {
      persistNoClobber(staged.target, target);
    }
  } finally {
    if (staged.fd >= 0) { try { fs.closeSync(staged.fd); } catch (error) { ignoreCleanupError(error); } }
    try { fs.unlinkSync(staged.target); } catch (error) { ignoreCleanupError(error); }
  }
}

function checkpointDir(checkpointRoot: string): string {
  ioMessageOrThrow('Failed to create checkpoint root', () => fs.mkdirSync(checkpointRoot, { recursive: true }));
  const root = ioMessageOrThrow('Failed to resolve checkpoint root', () => fs.realpathSync.native(checkpointRoot));
  const directory = path.join(root, CHECKPOINT_DIR);
  try { fs.mkdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Failed to create workspace checkpoint area: ${ioMessage(error)}`);
    }
  }
  const metadata = ioMessageOrThrow('Failed to inspect workspace checkpoint area', () => fs.lstatSync(directory));
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Workspace checkpoint area must be a real directory');
  return ioMessageOrThrow('Failed to resolve workspace checkpoint area', () => fs.realpathSync.native(directory));
}

function createCheckpoint(checkpointRoot: string, changeId: string, bytes: Buffer): string {
  const directory = checkpointDir(checkpointRoot);
  const name = `${changeId}.backup`;
  atomicWrite(path.join(directory, name), bytes, false);
  return `${CHECKPOINT_DIR}/${name}`;
}

function readCheckpoint(checkpointRoot: string, backupRef: string): Buffer {
  const relative = normalizeRuntimeRelativePath(backupRef);
  const parts = relative.split(path.sep).filter(part => part !== '');
  if (parts.length !== 2 || parts[0] !== CHECKPOINT_DIR) throw new Error('Invalid workspace checkpoint reference');
  const directory = checkpointDir(checkpointRoot);
  return readAndHash(path.join(directory, parts[1]!)).bytes;
}

export function recordExternalChanges(
  checkpointRoot: string,
  rootId: string,
  before: ExternalFileSnapshot,
  after: ExternalFileSnapshot,
): ChangeSet {
  const changeSetId = nextChangeId();
  const changes: MutationReceipt[] = [];
  for (const filePath of [...after.keys()].sort(byteCompare)) {
    const current = after.get(filePath)!;
    const previous = before.get(filePath);
    if (!previous) {
      changes.push({
        change_id: nextChangeId(), root_id: rootId, op: 'created', relative_path: filePath,
        after_hash: current.sha256, bytes: current.bytes.length,
      });
    } else if (previous.sha256 !== current.sha256) {
      const changeId = nextChangeId();
      const backupRef = createCheckpoint(checkpointRoot, changeId, previous.bytes);
      changes.push({
        change_id: changeId, root_id: rootId, op: 'modified', relative_path: filePath,
        before_hash: previous.sha256, after_hash: current.sha256, backup_ref: backupRef,
        bytes: current.bytes.length,
      });
    }
  }
  for (const filePath of [...before.keys()].sort(byteCompare)) {
    if (after.has(filePath)) continue;
    const previous = before.get(filePath)!;
    const changeId = nextChangeId();
    const backupRef = createCheckpoint(checkpointRoot, changeId, previous.bytes);
    changes.push({
      change_id: changeId, root_id: rootId, op: 'deleted', relative_path: filePath,
      before_hash: previous.sha256, backup_ref: backupRef, bytes: previous.bytes.length,
    });
  }
  changes.sort((left, right) => byteCompare(left.relative_path, right.relative_path));
  return { id: changeSetId, changes };
}

export function rollbackChangeSet(root: string, checkpointRoot: string, changeSet: ChangeSet<number | bigint>): RollbackChangeSetResult {
  const items: RollbackItemResult[] = [];
  for (const receipt of [...changeSet.changes].reverse()) {
    try {
      rollback(root, checkpointRoot, receipt);
      items.push({ change_id: receipt.change_id, relative_path: receipt.relative_path, reverted: true });
    } catch (error) {
      items.push({
        change_id: receipt.change_id, relative_path: receipt.relative_path, reverted: false,
        error: (error as Error).message,
      });
    }
  }
  const revertedCount = items.filter(item => item.reverted).length;
  return {
    change_set_id: changeSet.id, complete: revertedCount === items.length,
    reverted_count: revertedCount, failed_count: items.length - revertedCount, items,
  };
}

export function rollback(root: string, checkpointRoot: string, receipt: MutationReceipt<number | bigint>): void {
  const canonical = canonicalRoot(root);
  const relative = normalizeMutationPath(receipt.relative_path);
  const target = targetPath(canonical, relative, receipt.op === 'deleted');
  if (receipt.op === 'created') {
    if (receipt.after_hash == null) throw new Error('Created receipt lacks after_hash');
    verifyCurrentHash(target, receipt.after_hash);
    ioMessageOrThrow('Failed to rollback created file', () => fs.unlinkSync(target));
    return;
  }
  if (receipt.op === 'modified') {
    if (receipt.after_hash == null) throw new Error('Modified receipt lacks after_hash');
    verifyCurrentHash(target, receipt.after_hash);
    if (receipt.backup_ref == null) throw new Error('Modified receipt lacks backup_ref');
    const backup = readCheckpoint(checkpointRoot, receipt.backup_ref);
    atomicWrite(target, backup, true);
    return;
  }
  if (receipt.op === 'deleted') {
    let exists = true;
    try { fs.lstatSync(target); } catch { exists = false; }
    if (exists) throw new Error('Workspace path was recreated after deletion; refusing stale rollback');
    if (receipt.backup_ref == null) throw new Error('Deleted receipt lacks backup_ref');
    const backup = readCheckpoint(checkpointRoot, receipt.backup_ref);
    atomicWrite(target, backup, false);
    return;
  }
  if (receipt.op === 'moved') {
    let exists = true;
    try { fs.lstatSync(target); } catch { exists = false; }
    if (exists) throw new Error('Move source was recreated; refusing stale rollback');
    if (receipt.destination_path == null) throw new Error('Moved receipt lacks destination_path');
    const destinationRelative = normalizeMutationPath(receipt.destination_path);
    const destination = targetPath(canonical, destinationRelative, false);
    if (receipt.after_hash == null) throw new Error('Moved receipt lacks after_hash');
    verifyCurrentHash(destination, receipt.after_hash);
    try { moveRegularFile(destination, target); } catch (error) {
      throw new Error(`Failed to rollback moved file: ${(error as Error).message}`);
    }
  }
}

function isCrossDeviceError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EXDEV';
}

function moveRegularFile(source: string, destination: string): void {
  try { fs.renameSync(source, destination); return; } catch (error) {
    if (!isCrossDeviceError(error)) throw new Error(`Failed to move workspace file: ${ioMessage(error)}`);
  }
  const { bytes } = readAndHash(source);
  atomicWrite(destination, bytes, false);
  try { fs.unlinkSync(source); } catch (error) {
    try { fs.unlinkSync(destination); } catch (cleanupError) { ignoreCleanupError(cleanupError); }
    throw new Error(`Failed to remove move source after cross-volume copy: ${ioMessage(error)}`);
  }
}

export function writeText(
  root: string, checkpointRoot: string, rootId: string, rawPath: string, content: string,
  expectedCurrentHash?: string | null,
): MutationReceipt {
  return writeBytes(root, checkpointRoot, rootId, rawPath, Buffer.from(content, 'utf8'), expectedCurrentHash);
}

export function writeBytes(
  root: string, checkpointRoot: string, rootId: string, rawPath: string, content: Uint8Array,
  expectedCurrentHash?: string | null,
): MutationReceipt {
  const canonical = canonicalRoot(root);
  const relative = normalizeMutationPath(rawPath);
  const target = targetPath(canonical, relative, expectedCurrentHash == null);
  const changeId = nextChangeId();
  let existing: { bytes: Buffer; sha256: string } | null = null;
  let metadata: fs.Stats | null = null;
  try { metadata = fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Failed to inspect workspace target: ${ioMessage(error)}`);
    }
  }
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Workspace write target must be a regular file');
    }
    if (expectedCurrentHash == null) {
      throw new Error('expected_current_hash is required when overwriting an existing workspace file');
    }
    existing = readAndHash(target);
    verifyCurrentHash(target, expectedCurrentHash);
  } else if (expectedCurrentHash != null) {
    throw new Error('Expected-current-hash was supplied for a missing file');
  }
  const backupRef = existing ? createCheckpoint(checkpointRoot, changeId, existing.bytes) : undefined;
  atomicWrite(target, content, existing !== null);
  return {
    change_id: changeId,
    root_id: rootId,
    op: existing ? 'modified' : 'created',
    relative_path: displayRelative(relative),
    before_hash: existing?.sha256,
    after_hash: createHash('sha256').update(content).digest('hex'),
    backup_ref: backupRef,
    bytes: content.length,
  };
}

export function moveFile(
  root: string, rootId: string, rawSource: string, rawDestination: string, expectedCurrentHash: string,
): MutationReceipt {
  const canonical = canonicalRoot(root);
  const sourceRelative = normalizeMutationPath(rawSource);
  const destinationRelative = normalizeMutationPath(rawDestination);
  if (sourceRelative === destinationRelative) throw new Error('Move source and destination must differ');
  const source = targetPath(canonical, sourceRelative, false);
  const hash = verifyCurrentHash(source, expectedCurrentHash);
  const destination = targetPath(canonical, destinationRelative, true);
  let destinationExists = true;
  try { fs.lstatSync(destination); } catch { destinationExists = false; }
  if (destinationExists) throw new Error('Move destination already exists');
  moveRegularFile(source, destination);
  const changeId = nextChangeId();
  // workspace_change_set.rs:571–573: the move already succeeded; metadata is
  // best-effort and must not discard the receipt needed to undo that move.
  let bytes = 0;
  try { bytes = fs.statSync(destination).size; } catch { bytes = 0; }
  return {
    change_id: changeId, root_id: rootId, op: 'moved',
    relative_path: displayRelative(sourceRelative), destination_path: displayRelative(destinationRelative),
    before_hash: hash, after_hash: hash, bytes,
  };
}

export function deleteFile(
  root: string, checkpointRoot: string, rootId: string, rawPath: string, expectedCurrentHash: string,
): MutationReceipt {
  const canonical = canonicalRoot(root);
  const relative = normalizeMutationPath(rawPath);
  const target = targetPath(canonical, relative, false);
  verifyCurrentHash(target, expectedCurrentHash);
  const { bytes, sha256 } = readAndHash(target);
  const changeId = nextChangeId();
  const backupRef = createCheckpoint(checkpointRoot, changeId, bytes);
  ioMessageOrThrow('Failed to delete workspace file', () => fs.unlinkSync(target));
  return {
    change_id: changeId, root_id: rootId, op: 'deleted', relative_path: displayRelative(relative),
    before_hash: sha256, backup_ref: backupRef, bytes: bytes.length,
  };
}
