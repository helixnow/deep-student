/**
 * 移动端数据迁移：标准 Deep Student ZIP 备份的导出 / 导入 / 恢复。
 *
 * 与桌面 `host/plugins/backup` 的区别只在传输层：
 * - 桌面备份目录是真实文件系统；移动端的数据库在 `opfs-sahpool`（`ctx.storage`），资产在
 *   `ctx.files`（OPFS 普通目录）里，所以这里用 `VACUUM INTO` + `exportFile` 生成一致的库快照，
 *   再把 `vfs_blobs/` 与快照一起写进同一个 ZIP；
 * - ZIP 条目布局、m 清单模型与桌面一致（`vfs.db`、`chat_v2.db`、`mistakes.db`、`llm_usage.db`、
 *   `databases/audit.db`、`assets/vfs_blobs/…`），所以桌面导出的备份能在这里导入，这里导出的
 *   备份也能被桌面 0.15.x / 0.20.0 导入；
 * - 导入只解到 `recovery/backups/imports/<backupId>/`，真正覆盖活动槽由 `restore_backup` 执行：
 *   关闭全部连接 → `importDb` 写回 pool → 替换 `vfs_blobs/` → 请求主线程重载页面。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../kernel/core.ts';
import {
  MANIFEST_VERSION,
  markFull,
  markPartial,
  parseManifest,
  checkManifestCompatibility,
  validateUntrusted,
  validateForSlotRestore,
  newCoverageLedger,
  persistentDomainRegistry,
  updateCoverage,
  type BackupFile,
  type BackupManifest,
} from '../../plugins/backup/src/manifest-model.ts';
import { ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_PASSWORD_REQUIRED_CODE, SEALED_BACKUP_DECRYPT_FAILED_CODE } from '../../plugins/backup/src/zip-codes.ts';
import { archiveEntries, isPortableExcludedRelativePath, validateImportArchive, validateSecretsArchive } from '../../plugins/backup/src/zip-policy.ts';
import { catalog } from '../../plugins/backup/src/asset-catalog.ts';
import { sealBackupSecrets } from './backup-cipher.ts';
import { isFileNotFound, type FilesService, type WalkEntry } from '../files/api.ts';
import type { DatabaseName, MaintenanceLease } from '../storage/api.ts';
import { ZipReader, ZipWriter, type ZipEntry } from '../zip/core/index.ts';
import type { MobileStorageService } from './service.ts';
import type { SqliteDatabase, SqliteRuntime } from './sqlite-wasm.ts';
import { mobileRestoreIntentPath } from './restore-intent.ts';

/** 桌面 `DatabaseId::all_ordered()`：移动端同样按这个顺序导出。 */
const CORE_DATABASES = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const;
type CoreDatabase = (typeof CORE_DATABASES)[number];

/** 归档内路径（桌面 `createBackup` 用 `<id>.db`；vfs 的恢复目标是 `databases/vfs.db`）。 */
const ARCHIVE_DATABASE: Readonly<Record<CoreDatabase, string>> = {
  vfs: 'vfs.db',
  llm_usage: 'llm_usage.db',
  chat_v2: 'chat_v2.db',
  mistakes: 'mistakes.db',
};

const AUDIT_ARCHIVE = 'databases/audit.db';
const ASSET_ROOTS = catalog.map(([root]) => root);
const PERSISTENT_FILES = ['webview_settings.json', 'custom_grading_modes.json'] as const;
const ROOT_CRYPTO = '.master_key';
const SECURE_ROOT = '.secure';
const MAX_SECRET_PAYLOAD = 256 * 1024 * 1024;

function cryptoRelative(path: string): string | null {
  if (path === 'crypto/.master_key') return ROOT_CRYPTO;
  if (/^crypto\/\.secure\/(?:\.key_seed|[^/\\]+\.enc)$/.test(path)) return path.slice('crypto/'.length);
  return null;
}

async function* readChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

const MANIFEST_ENTRY = 'manifest.json';
const SQLITE_HEADER = 'SQLite format 3\0';
const MAX_ARCHIVE_ENTRIES = 100_000;
/** 单个数据库要整块读进 WebView 内存（`importDb` 只收完整字节）；超过上限直接拒绝而不是 OOM。 */
const MAX_DATABASE_BYTES = 1 << 30;
const MAX_MANIFEST_BYTES = 4 << 20;

export interface MobileBackupContext {
  readonly ctx: Context;
  readonly storage: MobileStorageService;
  readonly runtime: SqliteRuntime;
  readonly files: FilesService;
}

export interface MobileBackupSelection {
  databases: readonly CoreDatabase[];
  assetRoots: readonly string[];
  maxAssetSize?: number;
}

interface MobileRestoreIntent {
  id: string;
  previousBackupId?: string;
}

export interface MobileRestoreStartup {
  id: string;
  reason: string | null;
  previousBackupId: string | null;
  previousBackupBytes: number;
}

export interface BackupJobStart {
  job_id: string;
  kind: 'export' | 'import';
  status: 'queued';
  message: string;
}

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface JobResultPayload {
  success: boolean;
  output_path: string | null;
  resolved_path?: string | null;
  message: string | null;
  error: string | null;
  duration_ms: number | null;
  requires_restart: boolean;
  stats?: Record<string, unknown>;
}

interface JobState {
  job_id: string;
  kind: 'export' | 'import';
  status: JobStatus;
  phase: string;
  progress: number;
  message: string | null;
  processed_items: number;
  total_items: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  result?: JobResultPayload;
  startedInstant?: number;
  cancellable: boolean;
  cancelRequested?: boolean;
}

export class MobileBackupCancelled extends Error {}
type CheckBackup = () => void;

const now = (): string => new Date().toISOString();

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 逐条发送桌面同形 `backup-job-progress` 事件（前端 `waitForJobTerminal` 消费）。 */
class MobileBackupJobs {
  private readonly ctx: Context;
  private readonly states = new Map<string, JobState>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  get busy(): boolean {
    return [...this.states.values()].some(state => state.status === 'queued' || state.status === 'running');
  }

  create(kind: 'export' | 'import'): { id: string; update(update: Partial<JobState>): void; complete(result: JobResultPayload): void; check(): void; fail(message: string, cause?: unknown): void } {
    if (this.busy) throw new CommandError('已有备份任务运行，请等待完成');
    const id = `mobile-${this.ctx.crypto.randomUUID()}`;
    const state: JobState = {
      job_id: id, kind, status: 'queued', phase: 'queued', progress: 0, message: null,
      processed_items: 0, total_items: 0, created_at: now(), cancellable: true,
    };
    this.states.set(id, state);
    this.emit(state);
    const update = (patch: Partial<JobState>): void => {
      const current = this.states.get(id);
      if (!current) return;
      Object.assign(current, patch);
      if (patch.status === 'running' && current.started_at === undefined) current.started_at = now();
      if (patch.status === 'running' && current.startedInstant === undefined) current.startedInstant = performance.now();
      if (patch.progress !== undefined) current.progress = Math.min(100, Math.max(0, patch.progress));
      this.emit(current);
    };
    const finish = (status: JobStatus, message: string, result: JobResultPayload): void => {
      const current = this.states.get(id);
      if (!current) return;
      Object.assign(current, { status, phase: status === 'completed' ? 'completed' : 'failed', progress: 100, message, finished_at: now(), result, cancellable: false });
      this.emit(current);
    };
    return {
      id,
      update,
      complete: result => finish('completed', result.message ?? '完成', result),
      check: () => { if (state.cancelRequested) throw new MobileBackupCancelled('已取消备份任务'); },
      fail: (message, cause) => {
        const cancelled = cause instanceof MobileBackupCancelled || state.cancelRequested;
        if (cancelled) message = cause instanceof MobileBackupCancelled ? cause.message : '已取消备份任务';
        finish(cancelled ? 'cancelled' : 'failed', message, {
          success: false, output_path: null, message, error: cancelled ? null : message,
          duration_ms: this.duration(id), requires_restart: false,
        });
      },
    };
  }

  cancel(id: string): boolean {
    const state = this.states.get(id);
    if (!state?.cancellable || state.cancelRequested) return false;
    state.cancelRequested = true;
    state.cancellable = false;
    this.emit(state);
    return true;
  }

