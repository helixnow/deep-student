/**
 * Non-Invasive In-Place Checkpoint Engine for `dstu.agent-mesh`.
 *
 * - Git mode: captures full working-tree state (staged + unstaged + untracked)
 *   using a temporary `GIT_INDEX_FILE` + `git write-tree` + `git commit-tree`
 *   stored under `refs/dstu-checkpoints/<sanitizedSessionId>/<seq>-<kind>`.
 *   Never touches `.git/index`, `HEAD`, `git stash`, or branch refs.
 * - Non-Git fallback: snapshots regular files into a SHA-256 content-addressed
 *   blob store under an app-managed checkpoint directory, exposing the exact
 *   same capture, diff, and user-edit-safe revert API.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

export const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_REF_PREFIX = 'refs/dstu-checkpoints';

const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'target',
  '.DS_Store',
  '.workspace_changes',
]);

const DIFF_CONCURRENCY = 8;
const MAX_LCS_LINES = 2500;

export type CheckpointKind = 'before' | 'after';

export type MeshDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface CheckpointCommitMetadata {
  checkpointId: string;
  chatSessionId: string;
  threadId: string;
  agentId: string;
  turnSeq: number;
  kind: CheckpointKind;
  createdAt: number;
}

export interface MeshCheckpoint {
  checkpointId: string;
  backend: 'git' | 'filesystem';
  rootPath: string;
  ref: string;
  commitSha?: string;
  treeSha?: string;
  chatSessionId: string;
  threadId: string;
  agentId: string;
  turnSeq: number;
  kind: CheckpointKind;
  createdAt: number;
  /** Root-relative POSIX path -> lowercase SHA-256 hex digest at snapshot time. */
  fileHashes: Record<string, string>;
}

export interface CaptureCheckpointInput {
  rootPath: string;
  chatSessionId: string;
  threadId?: string;
  agentId: string;
  turnSeq?: number;
  kind?: CheckpointKind;
  checkpointId?: string;
  createdAt?: number;
  storageDir?: string;
  maxFileBytes?: number;
}

export interface MeshDiffFileEntry {
  path: string;
  oldPath?: string;
  status: MeshDiffFileStatus;
  additions: number;
  deletions: number;
  patch: string;
  attributedAgentId?: string;
}

export interface MeshDiffReport {
  fromRef: string;
  toRef: string;
  backend: 'git' | 'filesystem';
  files: MeshDiffFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
  attributedAgentId?: string;
}

export interface RevertCheckpointOptions {
  paths?: string[];
  postTurnHashes?: Record<string, string>;
  forceOverwriteUserEdits?: boolean;
  storageDir?: string;
  maxFileBytes?: number;
}

export interface RevertCheckpointResult {
  checkpointRef: string;
  backend: 'git' | 'filesystem';
  complete: boolean;
  revertedPaths: string[];
  deletedPaths: string[];
  skippedUserModifiedPaths: string[];
}

export interface ShadowWorktreeHandle {
  kind: 'git-worktree' | 'directory-copy';
  rootPath: string;
  worktreePath: string;
  label: string;
  baseCommitSha?: string;
  createdAt: number;
}

export interface ShadowWorktreeOptions {
  parentDir?: string;
  storageDir?: string;
  maxFileBytes?: number;
}

interface GitRepoContext {
  canonicalRoot: string;
  gitTopLevel: string;
  gitDir: string;
  indexPath: string;
  repoSubPrefix: string;
}

interface NonGitFileRecord {
  sha256: string;
  size: number;
  mode: number;
}

interface NonGitManifest extends CheckpointCommitMetadata {
  backend: 'filesystem';
  rootPath: string;
  ref: string;
  files: Record<string, NonGitFileRecord>;
}

interface ExecGitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  maxBuffer?: number;
}

interface ExecGitBufferResult {
  stdout: Buffer;
  stderr: Buffer;
}

const sessionTurnCounters = new Map<string, number>();

function ignoreCleanupError(_error: unknown): void {
  /* Cleanup errors must never mask primary checkpoint outcomes. */
}

function toPosixPath(p: string): string {
  return p.replaceAll('\\', '/');
}

function normalizeRelativePosixPath(raw: string, canonicalRoot?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Checkpoint relative path cannot be empty');
  }
  let candidate = trimmed;
  if (canonicalRoot && path.isAbsolute(candidate)) {
    const rel = path.relative(canonicalRoot, candidate);
    candidate = rel;
  }
  const slashNormalized = toPosixPath(candidate).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  const parts = slashNormalized.split('/');
  const clean: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Checkpoint path cannot escape workspace root: ${raw}`);
    }
    clean.push(part);
  }
  if (clean.length === 0) {
    throw new Error(`Checkpoint path resolves to workspace root: ${raw}`);
  }
  return clean.join('/');
}

export function sanitizeCheckpointRefSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[./_-]+|[./_-]+$/g, '');
  if (!cleaned) return 'default';
  return cleaned.endsWith('.lock') ? `${cleaned}_` : cleaned;
}

function resolveCanonicalDirectory(dirPath: string): string {
  const resolved = fs.realpathSync.native(dirPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workspace root must be a real directory: ${dirPath}`);
  }
  return resolved;
}

function defaultStorageDirForRoot(canonicalRoot: string, explicitStorageDir?: string): string {
  const base = explicitStorageDir
    ? path.resolve(explicitStorageDir)
    : path.join(os.tmpdir(), 'dstu-agent-mesh-checkpoints');
  const rootKey = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 24);
  return path.join(base, rootKey);
}

function execGitBuffer(args: string[], options: ExecGitOptions): Promise<ExecGitBufferResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        encoding: 'buffer',
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr ?? '').trim();
          reject(new Error(`git ${args[0] ?? ''} failed: ${stderrText || error.message}`));
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ''),
        });
      },
    );
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

async function execGitText(args: string[], options: ExecGitOptions): Promise<string> {
  const { stdout } = await execGitBuffer(args, options);
  return stdout.toString('utf8');
}

function checkpointCommitEnv(tempIndexFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: 'DeepStudent Mesh Checkpoint',
    GIT_AUTHOR_EMAIL: 'mesh-checkpoint@deepstudent.local',
    GIT_COMMITTER_NAME: 'DeepStudent Mesh Checkpoint',
    GIT_COMMITTER_EMAIL: 'mesh-checkpoint@deepstudent.local',
  };
  if (tempIndexFile) {
    env.GIT_INDEX_FILE = tempIndexFile;
  }
  return env;
}

export async function detectGitWorkspace(rootPath: string): Promise<GitRepoContext | null> {
  const canonicalRoot = resolveCanonicalDirectory(rootPath);
  try {
    const inside = (await execGitText(['rev-parse', '--is-inside-work-tree'], { cwd: canonicalRoot })).trim();
    if (inside !== 'true') return null;
    const rawTopLevel = (await execGitText(['rev-parse', '--show-toplevel'], { cwd: canonicalRoot })).trim();
    if (!rawTopLevel) return null;
    const gitTopLevel = fs.realpathSync.native(rawTopLevel);
    const rawGitDir = (await execGitText(['rev-parse', '--git-dir'], { cwd: gitTopLevel })).trim();
    const rawIndexPath = (await execGitText(['rev-parse', '--git-path', 'index'], { cwd: gitTopLevel })).trim();
    const gitDir = path.resolve(gitTopLevel, rawGitDir);
    const indexPath = path.resolve(gitTopLevel, rawIndexPath);
    const relFromTop = toPosixPath(path.relative(gitTopLevel, canonicalRoot));
    if (relFromTop.startsWith('..')) {
      return null;
    }
    return {
      canonicalRoot,
      gitTopLevel,
      gitDir,
      indexPath,
      repoSubPrefix: relFromTop === '' ? '' : relFromTop,
    };
  } catch {
    return null;
  }
}