  get(id: string): Record<string, unknown> | null {
    const state = this.states.get(id);
    if (!state) return null;
    return {
      job_id: state.job_id,
      kind: state.kind,
      status: state.status,
      phase: state.phase,
      progress: state.progress,
      message: state.message,
      created_at: state.created_at,
      ...(state.started_at === undefined ? {} : { started_at: state.started_at }),
      ...(state.finished_at === undefined ? {} : { finished_at: state.finished_at }),
      ...(state.result === undefined ? {} : { result: { ...state.result } }),
      resumable: false,
      cancellable: state.cancellable,
    };
  }

  list(): Array<Record<string, unknown>> {
    return [...this.states.keys()].map(id => this.get(id)).filter((job): job is Record<string, unknown> => job !== null);
  }

  private duration(id: string): number | null {
    const state = this.states.get(id);
    return state?.startedInstant === undefined ? null : Math.trunc(performance.now() - state.startedInstant);
  }

  private emit(state: JobState): void {
    const payload = {
      job_id: state.job_id,
      kind: state.kind,
      status: state.status,
      phase: state.phase,
      progress: state.progress,
      message: state.message,
      processed_items: state.processed_items,
      total_items: state.total_items,
      eta_seconds: null,
      cancellable: state.cancellable,
      created_at: state.created_at,
      ...(state.started_at === undefined ? {} : { started_at: state.started_at }),
      ...(state.finished_at === undefined ? {} : { finished_at: state.finished_at }),
      ...(state.result === undefined ? {} : { result: { ...state.result } }),
    };
    try {
      this.ctx.backendEvents.emit('backup-job-progress', payload);
    } catch (error) {
      this.ctx.logger('storage').warn(`backup-job-progress emit failed: ${failureMessage(error)}`);
    }
  }
}

function backupId(prefix?: string): string {
  const stamp = now().replace(/[-:T]/g, '').replace(/\..*$/, '').replace(/(\d{8})(\d{6})/, '$1_$2');
  const random = Math.random().toString(16).slice(2, 10);
  return `${prefix ? `${prefix}_` : ''}${stamp}_${random}`;
}

function safeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (/[\0\r\n]/.test(normalized) || /^[A-Za-z]:/.test(normalized)) throw new CommandError(`备份包含不安全路径: ${path}`);
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new CommandError(`备份包含不安全路径: ${path}`);
  }
  return parts.join('/');
}

function bytesHeader(bytes: Uint8Array): string {
  return new TextDecoder('ascii').decode(bytes.subarray(0, SQLITE_HEADER.length));
}

function assertSqliteDatabase(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength < 512 || bytes.byteLength % 512 !== 0 || bytesHeader(bytes) !== SQLITE_HEADER) {
    throw new CommandError(`备份中的 ${label} 不是有效的 SQLite 数据库`);
  }
}