export async function isGitWorkingTree(rootPath: string): Promise<boolean> {
  const ctx = await detectGitWorkspace(rootPath);
  return ctx !== null;
}

function stripRepoSubPrefix(repoPath: string, repoSubPrefix: string): string | null {
  if (!repoSubPrefix) return repoPath;
  if (repoPath === repoSubPrefix) return null;
  const prefixWithSlash = `${repoSubPrefix}/`;
  if (!repoPath.startsWith(prefixWithSlash)) return null;
  return repoPath.slice(prefixWithSlash.length);
}

function addRepoSubPrefix(rootRelPath: string, repoSubPrefix: string): string {
  return repoSubPrefix ? `${repoSubPrefix}/${rootRelPath}` : rootRelPath;
}

function isWithinCanonicalRoot(canonicalRoot: string, candidatePath: string): boolean {
  const rel = path.relative(canonicalRoot, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ensureSafeParentSync(canonicalRoot: string, relativePosix: string, create: boolean): string {
  const segments = relativePosix.split('/');
  segments.pop();
  let current = canonicalRoot;
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    current = path.join(current, seg);
    if (create) {
      try {
        fs.mkdirSync(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to traverse non-directory or symlink parent: ${relativePosix}`);
    }
  }
  const realParent = fs.realpathSync.native(current);
  if (!isWithinCanonicalRoot(canonicalRoot, realParent)) {
    throw new Error(`Parent directory escapes workspace root: ${relativePosix}`);
  }
  return realParent;
}

function atomicWriteFileSync(targetFile: string, content: Buffer, mode = 0o644): void {
  const parent = path.dirname(targetFile);
  const tempName = `.dstu-ckpt-${process.pid}-${randomBytes(6).toString('hex')}`;
  const tempPath = path.join(parent, tempName);
  let fd = -1;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, targetFile);
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        ignoreCleanupError(err);
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (err) {
      ignoreCleanupError(err);
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readRegularFileSha256Sync(filePath: string, maxFileBytes: number): { bytes: Buffer; sha256: string; mode: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (stat.size > maxFileBytes) return null;
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > maxFileBytes) return null;
  const mode = (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
  return {
    bytes,
    sha256: sha256Hex(bytes),
    mode,
  };
}

function pruneEmptyParentsSync(canonicalRoot: string, deletedRelativePosix: string): void {
  let dir = path.dirname(path.join(canonicalRoot, ...deletedRelativePosix.split('/')));
  while (dir !== canonicalRoot && isWithinCanonicalRoot(canonicalRoot, dir)) {
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length > 0) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}

async function captureGitTreeWithTempIndex(gitCtx: GitRepoContext): Promise<string> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-git-idx-'));
  const tempIndexFile = path.join(tempDir, 'index');
  try {
    if (fs.existsSync(gitCtx.indexPath)) {
      await fsp.copyFile(gitCtx.indexPath, tempIndexFile);
    }
    const env = checkpointCommitEnv(tempIndexFile);
    const addTarget = gitCtx.repoSubPrefix ? gitCtx.canonicalRoot : '.';
    await execGitBuffer(['add', '-A', '--', addTarget], {
      cwd: gitCtx.gitTopLevel,
      env,
    });
    const treeSha = (await execGitText(['write-tree'], {
      cwd: gitCtx.gitTopLevel,
      env,
    })).trim();
    if (!treeSha) {
      throw new Error('git write-tree returned an empty tree SHA');
    }
    return treeSha;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(ignoreCleanupError);
  }
}

interface GitTreeEntry {
  mode: string;
  type: string;
  objectSha: string;
  repoPath: string;
  rootRelPath: string;
}

async function listGitTreeEntries(gitCtx: GitRepoContext, refOrTree: string): Promise<GitTreeEntry[]> {
  const args = ['ls-tree', '-r', '-z', refOrTree];
  if (gitCtx.repoSubPrefix) {
    args.push('--', gitCtx.repoSubPrefix);
  }
  const { stdout } = await execGitBuffer(args, { cwd: gitCtx.gitTopLevel });
  if (stdout.length === 0) return [];
  const rawRecords = stdout.toString('utf8').split('\0');
  const entries: GitTreeEntry[] = [];
  for (const rec of rawRecords) {
    if (!rec) continue;
    const tabIdx = rec.indexOf('\t');
    if (tabIdx < 0) continue;
    const header = rec.slice(0, tabIdx);
    const repoPath = rec.slice(tabIdx + 1);
    const [mode, type, objectSha] = header.trim().split(/\s+/);
    if (!mode || !type || !objectSha) continue;
    if (type !== 'blob') continue;
    if (mode === '120000') continue;
    const rootRelPath = stripRepoSubPrefix(repoPath, gitCtx.repoSubPrefix);
    if (!rootRelPath) continue;
    entries.push({ mode, type, objectSha, repoPath, rootRelPath });
  }
  return entries;
}

async function readGitBlob(gitCtx: GitRepoContext, blobSha: string): Promise<Buffer> {
  const { stdout } = await execGitBuffer(['cat-file', 'blob', blobSha], {
    cwd: gitCtx.gitTopLevel,
  });
  return stdout;
}

async function readGitCommitMetadata(gitCtx: GitRepoContext, ref: string): Promise<CheckpointCommitMetadata | null> {
  try {
    const commitType = (await execGitText(['cat-file', '-t', ref], { cwd: gitCtx.gitTopLevel })).trim();
    if (commitType !== 'commit') return null;
    const message = (await execGitText(['log', '-1', '--format=%B', ref], { cwd: gitCtx.gitTopLevel })).trim();
    if (!message.startsWith('{')) return null;
    const parsed = JSON.parse(message) as Partial<CheckpointCommitMetadata>;
    if (typeof parsed.checkpointId === 'string' && typeof parsed.agentId === 'string') {
      return {
        checkpointId: parsed.checkpointId,
        chatSessionId: parsed.chatSessionId ?? 'default',
        threadId: parsed.threadId ?? '',
        agentId: parsed.agentId,
        turnSeq: typeof parsed.turnSeq === 'number' ? parsed.turnSeq : 0,
        kind: parsed.kind === 'after' ? 'after' : 'before',
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function nextTurnSeqForSession(chatSessionId: string): number {
  const current = sessionTurnCounters.get(chatSessionId) ?? 0;
  const next = current + 1;
  sessionTurnCounters.set(chatSessionId, next);
  return next;
}

function walkNonGitWorkspaceSync(
  canonicalRoot: string,
  maxFileBytes: number,
  ignoredNames: ReadonlySet<string> = DEFAULT_IGNORED_NAMES,
): Map<string, { fullPath: string; bytes: Buffer; sha256: string; mode: number }> {
  const snapshot = new Map<string, { fullPath: string; bytes: Buffer; sha256: string; mode: number }>();

  const visitDir = (currentDir: string, relPrefix: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const realChild = fs.realpathSync.native(fullPath);
        if (!isWithinCanonicalRoot(canonicalRoot, realChild)) continue;
        visitDir(realChild, relPosix);
      } else if (entry.isFile()) {
        const fileData = readRegularFileSha256Sync(fullPath, maxFileBytes);
        if (!fileData) continue;
        snapshot.set(relPosix, {
          fullPath,
          bytes: fileData.bytes,
          sha256: fileData.sha256,
          mode: fileData.mode,
        });
      }
    }
  };

  visitDir(canonicalRoot, '');
  return snapshot;
}

function ensureNonGitStoreDirsSync(storeRoot: string): { blobsDir: string; manifestsDir: string; refsDir: string } {
  const blobsDir = path.join(storeRoot, 'blobs');
  const manifestsDir = path.join(storeRoot, 'manifests');
  const refsDir = path.join(storeRoot, 'refs');
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(manifestsDir, { recursive: true });
  fs.mkdirSync(refsDir, { recursive: true });
  return { blobsDir, manifestsDir, refsDir };
}

function writeBlobIfMissingSync(blobsDir: string, sha256: string, bytes: Buffer): void {
  const shardDir = path.join(blobsDir, sha256.slice(0, 2));
  fs.mkdirSync(shardDir, { recursive: true });
  const blobPath = path.join(shardDir, sha256);
  if (fs.existsSync(blobPath)) return;
  atomicWriteFileSync(blobPath, bytes, 0o600);
}

function readBlobSync(blobsDir: string, sha256: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Invalid checkpoint blob hash: ${sha256}`);
  }
  const blobPath = path.join(blobsDir, sha256.slice(0, 2), sha256);
  return fs.readFileSync(blobPath);
}

function resolveCheckpointRefString(refOrCheckpoint: string | MeshCheckpoint): string {
  if (typeof refOrCheckpoint === 'string') return refOrCheckpoint.trim();
  return refOrCheckpoint.ref || refOrCheckpoint.commitSha || refOrCheckpoint.checkpointId;
}

function loadNonGitManifestSync(storeRoot: string, refOrId: string | MeshCheckpoint): NonGitManifest {
  const { manifestsDir, refsDir } = ensureNonGitStoreDirsSync(storeRoot);
  if (typeof refOrId !== 'string') {
    const byIdPath = path.join(manifestsDir, `${sanitizeCheckpointRefSegment(refOrId.checkpointId)}.json`);
    if (fs.existsSync(byIdPath)) {
      return JSON.parse(fs.readFileSync(byIdPath, 'utf8')) as NonGitManifest;
    }
  }
  const refKey = resolveCheckpointRefString(refOrId);
  const directManifestPath = path.join(manifestsDir, `${sanitizeCheckpointRefSegment(refKey)}.json`);
  if (fs.existsSync(directManifestPath)) {
    return JSON.parse(fs.readFileSync(directManifestPath, 'utf8')) as NonGitManifest;
  }
  const stripped = refKey.startsWith(`${CHECKPOINT_REF_PREFIX}/`)
    ? refKey.slice(`${CHECKPOINT_REF_PREFIX}/`.length)
    : refKey;
  const parts = stripped.split('/').map(sanitizeCheckpointRefSegment);
  const refFilePath = path.join(refsDir, ...parts) + '.json';
  if (fs.existsSync(refFilePath)) {
    const pointer = JSON.parse(fs.readFileSync(refFilePath, 'utf8')) as { checkpointId: string };
    const targetManifest = path.join(manifestsDir, `${sanitizeCheckpointRefSegment(pointer.checkpointId)}.json`);
    return JSON.parse(fs.readFileSync(targetManifest, 'utf8')) as NonGitManifest;
  }
  throw new Error(`Checkpoint manifest not found for ref "${refKey}"`);
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

interface DiffEditOp {
  kind: 'equal' | 'add' | 'del';
  line: string;
  oldLineNo: number;
  newLineNo: number;
}

function computeLineOps(oldLines: string[], newLines: string[]): DiffEditOp[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const ops: DiffEditOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: 'equal', line: oldLines[i]!, oldLineNo: i + 1, newLineNo: i + 1 });
  }

  const midOld = oldLines.slice(prefix, oldEnd + 1);
  const midNew = newLines.slice(prefix, newEnd + 1);

  if (midOld.length === 0 && midNew.length === 0) {
    // Only shared prefix/suffix
  } else if (midOld.length + midNew.length > MAX_LCS_LINES) {
    let oldNo = prefix + 1;
    for (const line of midOld) {
      ops.push({ kind: 'del', line, oldLineNo: oldNo++, newLineNo: prefix + 1 });
    }
    let newNo = prefix + 1;
    for (const line of midNew) {
      ops.push({ kind: 'add', line, oldLineNo: oldEnd + 2, newLineNo: newNo++ });
    }
  } else {
    const m = midOld.length;
    const n = midNew.length;
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * width + j] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
        } else {
          const down = dp[(i + 1) * width + j] ?? 0;
          const right = dp[i * width + (j + 1)] ?? 0;
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        ops.push({
          kind: 'equal',
          line: midOld[i]!,
          oldLineNo: prefix + i + 1,
          newLineNo: prefix + j + 1,
        });
        i++;
        j++;
      } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
        ops.push({
          kind: 'del',
          line: midOld[i]!,
          oldLineNo: prefix + i + 1,
          newLineNo: prefix + j + 1,
        });
        i++;
      } else {
        ops.push({
          kind: 'add',
          line: midNew[j]!,
          oldLineNo: prefix + i + 1,
          newLineNo: prefix + j + 1,
        });
        j++;
      }
    }
    while (i < m) {
      ops.push({
        kind: 'del',
        line: midOld[i]!,
        oldLineNo: prefix + i + 1,
        newLineNo: prefix + j + 1,
      });
      i++;
    }
    while (j < n) {
      ops.push({
        kind: 'add',
        line: midNew[j]!,
        oldLineNo: prefix + i + 1,
        newLineNo: prefix + j + 1,
      });
      j++;
    }
  }

  const suffixCount = oldLines.length - 1 - oldEnd;
  for (let k = 0; k < suffixCount; k++) {
    const oi = oldEnd + 1 + k;
    const ni = newEnd + 1 + k;
    ops.push({ kind: 'equal', line: oldLines[oi]!, oldLineNo: oi + 1, newLineNo: ni + 1 });
  }
  return ops;
}

function buildUnifiedPatchFromBuffers(
  status: MeshDiffFileStatus,
  filePath: string,
  oldPath: string | undefined,
  oldBuf: Buffer | null,
  newBuf: Buffer | null,
): { additions: number; deletions: number; patch: string } {
  const fromHeader = status === 'added' ? '/dev/null' : `a/${oldPath ?? filePath}`;
  const toHeader = status === 'deleted' ? '/dev/null' : `b/${filePath}`;

  if ((oldBuf && isBinaryBuffer(oldBuf)) || (newBuf && isBinaryBuffer(newBuf))) {
    return {
      additions: 0,
      deletions: 0,
      patch: `--- ${fromHeader}\n+++ ${toHeader}\nBinary files differ\n`,
    };
  }

  const oldLines = oldBuf ? splitLinesForDiff(oldBuf.toString('utf8')) : [];
  const newLines = newBuf ? splitLinesForDiff(newBuf.toString('utf8')) : [];
  const ops = computeLineOps(oldLines, newLines);

  let additions = 0;
  let deletions = 0;
  const changedIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx]!;
    if (op.kind === 'add') {
      additions++;
      changedIndices.push(idx);
    } else if (op.kind === 'del') {
      deletions++;
      changedIndices.push(idx);
    }
  }

  if (changedIndices.length === 0) {
    const renameInfo = status === 'renamed' && oldPath
      ? `similarity index 100%\nrename from ${oldPath}\nrename to ${filePath}\n`
      : '';
    return { additions: 0, deletions: 0, patch: renameInfo };
  }

  const contextRadius = 3;
  const groups: Array<{ start: number; end: number }> = [];
  for (const cIdx of changedIndices) {
    const s = Math.max(0, cIdx - contextRadius);
    const e = Math.min(ops.length - 1, cIdx + contextRadius);
    const prev = groups.at(-1);
    if (prev && s <= prev.end + 1) {
      prev.end = Math.max(prev.end, e);
    } else {
      groups.push({ start: s, end: e });
    }
  }

  const outLines: string[] = [`--- ${fromHeader}`, `+++ ${toHeader}`];
  for (const g of groups) {
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    for (let i = g.start; i <= g.end; i++) {
      const op = ops[i]!;
      if (oldStart === 0 && (op.kind === 'equal' || op.kind === 'del')) oldStart = op.oldLineNo;
      if (newStart === 0 && (op.kind === 'equal' || op.kind === 'add')) newStart = op.newLineNo;
      if (op.kind !== 'add') oldCount++;
      if (op.kind !== 'del') newCount++;
    }
    if (oldCount === 0) oldStart = 0;
    if (newCount === 0) newStart = 0;
    outLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let i = g.start; i <= g.end; i++) {
      const op = ops[i]!;
      const prefix = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ';
      outLines.push(`${prefix}${op.line}`);
    }
  }

  return {
    additions,
    deletions,
    patch: `${outLines.join('\n')}\n`,
  };
}