/** 还原归档条目到移动端注册库名；同时接受桌面扁平布局与旧包的 `databases/` 前缀。 */
function databaseForArchive(name: string): DatabaseName | null {
  const base = name.toLowerCase().replace(/^databases\//, '');
  switch (base) {
    case 'vfs.db': return 'vfs';
    case 'chat_v2.db': return 'chat_v2';
    case 'mistakes.db': return 'mistakes';
    case 'llm_usage.db': return 'llm_usage';
    case 'audit.db': return 'audit';
    default: return null;
  }
}

/** 暂存与读取统一用移动端的归档名：旧包 `databases/vfs.db` 也落到 `<stage>/vfs.db`。 */
function archiveForDatabase(database: DatabaseName): string {
  switch (database) {
    case 'vfs': return 'vfs.db';
    case 'audit': return AUDIT_ARCHIVE;
    case 'browser': return 'browser.db';
    default: return `${database}.db`;
  }
}

function assetRelative(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (normalized.endsWith('/')) return null;
  const relative = normalized.replace(/^assets\//, '');
  if (ASSET_ROOTS.some(root => relative.startsWith(`${root}/`))) return safeArchivePath(relative);
  return null;
}

/** One path map for extraction and verification of the published stage. */
function stagedArchiveTarget(archive: string): string | null {
  safeArchivePath(archive);
  const db = databaseForArchive(archive);
  if (db) return archiveForDatabase(db);
  const asset = assetRelative(archive);
  if (asset && !asset.startsWith('workspaces/agents/')) return `live/${asset}`;
  if (/^workspaces\/ws_[A-Za-z0-9_-]+\.db$/.test(archive)) return `live/${archive}`;
  const secret = cryptoRelative(archive);
  if (secret) return `root/${secret}`;
  const persistent = PERSISTENT_FILES.find(name => archive === `persistent/${name}`);
  return persistent ? `live/${persistent}` : null;
}

function declaredArchiveFiles(manifest: BackupManifest): Map<string, BackupFile> {
  const declared = new Map(manifest.files.map(file => [file.path, file]));
  for (const asset of manifest.assets?.files ?? []) {
    if (asset.is_directory || declared.has(asset.relative_path)) continue;
    declared.set(asset.relative_path, { path: asset.relative_path, size: asset.size, sha256: asset.checksum ?? '' });
  }
  return declared;
}

interface BlobReference { path: string; sha256: string; size: number }

function readRows(database: SqliteDatabase, sql: string, columns: number, read: (row: unknown[]) => void): void {
  const query = database.prepare(sql);
  try {
    while (query.step()) read(Array.from({ length: columns }, (_, column) => query.get(column)));
  } finally { query.finalize(); }
}

export class MobileBackupService {
  readonly jobs: MobileBackupJobs;
  private readonly ctx: Context;
  private readonly storage: MobileStorageService;
  private readonly runtime: SqliteRuntime;
  private readonly filesService: FilesService;

  constructor(options: MobileBackupContext) {
    this.ctx = options.ctx;
    this.storage = options.storage;
    this.runtime = options.runtime;
    this.filesService = options.files;
    this.jobs = new MobileBackupJobs(options.ctx);
  }

  private get files() { return this.filesService; }

  get backupRoot(): string {
    return this.files.backupRoot;
  }

  async removeBackup(id: string): Promise<boolean> {
    this.stageDirectory(id);
    if (this.jobs.busy || await this.files.exists(this.restoreIntent)) throw new CommandError('备份或恢复正在进行');
    const path = await this.existingZip(id);
    if (!path) return false;
    // Retain the user's archive outside the list rather than deleting the only possible recovery copy.
    await this.files.rename(path, `${this.backupRoot}/archived/${id}-${this.ctx.crypto.randomUUID()}.zip`, { overwrite: false, createParents: true });
    return true;
  }

  async describeBackup(path: string) {
    const zip = await this.openZip(path);
    try {
      const manifest = await this.manifestOf(zip.reader);
      const full = manifest.snapshot_kind === 'full';
      if (full) validateForSlotRestore(manifest);
      return { backup_type: full ? 'full' : 'tiered', recovery_kind: full ? 'disaster_recovery' : 'partial_archive',
        restorable: full, databases: Object.keys(manifest.schema_versions) };
    } finally { await zip.close(); }
  }

  /** 已导出的同名 ZIP（`run_backup` 之后 `export_zip` 直接复用，不重复扫描数据库）。 */
  async existingZip(id: string): Promise<string | null> {
    const path = `${this.backupRoot}/${id}.zip`;
    return (await this.files.exists(path).catch(() => false)) ? path : null;
  }

  /** 交给主线程 Web Share / File System Access / 浏览器下载；失败不影响备份本身。 */
  async deliver(zipPath: string, fileName: string): Promise<string> {
    const answer = await this.ctx.shell.request<{ method?: string }>('mobile:save-backup', { path: zipPath, fileName });
    if (typeof answer?.method !== 'string') throw new CommandError('系统没有完成备份文件保存');
    return answer.method;
  }

  /** 让主线程重载页面，结束旧 Worker 与旧连接。 */
  async requestRestart(): Promise<void> {
    try {
      await this.ctx.shell.request('process.restart');
    } catch (error) {
      this.ctx.logger('storage').warn(`请求应用重载失败: ${failureMessage(error)}`);
    }
  }

  /** `recovery/backups/imports/<id>/` 的字节数（磁盘空间预检）。 */
  async stagedSize(id: string): Promise<number> {
    const stageDir = this.stageDirectory(id);
    if (!await this.files.exists(stageDir)) {
      const local = await this.existingZip(id);
      if (!local) throw new CommandError(`备份不存在：${id}`);
      const zip = await this.openZip(local);
      try { return zip.reader.entries.reduce((total, entry) => total + entry.size, 0); }
      finally { await zip.close(); }
    }
    let size = 0;
    try {
      for await (const entry of this.files.walk(stageDir, { includeDirectories: false })) {
        if (entry.kind === 'file') size += (await this.files.stat(entry.path)).size;
      }
    } catch {
      return 0;
    }
    return size;
  }

  /** 把活动槽的全部核心库 + 审计库 + vfs_blobs 写进一个标准 ZIP。 */
  async exportBackup(id: string, outputPath?: string | null, onProgress?: (done: number, total: number, file: string) => void, selection?: MobileBackupSelection, check?: CheckBackup, publish?: () => void): Promise<{ zipPath: string; fileCount: number; totalSize: number; compressedSize: number; backupId: string }> {
    const zipPath = outputPath && outputPath.startsWith('/') ? outputPath : `${this.backupRoot}/${id}.zip`;
    await this.files.mkdir(this.backupRoot, { recursive: true }).catch(() => undefined);
    const partial = `${zipPath}.in-progress`;
    const sink = await this.files.openFile(partial, { mode: 'truncate', createParents: true });
    let published = false;
    const writer = new ZipWriter({
      write: async (data, position) => { await sink.write(data, position); },
    }, { label: 'mobile-backup-export' });
    const files: BackupFile[] = [];
    const addFile = async (source: string, path: string): Promise<void> => {
      const hasher = this.ctx.crypto.createHasher('SHA-256');
      const sizeHint = (await this.files.stat(source)).size;
      let size = 0;
      await writer.addStream(path, readChunks(await this.files.openRead(source)), {
        compression: 'stored', sizeHint,
        onData: chunk => { check?.(); size += chunk.byteLength; hasher.update(chunk); },
      });
      files.push({ path, size, sha256: hasher.digestHex() });
      totalSize += size;
      fileCount += 1;
    };
    let totalSize = 0;
    let fileCount = 0;
    const staging: string[] = [];
    let attachments: BlobReference[] = [];
    try {
      // 1. 数据库一致性快照：VACUUM INTO 到 pool 内的临时文件，再整块读出写进 ZIP。
      const audited: Array<CoreDatabase | 'audit'> = [...(selection?.databases ?? CORE_DATABASES)];
      if (!selection && this.runtime.exists(this.storage.pathOf('audit'))) audited.push('audit');
      for (const [index, name] of audited.entries()) {
        check?.();
        const archive = name === 'audit' ? null : ARCHIVE_DATABASE[name];
        const database = name === 'audit' ? 'audit' : name;
        const temp = `${this.storage.locations.baseDir}/backup-staging-${id}-${index}.db`;
        staging.push(temp);
        await this.storage.database(database).backupTo(temp);
        if (!selection && database === 'vfs') attachments = this.vfsBlobReferences(temp, check);
        const bytes = this.runtime.exportFile(temp);
        const archivePath = archive ?? AUDIT_ARCHIVE;
        assertSqliteDatabase(bytes, archivePath);
        const sha256 = await this.ctx.crypto.sha256Hex(bytes);
        await writer.addBytes(archivePath, bytes, { compression: 'stored' });
        const file: BackupFile = { path: archivePath, size: bytes.byteLength, sha256 };
        if (name !== 'audit') file.database_id = name;
        files.push(file);
        totalSize += bytes.byteLength;
        fileCount += 1;
        onProgress?.(index + 1, audited.length + 1, archivePath);
      }

      const { activeDir, baseDir } = this.storage.locations;
      const requiredAssetPaths = new Set(attachments.map(reference => reference.path));
      for (const root of selection?.assetRoots ?? ASSET_ROOTS) {
        for (const entry of await this.listFiles(`${activeDir}/${root}`)) {
          // Upload staging and crash remnants are not user assets.
          if (root === 'vfs_blobs' && !selection && !requiredAssetPaths.has(`${root}/${entry.relativePath}`)
            && (entry.relativePath.startsWith('.staging/') || entry.relativePath.endsWith('.tmp'))) continue;
          if (selection?.maxAssetSize != null && (await this.files.stat(entry.path)).size > selection.maxAssetSize) continue;
          await addFile(entry.path, `assets/${root}/${entry.relativePath}`);
        }
      }
      if (!selection) this.assertBlobEvidence(attachments, files, check);
      if (!selection) for (const name of PERSISTENT_FILES) {
        const source = `${activeDir}/${name}`;
        if (await this.files.exists(source)) await addFile(source, `persistent/${name}`);
      }
      if (!selection) {
        const master = `${baseDir}/${ROOT_CRYPTO}`;
        if (await this.files.exists(master)) await addFile(master, `crypto/${ROOT_CRYPTO}`);
        for (const entry of await this.listFiles(`${baseDir}/${SECURE_ROOT}`)) {
          const path = `crypto/${SECURE_ROOT}/${entry.relativePath}`;
          if (cryptoRelative(path) === null) throw new CommandError(`Unrecognized local secure store file: ${entry.relativePath}`);
          await addFile(entry.path, path);
        }
      }

      // 3. 清单最后写：它要引用上面每个文件的大小与 SHA-256。
      check?.();
      const manifest = this.buildManifest(id, files, selection === undefined);
      const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
      await writer.addBytes(MANIFEST_ENTRY, manifestBytes, { compression: 'stored' });
      const compressedSize = await writer.finish();
      await sink.sync();
      await sink.close();
      check?.();
      publish?.();
      await this.files.rename(partial, zipPath, { overwrite: false });
      published = true;
      return { zipPath, fileCount: fileCount + 1, totalSize: totalSize + manifestBytes.byteLength, compressedSize, backupId: id };
    } finally {
      await sink.close().catch(() => undefined);
      if (!published) await this.files.rm(partial, { force: true }).catch(() => undefined);
      for (const temp of staging) {
        try { this.runtime.unlink(temp); }
        catch { /* boundary-allow empty-catch: pool file may already be gone */ }
      }
    }
  }

  private buildManifest(id: string, files: BackupFile[], full: boolean): BackupManifest {
    const manifest: BackupManifest = {
      version: MANIFEST_VERSION,
      app_version: this.ctx.app.version,
      created_at: now(),
      platform: 'mobile',
      schema_versions: {},
      files,
      is_incremental: false,
      incremental_base: null,
      backup_id: id,
      snapshot_kind: 'partial_overlay',
      snapshot_epoch: this.ctx.crypto.randomUUID(),
      required_components: [],
      included_components: [],
      key_policy: files.some(file => cryptoRelative(file.path) !== null) ? 'included_local' : 'not_present',
      coverage: newCoverageLedger(),
    };
    // markFull 要求每个持久域都有证据；先把没纳入的域标 absent，再覆盖实际导出的域。
    for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
    for (const name of CORE_DATABASES) {
      const file = files.find(candidate => candidate.database_id === name);
      if (!file) { if (full) throw new CommandError(`备份缺少核心数据库 ${name}`); continue; }
      updateCoverage(manifest, `database:${name}`, 'complete', [file.path]);
      try { manifest.schema_versions[name] = this.storage.migrations.currentVersion(name); }
      catch { manifest.schema_versions[name] = 0; }
    }
    const audit = files.find(candidate => candidate.path === AUDIT_ARCHIVE);
    updateCoverage(manifest, 'audit', audit ? 'complete' : 'absent', audit ? [audit.path] : []);
    const crypto = files.filter(file => cryptoRelative(file.path) !== null).map(file => file.path);
    updateCoverage(manifest, 'crypto', crypto.length ? 'complete' : 'absent', crypto);
    for (const [name, domain] of [['webview_settings.json', 'webview-settings'], ['custom_grading_modes.json', 'custom-grading-modes']] as const) {
      const path = `persistent/${name}`;
      if (files.some(file => file.path === path)) updateCoverage(manifest, domain, 'complete', [path]);
    }
    for (const root of ASSET_ROOTS) {
      const paths = files.filter(file => file.path.startsWith(`assets/${root}/`)).map(file => file.path);
      // The workspace asset tree has its own catalog entry; no executable trust is implied.
      updateCoverage(manifest, `asset-root:${root}`, paths.length ? 'complete' : 'empty', paths);
    }
    const assets = files.filter(file => file.path.startsWith('assets/')).map(file => {
      const original = file.path.slice('assets/'.length);
      return { relative_path: file.path, original_path: original, asset_type: original.split('/')[0] as typeof ASSET_ROOTS[number],
        size: file.size, is_directory: false, checksum: file.sha256 };
    });
    if (assets.length) {
      const byType: NonNullable<BackupManifest['assets']>['by_asset_type'] = {};
      for (const asset of assets) {
        const stats = byType[asset.asset_type] ??= { file_count: 0, total_size: 0 };
        stats.file_count++;
        stats.total_size += asset.size;
      }
      manifest.assets = {
        files: assets, total_files: assets.length, total_size: assets.reduce((sum, asset) => sum + asset.size, 0),
        skipped_files: 0, skip_reasons: {}, incomplete_asset_types: [], by_asset_type: byType,
        started_at: manifest.created_at, completed_at: manifest.created_at,
      };
      manifest.files = manifest.files.filter(file => !file.path.startsWith('assets/'));
    }
    if (full) markFull(manifest);
    else markPartial(manifest);
    return manifest;
  }

  private async listFiles(root: string): Promise<WalkEntry[]> {
    const exists = await this.files.exists(root);
    if (!exists) return [];
    const entries: WalkEntry[] = [];
    try {
      for await (const entry of this.files.walk(root, { includeDirectories: false })) {
        if (entry.kind === 'file') entries.push(entry);
      }
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }
    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private vfsBlobReferences(path: string, check?: CheckBackup): BlobReference[] {
    const database = this.runtime.open(path);
    const references = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string' && value !== '') references.add(value.toLowerCase());
    };
    try {
      database.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON');
      const fields = new Set<string>();
      readRows(database, 'PRAGMA table_info(files)', 2, row => { fields.add(String(row[1])); });
      // Counts include references managed outside files. Explicit file refs also cover older or
      // out-of-sync counts, deleted files in the trash, and broken foreign keys in imported DBs.
      readRows(database, 'SELECT blob_hash FROM files WHERE blob_hash IS NOT NULL', 1, row => collect(row[0]));
      if (fields.has('compressed_blob_hash')) {
        readRows(database, 'SELECT compressed_blob_hash FROM files WHERE compressed_blob_hash IS NOT NULL', 1, row => collect(row[0]));
      }
      if (fields.has('preview_json')) {
        readRows(database, "SELECT preview_json FROM files WHERE preview_json IS NOT NULL AND trim(preview_json) <> ''", 1, ([raw]) => {
          check?.();
          let preview: { pages?: Array<{ blobHash?: unknown; compressedBlobHash?: unknown } | null> } | null;
          try { preview = JSON.parse(String(raw)); }
          catch { throw new CommandError('备份 VFS 数据库包含无法读取的附件预览'); }
          if (Array.isArray(preview?.pages)) for (const page of preview.pages) {
            collect(page?.blobHash); collect(page?.compressedBlobHash);
          }
        });
      }
      const result: BlobReference[] = [];
      readRows(database, 'SELECT hash, relative_path, size, ref_count FROM blobs', 4, ([rawHash, relative, size, refCount]) => {
        check?.();
        const hash = String(rawHash).toLowerCase();
        if (!references.delete(hash) && Number(refCount) <= 0) return;
        if (!/^[a-f0-9]{64}$/.test(hash) || typeof relative !== 'string' || !Number.isSafeInteger(Number(size)) || Number(size) < 0) {
          throw new CommandError(`备份 VFS 附件元数据无效: ${hash}`);
        }
        result.push({ path: `vfs_blobs/${safeArchivePath(relative)}`, sha256: hash, size: Number(size) });
      });
      if (references.size) throw new CommandError(`备份 VFS 数据库缺少附件元数据: ${references.values().next().value}`);
      return result;
    } finally { database.close(); }
  }

  private async vfsBlobReferencesFromBytes(bytes: Uint8Array, check?: CheckBackup): Promise<BlobReference[]> {
    if (bytes.byteLength > MAX_DATABASE_BYTES) throw new CommandError('备份 VFS 数据库过大');
    assertSqliteDatabase(bytes, 'vfs.db');
    if (!this.runtime.importDb) throw new CommandError('当前运行时不支持验证备份数据库');
    const scratch = `${this.storage.locations.baseDir}/backup-validation-${this.ctx.crypto.randomUUID()}.db`;
    try {
      await this.runtime.importDb(scratch, bytes);
      check?.();
      return this.vfsBlobReferences(scratch, check);
    } finally { this.runtime.unlink(scratch); }
  }

  private async stagedBlobReferences(stage: string, check?: CheckBackup): Promise<BlobReference[]> {
    const path = `${stage}/vfs.db`;
    if ((await this.files.stat(path)).size > MAX_DATABASE_BYTES) throw new CommandError('备份 VFS 数据库过大');
    return this.vfsBlobReferencesFromBytes(await this.files.readBytes(path), check);
  }

  private assertBlobEvidence(references: readonly BlobReference[], evidence: readonly BackupFile[], check?: CheckBackup): void {
    const attachments = new Map<string, BackupFile>();
    for (const entry of evidence) {
      const path = assetRelative(entry.path);
      if (path?.startsWith('vfs_blobs/')) attachments.set(path, entry);
    }
    for (const reference of references) {
      check?.();
      const entry = attachments.get(reference.path);
      if (!entry) throw new CommandError(`备份缺少 VFS 附件: ${reference.path}`);
      if (reference.size !== entry.size || reference.sha256 !== entry.sha256.toLowerCase()) {
        throw new CommandError(`备份 VFS 附件内容损坏: ${reference.path}`);
      }
    }
  }

  private async verifyStagedBlobs(stage: string, check?: CheckBackup): Promise<void> {
    for (const reference of await this.stagedBlobReferences(stage, check)) {
      check?.();
      const file = `${stage}/live/${reference.path}`;
      const entry = await this.files.exists(file) ? await this.files.stat(file) : null;
      if (entry?.kind !== 'file') throw new CommandError(`备份缺少 VFS 附件: ${reference.path}`);
      if (entry.size !== reference.size) throw new CommandError(`备份 VFS 附件内容损坏: ${reference.path}`);
      const hash = this.ctx.crypto.createHasher('SHA-256');
      for await (const chunk of readChunks(await this.files.openRead(file))) { check?.(); hash.update(chunk); }
      if (hash.digestHex() !== reference.sha256) throw new CommandError(`备份 VFS 附件内容损坏: ${reference.path}`);
    }
  }

  private async openZip(path: string) {
    const file = await this.files.openFile(path, { mode: 'read' });
    try {
      const reader = await ZipReader.open({ size: file.size, read: (position, length) => file.read(position, length) }, {
        maxEntries: MAX_ARCHIVE_ENTRIES,
      });
      return { reader, close: () => file.close() };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  private async createZip(path: string, write: (writer: ZipWriter) => Promise<void>): Promise<number> {
    const file = await this.files.openFile(path, { mode: 'truncate', createParents: true });
    try {
      const writer = new ZipWriter({ write: async (data, position) => { await file.write(data, position); } });
      await write(writer);
      const size = await writer.finish();
      await file.sync();
      return size;
    } finally { await file.close(); }
  }

  private async manifestOf(reader: ZipReader): Promise<BackupManifest> {
    const entry = reader.entries.find(item => item.name === MANIFEST_ENTRY);
    if (!entry || entry.size > MAX_MANIFEST_BYTES) throw new CommandError('ZIP 备份缺少有效的 manifest.json');
    const manifest = parseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await reader.readEntry(entry))));
    validateUntrusted(manifest);
    checkManifestCompatibility(manifest);
    return manifest;
  }

  private temp(extension: string): string {
    return `${this.storage.locations.baseDir}/tmp/backups/${this.ctx.crypto.randomUUID()}.${extension}`;
  }

  private async cipherFile(input: ReadableStream<Uint8Array>, destination: string, password: string, encrypt: boolean): Promise<void> {
    const file = await this.files.openFile(destination, { mode: 'truncate', createParents: true });
    let position = 0;
    try {
      await sealBackupSecrets(this.ctx.crypto, password, input, new WritableStream({
        write: async (bytes: Uint8Array) => {
          if (position + bytes.byteLength > MAX_SECRET_PAYLOAD) throw new CommandError('加密备份载荷过大');
          await file.write(bytes, position);
          position += bytes.byteLength;
        },
      }), encrypt);
      await file.sync();
    } finally { await file.close(); }
  }

  async scanAssets(requested?: string[]) {
    const by_type: Record<string, { file_count: number; total_size: number }> = {};
    let total_files = 0;
    let total_size = 0;
    for (const root of ASSET_ROOTS) {
      if (requested?.length && !requested.includes(root)) continue;
      const entries = await this.listFiles(`${this.storage.locations.activeDir}/${root}`);
      let size = 0;
      for (const entry of entries) size += (await this.files.stat(entry.path)).size;
      by_type[root] = { file_count: entries.length, total_size: size };
      total_files += entries.length;
      total_size += size;
    }
    return { by_type, total_files, total_size };
  }

  async verifyBackup(id: string) {
    this.stageDirectory(id); // validate before constructing any paths
    const local = await this.existingZip(id);
    if (!local) throw new CommandError(`备份不存在：${id}`);
    return this.verifyBackupPath(local);
  }

  private async verifyBackupPath(local: string, check?: CheckBackup) {
    const databaseErrors: string[] = [];
    const assetErrors: Array<{ path: string; error_type: string; message: string }> = [];
    const databases = new Map<string, { id: string; is_valid: boolean; error: string | null }>();
    let assetCount = 0;
    const zip = await this.openZip(local);
    try {
      const manifest = await this.manifestOf(zip.reader);
      if (manifest.snapshot_kind === 'full') validateForSlotRestore(manifest);
      const entries = new Map(zip.reader.entries.filter(entry => !entry.isDirectory).map(entry => [entry.name, entry]));
      const verified: BackupFile[] = [];
      let vfs: ZipEntry | undefined;
      const verify = async (path: string, evidence: BackupFile, sqlite: boolean) => {
        const entry = entries.get(path);
        if (!entry) throw new Error(`备份缺少文件: ${path}`);
        await this.verifyEntry(zip.reader, entry, evidence, undefined, sqlite, check);
        verified.push(evidence);
        if (databaseForArchive(path) === 'vfs') vfs = entry;
      };
      for (const file of manifest.files) {
        const db = databaseForArchive(file.path);
        let failure: string | null = null;
        try { await verify(file.path, file, db !== null); }
        catch (error) { failure = failureMessage(error); databaseErrors.push(failure); }
        if (db) databases.set(db, { id: db, is_valid: failure === null, error: failure });
      }
      for (const asset of manifest.assets?.files ?? []) {
        if (asset.is_directory) continue;
        assetCount++;
        try {
          await verify(asset.relative_path, { path: asset.relative_path, size: asset.size, sha256: asset.checksum ?? '' }, false);
        } catch (error) {
          assetErrors.push({ path: asset.relative_path, error_type: 'checksum_mismatch', message: failureMessage(error) });
        }
      }
      if (manifest.snapshot_kind === 'full') {
        if (!vfs || vfs.size > MAX_DATABASE_BYTES) throw new CommandError('备份 VFS 数据库缺失或过大');
        this.assertBlobEvidence(await this.vfsBlobReferencesFromBytes(await zip.reader.readEntry(vfs), check), verified, check);
      }
    } catch (error) { databaseErrors.push(failureMessage(error)); }
    finally { await zip.close(); }
    const is_valid = databaseErrors.length === 0 && assetErrors.length === 0;
    return {
      base: { is_valid, checksum_match: is_valid, databases_verified: [...databases.values()], errors: [...databaseErrors, ...assetErrors.map(entry => entry.message)] },
      assets: { is_valid, database_errors: databaseErrors, asset_errors: assetErrors, has_assets: assetCount > 0, asset_file_count: assetCount },
    };
  }

  /** Export a desktop-compatible portable ZIP; only an authenticated sealed ZIP contains keys or audit. */
  async exportPortable(localPath: string, destination: string, password?: string, compressionLevel = 0, check?: CheckBackup): Promise<number> {
    const validation = await this.verifyBackupPath(localPath, check);
    check?.();
    if (!validation.base.is_valid) throw new CommandError(`无法导出无效备份：${validation.base.errors[0]}`);
    const zip = await this.openZip(localPath);
    const innerPath = this.temp('zip');
    const sealedPath = this.temp('dsbk');
    const compression = compressionLevel > 0 ? 'deflated' : 'stored';
    try {
      const manifest = await this.manifestOf(zip.reader);
      const portable = structuredClone(manifest);
      portable.files = portable.files.filter(file => !isPortableExcludedRelativePath(file.path));
      updateCoverage(portable, 'crypto', 'excluded', []);
      updateCoverage(portable, 'user-skills', 'excluded', []);
      updateCoverage(portable, 'audit', 'excluded', []);
      portable.key_policy = password ? 'included_encrypted' : 'excluded_portable';
      markPartial(portable);

      if (password) {
        await this.createZip(innerPath, async writer => {
          for (const entry of zip.reader.entries) {
            check?.();
            if (entry.isDirectory || (entry.name !== MANIFEST_ENTRY && !isPortableExcludedRelativePath(entry.name))) continue;
            await writer.addStream(entry.name, readChunks(await zip.reader.openEntry(entry)), { compression: 'stored', sizeHint: entry.size, onData: check });
          }
        });
        check?.();
        await this.cipherFile(await this.files.openRead(innerPath), sealedPath, password, true);
      }
      const portablePath = this.temp('zip');
      try {
        const result = await this.createZip(portablePath, async writer => {
          for (const entry of zip.reader.entries) {
            check?.();
            if (entry.isDirectory || entry.name === MANIFEST_ENTRY || isPortableExcludedRelativePath(entry.name)) continue;
            // Leave easily compressible data stored, so our output also satisfies the import ZIP ratio policy.
            const method = entry.size > 1024 ? 'stored' : compression;
            await writer.addStream(entry.name, readChunks(await zip.reader.openEntry(entry)), { compression: method, level: compressionLevel, sizeHint: entry.size, onData: check });
          }
          if (password) {
            const hasher = this.ctx.crypto.createHasher('SHA-256');
            const size = (await this.files.stat(sealedPath)).size;
            await writer.addStream(ENCRYPTED_SECRETS_ENTRY, readChunks(await this.files.openRead(sealedPath)), {
              compression: 'stored', sizeHint: size, onData: bytes => { check?.(); hasher.update(bytes); },
            });
            portable.files.push({ path: ENCRYPTED_SECRETS_ENTRY, size, sha256: hasher.digestHex() });
          }
          check?.();
          validateUntrusted(portable);
          await writer.addBytes(MANIFEST_ENTRY, new TextEncoder().encode(JSON.stringify(portable)), { compression: 'stored' });
        });
        check?.();
        await this.files.rename(portablePath, destination, { overwrite: false, createParents: true });
        return result;
      } finally {
        await this.files.rm(portablePath, { force: true }).catch(() => undefined);
      }
    } finally {
      await zip.close().catch(() => undefined);
      for (const path of [innerPath, sealedPath]) await this.files.rm(path, { force: true }).catch(() => undefined);
    }
  }

  async importArchive(zipPath: string, requestedId?: string | null, password?: string, local = false, check?: CheckBackup, publish?: () => void): Promise<{
    backupId: string; databaseCount: number; blobCount: number; stageDir: string; restorable: boolean;
  }> {
    const tempZip = await this.resolveZip(zipPath);
    const innerPath = this.temp('zip');
    let outer: Awaited<ReturnType<MobileBackupService['openZip']>> | undefined;
    let inner: Awaited<ReturnType<MobileBackupService['openZip']>> | undefined;
    let stageDir: string | undefined;
    try {
      check?.();
      outer = await this.openZip(tempZip.path);
      const outerManifest = await this.manifestOf(outer.reader);
      const entryList = archiveEntries(outer.reader);
      validateImportArchive(local ? entryList.filter(item => !isPortableExcludedRelativePath(item.name)) : entryList);
      let manifest = outerManifest;
      const sealed = outer.reader.entries.find(entry => entry.name === ENCRYPTED_SECRETS_ENTRY);
      const entries = new Map(entryList.filter(item => !item.isDirectory).map(item => [item.name, { reader: outer!.reader, entry: item.entry }]));
      if (Boolean(sealed) !== (outerManifest.key_policy === 'included_encrypted')) throw new CommandError('备份清单与密码载荷不一致');
      if (sealed) {
        if (!password) throw new CommandError(`[${SEALED_BACKUP_PASSWORD_REQUIRED_CODE}] 这是加密备份，请输入导出时设置的备份密码`);
        if (sealed.size > MAX_SECRET_PAYLOAD) throw new CommandError('加密备份载荷过大');
        const evidence = outerManifest.files.find(file => file.path === ENCRYPTED_SECRETS_ENTRY);
        await this.verifyEntry(outer.reader, sealed, evidence, undefined, false, check);
        try {
          await this.cipherFile(await outer.reader.openEntry(sealed), innerPath, password, false);
        } catch (error) {
          throw new CommandError(`[${SEALED_BACKUP_DECRYPT_FAILED_CODE}] 无法解封备份：${failureMessage(error)}`);
        }
        inner = await this.openZip(innerPath);
        manifest = await this.manifestOf(inner.reader);
        if (manifest.key_policy !== 'included_local' && manifest.key_policy !== 'not_present') throw new CommandError('密封载荷缺少原始完整清单');
        if (manifest.backup_id !== outerManifest.backup_id) throw new CommandError('密封载荷与 ZIP 的备份 ID 不一致');
        const privateEntries = validateSecretsArchive(archiveEntries(inner.reader));
        for (const item of privateEntries) if (item.name !== MANIFEST_ENTRY) entries.set(item.name, { reader: inner.reader, entry: item.entry });
        entries.delete(ENCRYPTED_SECRETS_ENTRY);
      } else if (password) {
        throw new CommandError('此 ZIP 没有密码保护，请清空备份密码后重试');
      }

      const id = sanitizeBackupId(requestedId ?? null) ?? backupId('import');
      stageDir = `${this.backupRoot}/imports/${id}`;
      const stage = stageDir;
      // A failed or interrupted import never leaves an activatable stage. Do not overwrite a completed one.
      if (await this.files.exists(stage)) {
        if (await this.files.exists(`${stage}/${MANIFEST_ENTRY}`)) {
          stageDir = undefined;
          throw new CommandError(`该恢复暂存已存在：${id}`);
        }
        // Reclaim only an incomplete staging directory from an interrupted import.
        await this.files.rm(stage, { recursive: true, force: true });
      }
      await this.files.mkdir(stage, { recursive: true });
      const targets = new Set<string>();
      const databases = new Set<DatabaseName>();
      const verified: BackupFile[] = [];
      let blobCount = 0;
      const declared = declaredArchiveFiles(manifest);
      for (const [archive, { reader, entry }] of entries) {
        check?.();
        if (archive === MANIFEST_ENTRY || archive === 'checksums.sha256') continue;
        safeArchivePath(archive);
        const evidence = declared.get(archive);
        if (!evidence) throw new CommandError(`ZIP 包含清单未声明的文件: ${archive}`);
        declared.delete(archive);
        const db = databaseForArchive(archive);
        const candidate = assetRelative(archive);
        const workspaceDb = /^workspaces\/ws_[A-Za-z0-9_-]+\.db$/.test(archive) ? archive : null;
        const asset = candidate?.startsWith('workspaces/agents/') ? null : candidate;
        const target = stagedArchiveTarget(archive);
        if (target !== null) {
          if (targets.has(target)) throw new CommandError(`ZIP 包含重复恢复目标: ${target}`);
          targets.add(target);
          if (db || workspaceDb) {
            if (entry.size > MAX_DATABASE_BYTES) throw new CommandError(`备份数据库过大: ${archive}`);
            if (db) databases.add(db);
          }
          if (asset) blobCount += 1;
        }
        await this.verifyEntry(reader, entry, evidence, target === null ? undefined : `${stage}/${target}`, db !== null || workspaceDb !== null, check);
        verified.push(evidence);
      }
      if (declared.size > 0) throw new CommandError(`ZIP 缺少清单声明的文件: ${[...declared.keys()][0]}`);
      const required = CORE_DATABASES.filter(name => !databases.has(name));
      const restorable = (local || Boolean(sealed)) && manifest.snapshot_kind === 'full' && required.length === 0;
      if (manifest.snapshot_kind === 'full') {
        validateForSlotRestore(manifest);
        this.assertBlobEvidence(await this.stagedBlobReferences(stage, check), verified, check);
      }
      check?.();
      publish?.();
      await this.files.writeAtomic(`${stage}/${MANIFEST_ENTRY}`, JSON.stringify({ ...manifest, mobile_restorable: restorable }));
      return { backupId: id, databaseCount: databases.size, blobCount, stageDir: stage, restorable };
    } catch (error) {
      if (stageDir) await this.files.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await outer?.close().catch(() => undefined);
      await inner?.close().catch(() => undefined);
      await this.files.rm(innerPath, { force: true }).catch(() => undefined);
      if (tempZip.temporary) await this.files.rm(tempZip.path, { force: true }).catch(() => undefined);
    }
  }

  private async verifyEntry(reader: ZipReader, entry: ZipEntry, evidence?: BackupFile, destination?: string, sqlite = false, check?: CheckBackup): Promise<void> {
    if (!evidence || evidence.size !== entry.size) throw new CommandError(`备份清单大小校验失败: ${entry.name}`);
    const hasher = this.ctx.crypto.createHasher('SHA-256');
    const file = destination ? await this.files.openFile(destination, { mode: 'truncate', createParents: true }) : undefined;
    let position = 0;
    const header = new Uint8Array(SQLITE_HEADER.length);
    try {
      for await (const bytes of readChunks(await reader.openEntry(entry))) {
        check?.();
        if (sqlite && position < header.length) header.set(bytes.subarray(0, header.length - position), position);
        hasher.update(bytes);
        await file?.write(bytes, position);
        position += bytes.byteLength;
      }
      if (sqlite && (bytesHeader(header) !== SQLITE_HEADER || position < 512 || position % 512 !== 0)) throw new CommandError(`SQLite 文件大小无效: ${entry.name}`);
      if (!/^[a-fA-F0-9]{64}$/.test(evidence.sha256) || hasher.digestHex().toLowerCase() !== evidence.sha256.toLowerCase()) {
        throw new CommandError(`备份 SHA-256 校验失败: ${entry.name}`);
      }
      await file?.sync();
    } finally { await file?.close(); }
  }

  private get restoreIntent(): string {
    return mobileRestoreIntentPath(this.storage.locations.baseDir);
  }

  private stageDirectory(id: string): string {
    if (sanitizeBackupId(id) !== id) throw new CommandError('备份 ID 无效');
    return `${this.backupRoot}/imports/${id}`;
  }

  private async verifyStage(id: string): Promise<string> {
    const stage = this.stageDirectory(id);
    const marker = `${stage}/${MANIFEST_ENTRY}`;
    if (!await this.files.exists(marker)) throw new CommandError('备份导入未完成，不能恢复数据');
    let staged: { mobile_restorable?: boolean } | null;
    try { staged = JSON.parse(await this.files.readText(marker, { maxBytes: MAX_MANIFEST_BYTES })); }
    catch { throw new CommandError('恢复暂存清单无法读取或格式无效'); }
    if (staged?.mobile_restorable !== true) throw new CommandError('便携或部分归档不能替换当前数据槽');
    return stage;
  }

  private replacements(stage: string) {
    const live = this.storage.locations.activeDir;
    const base = this.storage.locations.baseDir;
    return [
      ...ASSET_ROOTS.map(name => ({ destination: `${live}/${name}`, source: `${stage}/live/${name}`, directory: true, preserveIfAbsent: false })),
      ...PERSISTENT_FILES.map(name => ({ destination: `${live}/${name}`, source: `${stage}/live/${name}`, directory: false, preserveIfAbsent: false })),
      { destination: `${base}/${SECURE_ROOT}`, source: `${stage}/root/${SECURE_ROOT}`, directory: true, preserveIfAbsent: true },
      { destination: `${base}/${ROOT_CRYPTO}`, source: `${stage}/root/${ROOT_CRYPTO}`, directory: false, preserveIfAbsent: true },
    ];
  }

  private async restoreFile(source: string, destination: string, directory: boolean, hasSource: boolean): Promise<void> {
    await this.files.rm(destination, { recursive: directory, force: true });
    if (!hasSource) return;
    if (directory) await this.copyBlobTree(source, destination);
    else await this.copyFile(source, destination);
  }

  private async readRestoreIntent(): Promise<MobileRestoreIntent> {
    let raw: unknown;
    try { raw = JSON.parse(await this.files.readText(this.restoreIntent, { maxBytes: 1024 })); }
    catch { throw new CommandError('无法读取上次数据恢复的意图文件'); }
    if (raw === null || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || sanitizeBackupId(raw.id) !== raw.id) {
      throw new CommandError('待恢复数据的意图文件无效');
    }
    const previous = 'previousBackupId' in raw && typeof raw.previousBackupId === 'string' ? raw.previousBackupId : null;
    return { id: raw.id, ...(previous && sanitizeBackupId(previous) === previous ? { previousBackupId: previous } : {}) };
  }

  /** Replay an interrupted activation before any migrations or business connections can open a database. */
  async recoverPendingRestore(): Promise<MobileRestoreStartup> {
    let intent: MobileRestoreIntent | undefined;
    try {
      intent = await this.readRestoreIntent();
      await this.activatePendingStage(await this.validatePendingStage(intent.id));
      return { id: intent.id, reason: null, previousBackupId: null, previousBackupBytes: 0 };
    } catch (error) {
      const previous = intent?.previousBackupId;
      const info = previous ? await this.files.stat(`${this.backupRoot}/${previous}.zip`).catch(() => null) : null;
      this.ctx.logger('storage').warn(`Cannot replay interrupted mobile restore: ${failureMessage(error)}`);
      return {
        id: intent?.id ?? 'pending-mobile-restore',
        reason: failureMessage(error),
        previousBackupId: info?.kind === 'file' ? previous! : null,
        previousBackupBytes: info?.kind === 'file' ? info.size : 0,
      };
    }
  }

  /** The slot may contain mixed data. Use the existing durable snapshot or a newly verified full import. */
  async replacePendingRestore(id: string, previousBackupId: string | null, check: CheckBackup): Promise<void> {
    let target = id;
    if (id === previousBackupId) {
      const previousZip = await this.existingZip(id);
      if (!previousZip) throw new CommandError('找不到恢复前的备份');
      // Use a fresh stage; the previous attempt may have left a corrupt snapshot under its own id.
      const imported = await this.importArchive(previousZip, null, undefined, true, check);
      if (!imported.restorable) throw new CommandError('恢复前的备份不完整');
      target = imported.backupId;
    }
    const stage = await this.validatePendingStage(target, check);
    check();
    const intent: MobileRestoreIntent = { id: target, ...(previousBackupId ? { previousBackupId } : {}) };
    // Switch only after validation. If killed during activation the next startup can safely replay this new stage.
    await this.files.writeAtomic(this.restoreIntent, JSON.stringify(intent), { createParents: true });
    await this.activatePendingStage(stage);
  }

  private async validatePendingStage(id: string, check?: CheckBackup) {
    if (!this.runtime.importDb) throw new CommandError('当前运行时无法导入 SQLite 数据库');
    const stage = await this.verifyStage(id);
    const manifestPath = `${stage}/${MANIFEST_ENTRY}`;
    let manifest: BackupManifest;
    try { manifest = parseManifest(JSON.parse(await this.files.readText(manifestPath, { maxBytes: MAX_MANIFEST_BYTES }))); }
    catch { throw new CommandError('恢复暂存清单无法读取或格式无效'); }
    validateUntrusted(manifest);
    validateForSlotRestore(manifest);
    const evidence = [...declaredArchiveFiles(manifest).values()];
    const targets = new Set<string>();
    const databases = new Set<DatabaseName>();
    for (const file of evidence) {
      check?.();
      const target = stagedArchiveTarget(file.path);
      if (target === null) continue;
      if (targets.has(target)) throw new CommandError('恢复暂存清单包含重复目标');
      targets.add(target);
      const path = `${stage}/${target}`;
      try {
        const info = await this.files.stat(path);
        if (info.kind !== 'file' || info.size !== file.size) throw new CommandError(`恢复暂存大小校验失败：${file.path}`);
      } catch (error) {
        if (isFileNotFound(error)) throw new CommandError(`恢复暂存缺少文件：${file.path}`);
        throw error;
      }
      const db = databaseForArchive(file.path);
      if (db && file.size > MAX_DATABASE_BYTES) throw new CommandError(`恢复暂存数据库过大：${file.path}`);
      const hasher = this.ctx.crypto.createHasher('SHA-256');
      for await (const bytes of readChunks(await this.files.openRead(path))) {
        check?.();
        hasher.update(bytes);
      }
      if (hasher.digestHex() !== file.sha256.toLowerCase()) throw new CommandError(`恢复暂存 SHA-256 校验失败：${file.path}`);
      if (db) databases.add(db);
    }
    const present = [...CORE_DATABASES, 'audit' as const].filter(db => databases.has(db));
    if (CORE_DATABASES.some(db => !databases.has(db))) throw new CommandError('恢复暂存缺少核心数据库');
    // The replacements below copy entire directories; never activate an undeclared file from a stale stage.
    for (const kind of ['live', 'root']) {
      if (!await this.files.exists(`${stage}/${kind}`)) continue;
      for await (const entry of this.files.walk(`${stage}/${kind}`, { includeDirectories: false })) {
        if (entry.kind === 'file' && !targets.has(`${kind}/${entry.relativePath}`)) throw new CommandError('恢复暂存包含未声明的数据文件');
      }
    }
    this.assertBlobEvidence(await this.stagedBlobReferences(stage, check), evidence, check);
    await this.verifyStagedKeys(stage);
    return { stage, present };
  }

  private async activatePendingStage({ stage, present }: Awaited<ReturnType<MobileBackupService['validatePendingStage']>>): Promise<void> {
    const importDb = this.runtime.importDb;
    if (!importDb) throw new CommandError('当前运行时无法导入 SQLite 数据库');
    for (const db of present) {
      const bytes = await this.files.readBytes(`${stage}/${archiveForDatabase(db)}`, { maxBytes: MAX_DATABASE_BYTES });
      if (await importDb.call(this.runtime, this.storage.pathOf(db), bytes) !== bytes.byteLength) throw new CommandError(`恢复数据库写入不完整：${db}`);
    }
    for (const { source, destination, directory, preserveIfAbsent } of this.replacements(stage)) {
      const hasSource = await this.files.exists(source);
      if (!hasSource && preserveIfAbsent) continue;
      await this.restoreFile(source, destination, directory, hasSource);
    }
    await this.files.rm(this.restoreIntent, { force: true });
    await this.files.rm(`${stage}/rollback`, { recursive: true, force: true }).catch(() => undefined);
    this.ctx.logger('storage').info('Recovered interrupted mobile backup activation');
  }

  private async verifyStagedKeys(stageDir: string): Promise<void> {
    for (const name of [ROOT_CRYPTO, `${SECURE_ROOT}/.key_seed`]) {
      const path = `${stageDir}/root/${name}`;
      if (!await this.files.exists(path)) continue;
      if ((await this.files.stat(path)).size > 4096) throw new CommandError(`备份密钥无效: ${name}`);
      const value = (await this.files.readText(path)).trim();
      const valid = name === ROOT_CRYPTO ? /^[A-Za-z0-9+/]{43}=$/.test(value) : /^[a-fA-F0-9]{64}$/.test(value);
      if (!valid) throw new CommandError(`此备份包含无法在移动端使用的密钥: ${name}`);
    }
  }

  /** Close active connections and replace the validated snapshot, leaving an intent before the first write. */
  async restoreArchive(id: string): Promise<{ databaseCount: number; blobCount: number; preRestoreZip: string | null }> {
    const stageDir = await this.verifyStage(id);
    if (await this.files.exists(this.restoreIntent)) throw new CommandError('已有未完成的备份恢复，请重启应用');
    await this.verifyStagedBlobs(stageDir);
    await this.verifyStagedKeys(stageDir);
    const present: DatabaseName[] = [];
    for (const database of ['vfs', 'llm_usage', 'chat_v2', 'mistakes', 'audit'] as DatabaseName[]) {
      const archive = archiveForDatabase(database);
      if (await this.files.exists(`${stageDir}/${archive}`).catch(() => false)) present.push(database);
    }
    if (!CORE_DATABASES.every(name => present.includes(name))) {
      throw new CommandError('导入暂存备份不完整，拒绝覆盖活动数据槽');
    }

    // Keep a durable prior snapshot. The rollback journal only replays the requested new state
    // after process death, so an in-memory rollback alone cannot justify replacing the original.
    let previous: { zipPath: string; backupId: string };
    try {
      previous = await this.exportBackup(backupId('pre-restore'));
    } catch (error) {
      throw new CommandError(`无法保存恢复前的备份，当前数据未改动：${failureMessage(error)}`);
    }

    // 关闭全部连接并拒绝新连接：sahpool 对已打开的文件导入结果未定义，后台任务也不能在
    // `importDb` 覆盖库文件时重新打开旧连接。成功后由调用方重载页面，屏障无需释放。
    const importDb = this.runtime.importDb;
    if (typeof importDb !== 'function') {
      throw new CommandError('当前运行时不支持数据库导入（importDb 缺失）');
    }
    let lease: MaintenanceLease;
    try {
      lease = await this.storage.enterMaintenance(['vfs', 'llm_usage', 'chat_v2', 'mistakes', 'audit'] as DatabaseName[]);
    } catch (error) {
      throw new CommandError(`无法进入维护模式，已取消恢复: ${failureMessage(error)}`);
    }
    let assetCount = 0;
    const snapshots = new Map<DatabaseName, Uint8Array | null>();
    const overwritten: DatabaseName[] = [];
    const replacements = this.replacements(stageDir);
    const replaced: Array<{ destination: string; backup: string | null; directory: boolean }> = [];
    try {
      // All handles have been closed/checkpointed by maintenance. Capture every
      // target before the first overwrite; exportFile buffers may be WASM views.
      for (const database of present) {
        const target = this.storage.pathOf(database);
        snapshots.set(database, this.runtime.exists(target) ? this.runtime.exportFile(target).slice() : null);
      }
      try {
        for await (const entry of this.files.walk(`${stageDir}/live`, { includeDirectories: false })) {
          if (entry.kind === 'file' && ASSET_ROOTS.some(root => entry.relativePath.startsWith(`${root}/`))) assetCount++;
        }
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
      const intent: MobileRestoreIntent = { id, previousBackupId: previous.backupId };
      await this.files.writeAtomic(this.restoreIntent, JSON.stringify(intent), { createParents: true });
      for (const database of present) {
        const archive = archiveForDatabase(database);
        const bytes = await this.files.readBytes(`${stageDir}/${archive}`);
        assertSqliteDatabase(bytes, archive);
        overwritten.push(database);
        await importDb.call(this.runtime, this.storage.pathOf(database), bytes);
      }
      for (const [index, { source, destination, directory, preserveIfAbsent }] of replacements.entries()) {
        const hasReplacement = await this.files.exists(source);
        if (!hasReplacement && preserveIfAbsent) continue;
        const backup = await this.stageActiveFiles(destination, `${stageDir}/rollback/${index}`, directory);
        replaced.push({ destination, backup, directory });
        await this.restoreFile(source, destination, directory, hasReplacement);
      }
      await this.files.rm(this.restoreIntent, { force: true });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const { destination, backup, directory } of replaced.reverse()) {
        try {
          await this.files.rm(destination, { recursive: directory, force: true });
          if (backup) {
            if (directory) await this.copyBlobTree(backup, destination);
            else await this.copyFile(backup, destination);
            await this.files.rm(backup, { recursive: directory, force: true });
          }
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      for (const database of overwritten.reverse()) {
        try {
          const bytes = snapshots.get(database)!;
          const target = this.storage.pathOf(database);
          if (bytes === null) {
            if (this.runtime.exists(target)) this.runtime.unlink(target);
          } else {
            await importDb.call(this.runtime, target, bytes);
          }
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length > 0) {
        // Do not reopen a partially rolled-back slot.
        throw new AggregateError([error, ...rollbackErrors], '恢复失败且数据库回滚失败，保持维护模式');
      }
      try { await this.files.rm(this.restoreIntent, { force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], '恢复已回滚但无法清除恢复标记，保持维护模式'); }
      lease.release();
      throw error;
    }
    for (const { backup, directory } of replaced) {
      if (backup) await this.files.rm(backup, { recursive: directory, force: true }).catch((error) => {
        this.ctx.logger('storage').warn(`恢复成功后清理暂存失败: ${failureMessage(error)}`);
      });
    }
    return { databaseCount: present.length, blobCount: assetCount, preRestoreZip: previous.zipPath };
  }

  /** Save the old value before the destination is touched, since OPFS cannot atomically rename directories. */
  private async stageActiveFiles(path: string, staged: string, directory: boolean): Promise<string | null> {
    if (!(await this.files.exists(path))) return null;
    if (await this.files.exists(staged)) throw new CommandError(`仍有未处理的恢复暂存：${staged}`);
    if (directory) {
      await this.files.mkdir(staged, { recursive: true });
      await this.copyBlobTree(path, staged);
    } else {
      try { await this.copyFile(path, staged); }
      catch (error) {
        await this.files.rm(staged, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    return staged;
  }

  /** 逐文件复制目录树；中途失败时清掉半成品目标目录（源目录保持原样）。 */
  private async copyBlobTree(sourceRoot: string, destinationRoot: string): Promise<void> {
    try {
      for await (const entry of this.files.walk(sourceRoot, { includeDirectories: false })) {
        if (entry.kind !== 'file') continue;
        await this.copyFile(entry.path, `${destinationRoot}/${entry.relativePath}`);
      }
    } catch (error) {
      await this.files.rm(destinationRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async copyFile(sourcePath: string, destination: string): Promise<void> {
    const stream = await this.files.openRead(sourcePath);
    const source = stream.getReader();
    const sink = await this.files.openFile(destination, { mode: 'truncate', createParents: true });
    let position = 0;
    try {
      for (;;) {
        const next = await source.read();
        if (next.done) break;
        await sink.write(next.value, position);
        position += next.value.byteLength;
      }
      await sink.sync?.();
    } finally {
      await source.cancel().catch(() => undefined);
      source.releaseLock();
      await sink.close().catch(() => undefined);
    }
  }

  private async resolveZip(zipPath: string): Promise<{ path: string; temporary: boolean }> {
    if (zipPath.startsWith('mobile-picker:')) {
      const path = `${this.storage.locations.baseDir}/tmp/backups/${this.ctx.crypto.randomUUID()}.zip`;
      const answer = await this.ctx.shell.request<{ path?: unknown } | null>('mobile:pick-backup', { targetPath: path });
      if (answer === null || typeof answer !== 'object' || typeof answer.path !== 'string') {
        throw new MobileBackupCancelled('未选择备份文件');
      }
      if (answer.path !== path || !await this.files.exists(path)) {
        throw new CommandError(`选择的备份文件不可读: ${answer.path}`);
      }
      return { path: answer.path, temporary: true };
    }
    if (zipPath.startsWith('data:')) {
      const comma = zipPath.indexOf(',');
      if (comma < 0) throw new CommandError('无效的 data: URL 备份地址');
      const meta = zipPath.slice(5, comma);
      const payload = zipPath.slice(comma + 1);
      const binary = meta.includes(';base64') ? atobBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
      const path = `${this.storage.locations.baseDir}/tmp/backups/${this.ctx.crypto.randomUUID()}.zip`;
      await this.files.writeBytes(path, binary, { createParents: true });
      return { path, temporary: true };
    }
    if (!zipPath.startsWith('/')) throw new CommandError(`移动端只支持应用内备份路径（收到 ${zipPath}）`);
    if (!(await this.files.exists(zipPath).catch(() => false))) throw new CommandError(`ZIP 文件不存在: ${zipPath}`);
    return { path: zipPath, temporary: false };
  }
}

function sanitizeBackupId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 128 || trimmed.startsWith('.') || trimmed.includes('..')) return null;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function atobBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