/**
 * Captures a non-invasive in-place checkpoint of `input.rootPath`.
 */
export async function captureCheckpoint(input: CaptureCheckpointInput): Promise<MeshCheckpoint> {
  const canonicalRoot = resolveCanonicalDirectory(input.rootPath);
  const chatSessionId = input.chatSessionId || 'default';
  const threadId = input.threadId ?? '';
  const agentId = input.agentId || 'unknown';
  const kind: CheckpointKind = input.kind ?? 'before';
  const turnSeq = input.turnSeq ?? nextTurnSeqForSession(`${chatSessionId}:${kind}`);
  const checkpointId = input.checkpointId ?? `ckpt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const createdAt = input.createdAt ?? Date.now();
  const maxFileBytes = input.maxFileBytes ?? MAX_CHECKPOINT_FILE_BYTES;

  const sanitizedSession = sanitizeCheckpointRefSegment(chatSessionId);
  const ref = `${CHECKPOINT_REF_PREFIX}/${sanitizedSession}/${turnSeq}-${kind}`;

  const metadata: CheckpointCommitMetadata = {
    checkpointId,
    chatSessionId,
    threadId,
    agentId,
    turnSeq,
    kind,
    createdAt,
  };

  const gitCtx = await detectGitWorkspace(canonicalRoot);
  if (gitCtx) {
    const treeSha = await captureGitTreeWithTempIndex(gitCtx);
    const commitArgs = ['commit-tree', treeSha];
    try {
      const headSha = (await execGitText(['rev-parse', '--verify', 'HEAD'], { cwd: gitCtx.gitTopLevel })).trim();
      if (headSha) {
        commitArgs.push('-p', headSha);
      }
    } catch (unbornHeadError) {
      // Unborn HEAD (fresh `git init` repository) — create root checkpoint commit cleanly.
      ignoreCleanupError(unbornHeadError);
    }
    const commitSha = (await execGitText(commitArgs, {
      cwd: gitCtx.gitTopLevel,
      env: checkpointCommitEnv(),
      stdin: JSON.stringify(metadata),
    })).trim();

    await execGitBuffer(['update-ref', ref, commitSha], {
      cwd: gitCtx.gitTopLevel,
      env: checkpointCommitEnv(),
    });

    const treeEntries = await listGitTreeEntries(gitCtx, treeSha);
    const fileHashes: Record<string, string> = {};
    for (const entry of treeEntries) {
      const diskPath = path.join(gitCtx.canonicalRoot, ...entry.rootRelPath.split('/'));
      const diskInfo = readRegularFileSha256Sync(diskPath, maxFileBytes);
      if (diskInfo) {
        fileHashes[entry.rootRelPath] = diskInfo.sha256;
      } else {
        const blob = await readGitBlob(gitCtx, entry.objectSha);
        if (blob.length <= maxFileBytes) {
          fileHashes[entry.rootRelPath] = sha256Hex(blob);
        }
      }
    }

    return {
      checkpointId,
      backend: 'git',
      rootPath: canonicalRoot,
      ref,
      commitSha,
      treeSha,
      chatSessionId,
      threadId,
      agentId,
      turnSeq,
      kind,
      createdAt,
      fileHashes,
    };
  }

  // Non-Git content-addressed snapshot fallback
  const storeRoot = defaultStorageDirForRoot(canonicalRoot, input.storageDir);
  const { blobsDir, manifestsDir, refsDir } = ensureNonGitStoreDirsSync(storeRoot);
  const walked = walkNonGitWorkspaceSync(canonicalRoot, maxFileBytes);
  const filesRecord: Record<string, NonGitFileRecord> = {};
  const fileHashes: Record<string, string> = {};

  for (const [relPath, fileData] of walked.entries()) {
    writeBlobIfMissingSync(blobsDir, fileData.sha256, fileData.bytes);
    filesRecord[relPath] = {
      sha256: fileData.sha256,
      size: fileData.bytes.length,
      mode: fileData.mode,
    };
    fileHashes[relPath] = fileData.sha256;
  }

  const manifest: NonGitManifest = {
    ...metadata,
    backend: 'filesystem',
    rootPath: canonicalRoot,
    ref,
    files: filesRecord,
  };

  const manifestPath = path.join(manifestsDir, `${sanitizeCheckpointRefSegment(checkpointId)}.json`);
  atomicWriteFileSync(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 0o600);

  const sessionRefDir = path.join(refsDir, sanitizedSession);
  fs.mkdirSync(sessionRefDir, { recursive: true });
  const refPointerPath = path.join(sessionRefDir, `${sanitizeCheckpointRefSegment(`${turnSeq}-${kind}`)}.json`);
  atomicWriteFileSync(
    refPointerPath,
    Buffer.from(JSON.stringify({ checkpointId, ref, createdAt }), 'utf8'),
    0o600,
  );

  return {
    checkpointId,
    backend: 'filesystem',
    rootPath: canonicalRoot,
    ref,
    chatSessionId,
    threadId,
    agentId,
    turnSeq,
    kind,
    createdAt,
    fileHashes,
  };
}

async function diffGitRefs(
  gitCtx: GitRepoContext,
  fromRef: string,
  toRef: string,
  displayToRef: string,
  attributedAgentId?: string,
): Promise<MeshDiffReport> {
  const pathSpecArgs = gitCtx.repoSubPrefix ? ['--', gitCtx.repoSubPrefix] : [];
  const nameStatusOut = await execGitBuffer(
    ['diff', '--name-status', '-M', '-z', fromRef, toRef, ...pathSpecArgs],
    { cwd: gitCtx.gitTopLevel },
  );
  const numStatOut = await execGitBuffer(
    ['diff', '--numstat', '-M', '-z', fromRef, toRef, ...pathSpecArgs],
    { cwd: gitCtx.gitTopLevel },
  );

  interface RawGitChange {
    status: MeshDiffFileStatus;
    repoPath: string;
    oldRepoPath?: string;
    rootRelPath: string;
    oldRootRelPath?: string;
  }

  const rawChanges: RawGitChange[] = [];
  const nsTokens = nameStatusOut.stdout.toString('utf8').split('\0');
  let idx = 0;
  while (idx < nsTokens.length) {
    const statusToken = nsTokens[idx++];
    if (!statusToken) continue;
    const code = statusToken[0];
    if (code === 'R' || code === 'C') {
      const oldRepoPath = nsTokens[idx++] ?? '';
      const newRepoPath = nsTokens[idx++] ?? '';
      const rootRelPath = stripRepoSubPrefix(newRepoPath, gitCtx.repoSubPrefix);
      const oldRootRelPath = stripRepoSubPrefix(oldRepoPath, gitCtx.repoSubPrefix);
      if (!rootRelPath) continue;
      rawChanges.push({
        status: code === 'R' ? 'renamed' : 'added',
        repoPath: newRepoPath,
        oldRepoPath,
        rootRelPath,
        ...(oldRootRelPath ? { oldRootRelPath } : {}),
      });
    } else {
      const repoPath = nsTokens[idx++] ?? '';
      const rootRelPath = stripRepoSubPrefix(repoPath, gitCtx.repoSubPrefix);
      if (!rootRelPath) continue;
      const status: MeshDiffFileStatus = code === 'A'
        ? 'added'
        : code === 'D'
          ? 'deleted'
          : 'modified';
      rawChanges.push({ status, repoPath, rootRelPath });
    }
  }

  const statsByPath = new Map<string, { additions: number; deletions: number }>();
  const numTokens = numStatOut.stdout.toString('utf8').split('\0');
  let nIdx = 0;
  while (nIdx < numTokens.length) {
    const token = numTokens[nIdx++];
    if (!token) continue;
    const tab1 = token.indexOf('\t');
    const tab2 = tab1 >= 0 ? token.indexOf('\t', tab1 + 1) : -1;
    if (tab1 < 0 || tab2 < 0) continue;
    const addRaw = token.slice(0, tab1);
    const delRaw = token.slice(tab1 + 1, tab2);
    const rest = token.slice(tab2 + 1);
    let targetRepoPath = rest;
    if (rest === '') {
      // `-z` format for rename/copy puts `\0oldPath\0newPath\0` after the empty path slot
      const _oldPath = numTokens[nIdx++] ?? '';
      void _oldPath;
      targetRepoPath = numTokens[nIdx++] ?? '';
    }
    const additions = addRaw === '-' ? 0 : Number.parseInt(addRaw, 10) || 0;
    const deletions = delRaw === '-' ? 0 : Number.parseInt(delRaw, 10) || 0;
    statsByPath.set(targetRepoPath, { additions, deletions });
  }

  const files: MeshDiffFileEntry[] = new Array(rawChanges.length);
  for (let start = 0; start < rawChanges.length; start += DIFF_CONCURRENCY) {
    const slice = rawChanges.slice(start, start + DIFF_CONCURRENCY);
    await Promise.all(
      slice.map(async (change, offset) => {
        const diffPaths = change.oldRepoPath
          ? [change.oldRepoPath, change.repoPath]
          : [change.repoPath];
        const patch = await execGitText(
          [
            'diff',
            '--no-color',
            '--no-ext-diff',
            '-M',
            '--unified=3',
            fromRef,
            toRef,
            '--',
            ...diffPaths,
          ],
          { cwd: gitCtx.gitTopLevel },
        );
        const stat = statsByPath.get(change.repoPath) ?? { additions: 0, deletions: 0 };
        files[start + offset] = {
          path: change.rootRelPath,
          ...(change.oldRootRelPath ? { oldPath: change.oldRootRelPath } : {}),
          status: change.status,
          additions: stat.additions,
          deletions: stat.deletions,
          patch,
          ...(attributedAgentId ? { attributedAgentId } : {}),
        };
      }),
    );
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    fromRef,
    toRef: displayToRef,
    backend: 'git',
    files,
    totalAdditions,
    totalDeletions,
    ...(attributedAgentId ? { attributedAgentId } : {}),
  };
}

function diffNonGitSnapshotsSync(
  fromRefLabel: string,
  toRefLabel: string,
  fromFiles: ReadonlyMap<string, { sha256: string; getBytes: () => Buffer }>,
  toFiles: ReadonlyMap<string, { sha256: string; getBytes: () => Buffer }>,
  attributedAgentId?: string,
): MeshDiffReport {
  const pureDeleted = new Map<string, { sha256: string; getBytes: () => Buffer }>();
  const pureAdded = new Map<string, { sha256: string; getBytes: () => Buffer }>();
  const modifiedPaths: string[] = [];

  for (const [p, fromRec] of fromFiles.entries()) {
    const toRec = toFiles.get(p);
    if (!toRec) {
      pureDeleted.set(p, fromRec);
    } else if (toRec.sha256 !== fromRec.sha256) {
      modifiedPaths.push(p);
    }
  }
  for (const [p, toRec] of toFiles.entries()) {
    if (!fromFiles.has(p)) {
      pureAdded.set(p, toRec);
    }
  }

  // Exact hash rename pairing
  const deletedByHash = new Map<string, string[]>();
  for (const [delPath, delRec] of pureDeleted.entries()) {
    const list = deletedByHash.get(delRec.sha256) ?? [];
    list.push(delPath);
    deletedByHash.set(delRec.sha256, list);
  }

  const renames: Array<{ oldPath: string; newPath: string }> = [];
  for (const [addPath, addRec] of [...pureAdded.entries()]) {
    const candidates = deletedByHash.get(addRec.sha256);
    if (candidates && candidates.length > 0) {
      const oldPath = candidates.shift()!;
      pureDeleted.delete(oldPath);
      pureAdded.delete(addPath);
      renames.push({ oldPath, newPath: addPath });
    }
  }

  const files: MeshDiffFileEntry[] = [];

  for (const [addPath, addRec] of pureAdded.entries()) {
    const { additions, deletions, patch } = buildUnifiedPatchFromBuffers(
      'added',
      addPath,
      undefined,
      null,
      addRec.getBytes(),
    );
    files.push({
      path: addPath,
      status: 'added',
      additions,
      deletions,
      patch,
      ...(attributedAgentId ? { attributedAgentId } : {}),
    });
  }

  for (const modPath of modifiedPaths) {
    const fromRec = fromFiles.get(modPath)!;
    const toRec = toFiles.get(modPath)!;
    const { additions, deletions, patch } = buildUnifiedPatchFromBuffers(
      'modified',
      modPath,
      undefined,
      fromRec.getBytes(),
      toRec.getBytes(),
    );
    files.push({
      path: modPath,
      status: 'modified',
      additions,
      deletions,
      patch,
      ...(attributedAgentId ? { attributedAgentId } : {}),
    });
  }

  for (const [delPath, delRec] of pureDeleted.entries()) {
    const { additions, deletions, patch } = buildUnifiedPatchFromBuffers(
      'deleted',
      delPath,
      undefined,
      delRec.getBytes(),
      null,
    );
    files.push({
      path: delPath,
      status: 'deleted',
      additions,
      deletions,
      patch,
      ...(attributedAgentId ? { attributedAgentId } : {}),
    });
  }

  for (const ren of renames) {
    const { additions, deletions, patch } = buildUnifiedPatchFromBuffers(
      'renamed',
      ren.newPath,
      ren.oldPath,
      null,
      null,
    );
    files.push({
      path: ren.newPath,
      oldPath: ren.oldPath,
      status: 'renamed',
      additions,
      deletions,
      patch,
      ...(attributedAgentId ? { attributedAgentId } : {}),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    fromRef: fromRefLabel,
    toRef: toRefLabel,
    backend: 'filesystem',
    files,
    totalAdditions,
    totalDeletions,
    ...(attributedAgentId ? { attributedAgentId } : {}),
  };
}

/**
 * Computes structured unified diff between two checkpoints (Git refs or Non-Git manifests).
 */
export async function diffCheckpoints(
  rootPath: string,
  fromRef: string | MeshCheckpoint,
  toRef: string | MeshCheckpoint,
  options?: { storageDir?: string },
): Promise<MeshDiffReport> {
  const canonicalRoot = resolveCanonicalDirectory(rootPath);
  const fromRefStr = resolveCheckpointRefString(fromRef);
  const toRefStr = resolveCheckpointRefString(toRef);

  const gitCtx = await detectGitWorkspace(canonicalRoot);
  if (gitCtx) {
    const toMeta = await readGitCommitMetadata(gitCtx, toRefStr);
    const attributedAgentId = toMeta?.agentId ?? (typeof toRef !== 'string' ? toRef.agentId : undefined);
    return diffGitRefs(gitCtx, fromRefStr, toRefStr, toRefStr, attributedAgentId);
  }

  const storeRoot = defaultStorageDirForRoot(canonicalRoot, options?.storageDir);
  const { blobsDir } = ensureNonGitStoreDirsSync(storeRoot);
  const fromManifest = loadNonGitManifestSync(storeRoot, fromRef);
  const toManifest = loadNonGitManifestSync(storeRoot, toRef);

  const fromMap = new Map<string, { sha256: string; getBytes: () => Buffer }>();
  for (const [relPath, rec] of Object.entries(fromManifest.files)) {
    fromMap.set(relPath, {
      sha256: rec.sha256,
      getBytes: () => readBlobSync(blobsDir, rec.sha256),
    });
  }
  const toMap = new Map<string, { sha256: string; getBytes: () => Buffer }>();
  for (const [relPath, rec] of Object.entries(toManifest.files)) {
    toMap.set(relPath, {
      sha256: rec.sha256,
      getBytes: () => readBlobSync(blobsDir, rec.sha256),
    });
  }

  return diffNonGitSnapshotsSync(
    fromRefStr,
    toRefStr,
    fromMap,
    toMap,
    toManifest.agentId,
  );
}

/**
 * Computes structured unified diff from `fromRef` to the live working tree
 * (including unstaged edits, deletions, and untracked files) without mutating `.git/index`.
 */
export async function diffWorkingTreeFromCheckpoint(
  rootPath: string,
  fromRef: string | MeshCheckpoint,
  options?: { storageDir?: string; maxFileBytes?: number },
): Promise<MeshDiffReport> {
  const canonicalRoot = resolveCanonicalDirectory(rootPath);
  const fromRefStr = resolveCheckpointRefString(fromRef);
  const maxFileBytes = options?.maxFileBytes ?? MAX_CHECKPOINT_FILE_BYTES;

  const gitCtx = await detectGitWorkspace(canonicalRoot);
  if (gitCtx) {
    const workingTreeSha = await captureGitTreeWithTempIndex(gitCtx);
    return diffGitRefs(gitCtx, fromRefStr, workingTreeSha, 'WORKING_TREE');
  }

  const storeRoot = defaultStorageDirForRoot(canonicalRoot, options?.storageDir);
  const { blobsDir } = ensureNonGitStoreDirsSync(storeRoot);
  const fromManifest = loadNonGitManifestSync(storeRoot, fromRef);

  const fromMap = new Map<string, { sha256: string; getBytes: () => Buffer }>();
  for (const [relPath, rec] of Object.entries(fromManifest.files)) {
    fromMap.set(relPath, {
      sha256: rec.sha256,
      getBytes: () => readBlobSync(blobsDir, rec.sha256),
    });
  }

  const liveWalk = walkNonGitWorkspaceSync(canonicalRoot, maxFileBytes);
  const toMap = new Map<string, { sha256: string; getBytes: () => Buffer }>();
  for (const [relPath, fileData] of liveWalk.entries()) {
    toMap.set(relPath, {
      sha256: fileData.sha256,
      getBytes: () => fileData.bytes,
    });
  }

  return diffNonGitSnapshotsSync(fromRefStr, 'WORKING_TREE', fromMap, toMap);
}

function normalizePostTurnHashes(
  rawHashes: Record<string, string> | undefined,
  canonicalRoot: string,
): Map<string, string> | null {
  if (!rawHashes) return null;
  const normalized = new Map<string, string>();
  for (const [rawKey, rawVal] of Object.entries(rawHashes)) {
    const rel = normalizeRelativePosixPath(rawKey, canonicalRoot);
    normalized.set(rel, rawVal.trim().toLowerCase());
  }
  return normalized;
}

function buildSelectedPathsPredicate(
  pathsFilter: string[] | undefined,
  canonicalRoot: string,
): (relPosix: string) => boolean {
  if (!pathsFilter || pathsFilter.length === 0) {
    return () => true;
  }
  const exactSet = new Set<string>();
  const dirPrefixes: string[] = [];
  for (const raw of pathsFilter) {
    const rel = normalizeRelativePosixPath(raw, canonicalRoot);
    exactSet.add(rel);
    dirPrefixes.push(`${rel}/`);
  }
  return (relPosix: string): boolean => {
    if (exactSet.has(relPosix)) return true;
    return dirPrefixes.some((prefix) => relPosix.startsWith(prefix));
  };
}

/**
 * Safely reverts the live working tree (or selected `options.paths`) back to `targetCheckpoint`
 * in-place, never mutating `.git/index` or `HEAD`.
 *
 * When `options.postTurnHashes` is provided, any file whose current disk SHA-256 differs from
 * its `postTurnHashes` entry (or was newly created by the human after the turn) is skipped and
 * reported in `skippedUserModifiedPaths` unless `options.forceOverwriteUserEdits === true`.
 */
export async function revertToCheckpoint(
  rootPath: string,
  targetCheckpoint: string | MeshCheckpoint,
  options?: RevertCheckpointOptions,
): Promise<RevertCheckpointResult> {
  const canonicalRoot = resolveCanonicalDirectory(rootPath);
  const targetRefStr = resolveCheckpointRefString(targetCheckpoint);
  const forceOverwrite = options?.forceOverwriteUserEdits === true;
  const maxFileBytes = options?.maxFileBytes ?? MAX_CHECKPOINT_FILE_BYTES;
  const postTurnMap = normalizePostTurnHashes(options?.postTurnHashes, canonicalRoot);
  const matchesSelectedPath = buildSelectedPathsPredicate(options?.paths, canonicalRoot);

  const revertedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const skippedUserModifiedPaths: string[] = [];

  const gitCtx = await detectGitWorkspace(canonicalRoot);
  if (gitCtx) {
    const targetEntries = await listGitTreeEntries(gitCtx, targetRefStr);
    const targetByPath = new Map<string, GitTreeEntry>();
    for (const entry of targetEntries) {
      targetByPath.set(entry.rootRelPath, entry);
    }

    const liveTreeSha = await captureGitTreeWithTempIndex(gitCtx);
    const liveEntries = await listGitTreeEntries(gitCtx, liveTreeSha);
    const livePaths = new Set<string>(liveEntries.map((e) => e.rootRelPath));

    const allCandidatePaths = new Set<string>([
      ...targetByPath.keys(),
      ...livePaths,
    ]);

    for (const relPath of [...allCandidatePaths].sort()) {
      if (!matchesSelectedPath(relPath)) continue;

      const fullDiskPath = path.join(canonicalRoot, ...relPath.split('/'));
      const currentDisk = readRegularFileSha256Sync(fullDiskPath, maxFileBytes);
      const targetEntry = targetByPath.get(relPath);

      if (targetEntry) {
        const targetBytes = await readGitBlob(gitCtx, targetEntry.objectSha);
        const targetSha256 = sha256Hex(targetBytes);
        const targetMode = targetEntry.mode === '100755' ? 0o755 : 0o644;

        if (currentDisk && currentDisk.sha256 === targetSha256 && currentDisk.mode === targetMode) {
          continue;
        }

        if (!forceOverwrite && postTurnMap) {
          const expectedPostTurnSha = postTurnMap.get(relPath);
          if (expectedPostTurnSha === undefined) {
            // Agent deleted this file during the turn; only safe to restore if human did not recreate it.
            if (currentDisk !== null) {
              skippedUserModifiedPaths.push(relPath);
              continue;
            }
          } else if (currentDisk === null || currentDisk.sha256 !== expectedPostTurnSha) {
            skippedUserModifiedPaths.push(relPath);
            continue;
          }
        }

        const safeParent = ensureSafeParentSync(canonicalRoot, relPath, true);
        const targetFile = path.join(safeParent, path.posix.basename(relPath));
        atomicWriteFileSync(targetFile, targetBytes, targetMode);
        revertedPaths.push(relPath);
      } else {
        // File did not exist in targetCheckpoint (e.g. newly created untracked file during turn)
        if (!currentDisk && !fs.existsSync(fullDiskPath)) {
          continue;
        }
        if (!forceOverwrite && postTurnMap) {
          const expectedPostTurnSha = postTurnMap.get(relPath);
          if (expectedPostTurnSha === undefined || !currentDisk || currentDisk.sha256 !== expectedPostTurnSha) {
            skippedUserModifiedPaths.push(relPath);
            continue;
          }
        }
        ensureSafeParentSync(canonicalRoot, relPath, false);
        fs.unlinkSync(fullDiskPath);
        pruneEmptyParentsSync(canonicalRoot, relPath);
        deletedPaths.push(relPath);
      }
    }

    return {
      checkpointRef: targetRefStr,
      backend: 'git',
      complete: skippedUserModifiedPaths.length === 0,
      revertedPaths,
      deletedPaths,
      skippedUserModifiedPaths,
    };
  }

  // Non-Git directory revert
  const storeRoot = defaultStorageDirForRoot(canonicalRoot, options?.storageDir);
  const { blobsDir } = ensureNonGitStoreDirsSync(storeRoot);
  const targetManifest = loadNonGitManifestSync(storeRoot, targetCheckpoint);
  const liveWalk = walkNonGitWorkspaceSync(canonicalRoot, maxFileBytes);

  const allCandidatePaths = new Set<string>([
    ...Object.keys(targetManifest.files),
    ...liveWalk.keys(),
  ]);

  for (const relPath of [...allCandidatePaths].sort()) {
    if (!matchesSelectedPath(relPath)) continue;

    const currentDisk = liveWalk.get(relPath) ?? null;
    const targetRec = targetManifest.files[relPath];

    if (targetRec) {
      if (currentDisk && currentDisk.sha256 === targetRec.sha256 && currentDisk.mode === targetRec.mode) {
        continue;
      }

      if (!forceOverwrite && postTurnMap) {
        const expectedPostTurnSha = postTurnMap.get(relPath);
        if (expectedPostTurnSha === undefined) {
          if (currentDisk !== null) {
            skippedUserModifiedPaths.push(relPath);
            continue;
          }
        } else if (currentDisk === null || currentDisk.sha256 !== expectedPostTurnSha) {
          skippedUserModifiedPaths.push(relPath);
          continue;
        }
      }

      const blobBytes = readBlobSync(blobsDir, targetRec.sha256);
      const safeParent = ensureSafeParentSync(canonicalRoot, relPath, true);
      const targetFile = path.join(safeParent, path.posix.basename(relPath));
      atomicWriteFileSync(targetFile, blobBytes, targetRec.mode);
      revertedPaths.push(relPath);
    } else if (currentDisk) {
      if (!forceOverwrite && postTurnMap) {
        const expectedPostTurnSha = postTurnMap.get(relPath);
        if (expectedPostTurnSha === undefined || currentDisk.sha256 !== expectedPostTurnSha) {
          skippedUserModifiedPaths.push(relPath);
          continue;
        }
      }
      ensureSafeParentSync(canonicalRoot, relPath, false);
      fs.unlinkSync(currentDisk.fullPath);
      pruneEmptyParentsSync(canonicalRoot, relPath);
      deletedPaths.push(relPath);
    }
  }

  return {
    checkpointRef: targetRefStr,
    backend: 'filesystem',
    complete: skippedUserModifiedPaths.length === 0,
    revertedPaths,
    deletedPaths,
    skippedUserModifiedPaths,
  };
}

/**
 * Explicit opt-in helper for same-file competitive race mode ONLY (never forced by default).
 * Creates an isolated shadow worktree seeded with the current working-tree state (including dirty/untracked files).
 */
export async function createShadowWorktree(
  rootPath: string,
  label: string,
  options?: ShadowWorktreeOptions,
): Promise<ShadowWorktreeHandle> {
  const canonicalRoot = resolveCanonicalDirectory(rootPath);
  const safeLabel = sanitizeCheckpointRefSegment(label);
  const parentBase = options?.parentDir
    ? path.resolve(options.parentDir)
    : path.join(os.tmpdir(), 'dstu-mesh-shadow-worktrees');
  await fsp.mkdir(parentBase, { recursive: true });
  const worktreePath = await fsp.mkdtemp(path.join(parentBase, `${safeLabel}-`));

  const gitCtx = await detectGitWorkspace(canonicalRoot);
  if (gitCtx) {
    const seedCp = await captureCheckpoint({
      rootPath: gitCtx.gitTopLevel,
      chatSessionId: `shadow-${safeLabel}`,
      agentId: 'shadow-worktree',
      kind: 'before',
      ...(options?.storageDir ? { storageDir: options.storageDir } : {}),
      ...(options?.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
    });
    await fsp.rm(worktreePath, { recursive: true, force: true });
    await execGitBuffer(['worktree', 'add', '--detach', worktreePath, seedCp.commitSha!], {
      cwd: gitCtx.gitTopLevel,
      env: checkpointCommitEnv(),
    });
    const realWorktree = fs.realpathSync.native(worktreePath);
    const effectivePath = gitCtx.repoSubPrefix
      ? path.join(realWorktree, ...gitCtx.repoSubPrefix.split('/'))
      : realWorktree;
    return {
      kind: 'git-worktree',
      rootPath: canonicalRoot,
      worktreePath: effectivePath,
      label,
      ...(seedCp.commitSha ? { baseCommitSha: seedCp.commitSha } : {}),
      createdAt: Date.now(),
    };
  }

  const maxFileBytes = options?.maxFileBytes ?? MAX_CHECKPOINT_FILE_BYTES;
  const walked = walkNonGitWorkspaceSync(canonicalRoot, maxFileBytes);
  const realCopyRoot = fs.realpathSync.native(worktreePath);
  for (const [relPath, fileData] of walked.entries()) {
    const parent = ensureSafeParentSync(realCopyRoot, relPath, true);
    atomicWriteFileSync(path.join(parent, path.posix.basename(relPath)), fileData.bytes, fileData.mode);
  }
  return {
    kind: 'directory-copy',
    rootPath: canonicalRoot,
    worktreePath: realCopyRoot,
    label,
    createdAt: Date.now(),
  };
}

/**
 * Removes an opt-in shadow worktree created by `createShadowWorktree` without affecting the primary working tree.
 */
export async function removeShadowWorktree(
  rootPath: string,
  worktreeOrHandle: string | ShadowWorktreeHandle,
): Promise<void> {
  const canonicalRoot = resolveCanonicalDirectory(rootPath);
  const targetPath = typeof worktreeOrHandle === 'string'
    ? worktreeOrHandle
    : worktreeOrHandle.worktreePath;

  const gitCtx = await detectGitWorkspace(canonicalRoot);
  if (gitCtx) {
    let gitWorktreeRoot = targetPath;
    try {
      const top = (await execGitText(['rev-parse', '--show-toplevel'], { cwd: targetPath })).trim();
      if (top) gitWorktreeRoot = top;
    } catch (err) {
      ignoreCleanupError(err);
    }
    try {
      await execGitBuffer(['worktree', 'remove', '--force', gitWorktreeRoot], {
        cwd: gitCtx.gitTopLevel,
        env: checkpointCommitEnv(),
      });
    } catch (err) {
      ignoreCleanupError(err);
      await fsp.rm(gitWorktreeRoot, { recursive: true, force: true }).catch(ignoreCleanupError);
    }
    await execGitBuffer(['worktree', 'prune'], {
      cwd: gitCtx.gitTopLevel,
      env: checkpointCommitEnv(),
    }).catch(ignoreCleanupError);
    return;
  }

  await fsp.rm(targetPath, { recursive: true, force: true });
}

/**
 * Stateful CheckpointEngine wrapper convenient for dependency injection into `dstu.agent-mesh` orchestrator.
 */
export class CheckpointEngine {
  readonly #storageDir: string | undefined;
  readonly #maxFileBytes: number;
  readonly #checkpointsById = new Map<string, MeshCheckpoint>();

  constructor(options?: { storageDir?: string; maxFileBytes?: number }) {
    this.#storageDir = options?.storageDir;
    this.#maxFileBytes = options?.maxFileBytes ?? MAX_CHECKPOINT_FILE_BYTES;
  }

  async capture(input: CaptureCheckpointInput): Promise<MeshCheckpoint> {
    const cp = await captureCheckpoint({
      ...(this.#storageDir ? { storageDir: this.#storageDir } : {}),
      maxFileBytes: this.#maxFileBytes,
      ...input,
    });
    this.#checkpointsById.set(cp.checkpointId, cp);
    this.#checkpointsById.set(cp.ref, cp);
    return cp;
  }

  getRecordedCheckpoint(refOrId: string): MeshCheckpoint | undefined {
    return this.#checkpointsById.get(refOrId);
  }

  async diff(
    rootPath: string,
    fromRef: string | MeshCheckpoint,
    toRef: string | MeshCheckpoint,
  ): Promise<MeshDiffReport> {
    const resolvedFrom = typeof fromRef === 'string'
      ? (this.#checkpointsById.get(fromRef) ?? fromRef)
      : fromRef;
    const resolvedTo = typeof toRef === 'string'
      ? (this.#checkpointsById.get(toRef) ?? toRef)
      : toRef;
    return diffCheckpoints(rootPath, resolvedFrom, resolvedTo, {
      ...(this.#storageDir ? { storageDir: this.#storageDir } : {}),
    });
  }

  async diffWorkingTree(rootPath: string, fromRef: string | MeshCheckpoint): Promise<MeshDiffReport> {
    const resolvedFrom = typeof fromRef === 'string'
      ? (this.#checkpointsById.get(fromRef) ?? fromRef)
      : fromRef;
    return diffWorkingTreeFromCheckpoint(rootPath, resolvedFrom, {
      ...(this.#storageDir ? { storageDir: this.#storageDir } : {}),
      maxFileBytes: this.#maxFileBytes,
    });
  }

  async revert(
    rootPath: string,
    targetCheckpoint: string | MeshCheckpoint,
    options?: RevertCheckpointOptions,
  ): Promise<RevertCheckpointResult> {
    const resolvedTarget = typeof targetCheckpoint === 'string'
      ? (this.#checkpointsById.get(targetCheckpoint) ?? targetCheckpoint)
      : targetCheckpoint;
    return revertToCheckpoint(rootPath, resolvedTarget, {
      ...(this.#storageDir ? { storageDir: this.#storageDir } : {}),
      maxFileBytes: this.#maxFileBytes,
      ...options,
    });
  }

  async createShadowWorktree(
    rootPath: string,
    label: string,
    options?: ShadowWorktreeOptions,
  ): Promise<ShadowWorktreeHandle> {
    return createShadowWorktree(rootPath, label, {
      ...(this.#storageDir ? { storageDir: this.#storageDir } : {}),
      maxFileBytes: this.#maxFileBytes,
      ...options,
    });
  }

  async removeShadowWorktree(
    rootPath: string,
    worktreeOrHandle: string | ShadowWorktreeHandle,
  ): Promise<void> {
    return removeShadowWorktree(rootPath, worktreeOrHandle);
  }
}

export { addRepoSubPrefix };
