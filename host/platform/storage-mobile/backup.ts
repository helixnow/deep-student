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
  newCoverageLedger,
  persistentDomainRegistry,
  updateCoverage,
  type BackupFile,
  type BackupManifest,
} from '../../plugins/backup/src/manifest-model.ts';
import type { FilesService, WalkEntry } from '../files/api.ts';
import type { DatabaseName, MaintenanceLease } from '../storage/api.ts';
import { ZipReader, ZipWriter, type ZipEntry } from '../zip/core/index.ts';
import type { MobileStorageService } from './service.ts';
import type { SqliteRuntime } from './sqlite-wasm.ts';

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
const VFS_BLOBS_ROOT = 'assets/vfs_blobs';

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
}

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

  create(kind: 'export' | 'import'): { id: string; update(update: Partial<JobState>): void; complete(result: JobResultPayload): void; fail(message: string): void } {
    const id = `mobile-${this.ctx.crypto.randomUUID()}`;
    const state: JobState = {
      job_id: id, kind, status: 'queued', phase: 'queued', progress: 0, message: null,
      processed_items: 0, total_items: 0, created_at: now(),
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
      Object.assign(current, { status, phase: status === 'completed' ? 'completed' : 'failed', progress: 100, message, finished_at: now(), result });
      this.emit(current);
    };
    return {
      id,
      update,
      complete: result => finish('completed', result.message ?? '完成', result),
      fail: message => finish('failed', message, {
        success: false, output_path: null, message, error: message,
        duration_ms: this.duration(id), requires_restart: false,
      }),
    };
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
      cancellable: state.status === 'queued' || state.status === 'running',
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
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
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
  const base = name.split('/').pop()?.toLowerCase();
  switch (base) {
    case 'vfs.db': return 'vfs';
    case 'chat_v2.db': return 'chat_v2';
    case 'mistakes.db': return 'mistakes';
    case 'llm_usage.db': return 'llm_usage';
    case 'audit.db': return 'audit';
    case 'browser.db': return 'browser';
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

function blobRelative(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (normalized.endsWith('/')) return null;
  for (const root of ['assets/vfs_blobs/', 'vfs_blobs/']) {
    if (normalized.startsWith(root)) {
      const relative = normalized.slice(root.length);
      return relative === '' ? null : safeArchivePath(relative);
    }
  }
  return null;
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

  get blobsDir(): string {
    return `${this.storage.locations.activeDir}/vfs_blobs`;
  }

  /** 已导出的同名 ZIP（`run_backup` 之后 `export_zip` 直接复用，不重复扫描数据库）。 */
  async existingZip(id: string): Promise<string | null> {
    const path = `${this.backupRoot}/${id}.zip`;
    return (await this.files.exists(path).catch(() => false)) ? path : null;
  }

  /** 交给主线程 Web Share / File System Access / 浏览器下载；失败不影响备份本身。 */
  async deliver(zipPath: string, fileName: string): Promise<string> {
    try {
      const answer = await this.ctx.shell.request<{ method?: string }>('mobile:save-backup', { path: zipPath, fileName });
      return typeof answer?.method === 'string' ? answer.method : 'unknown';
    } catch (error) {
      this.ctx.logger('storage').warn(`备份文件交给系统失败: ${failureMessage(error)}`);
      return 'unavailable';
    }
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
    const stageDir = `${this.backupRoot}/imports/${id}`;
    if (!(await this.files.exists(stageDir).catch(() => false))) return 0;
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
  async exportBackup(id: string, outputPath?: string | null, onProgress?: (done: number, total: number, file: string) => void): Promise<{ zipPath: string; fileCount: number; totalSize: number; compressedSize: number; backupId: string }> {
    const zipPath = outputPath && outputPath.startsWith('/') ? outputPath : `${this.backupRoot}/${id}.zip`;
    await this.files.mkdir(this.backupRoot, { recursive: true }).catch(() => undefined);
    const sink = await this.files.openFile(zipPath, { mode: 'truncate', createParents: true });
    const writer = new ZipWriter({
      write: async (data, position) => { await sink.write(data, position); },
    }, { label: 'mobile-backup-export' });
    const files: BackupFile[] = [];
    let totalSize = 0;
    let fileCount = 0;
    const staging: string[] = [];
    try {
      // 1. 数据库一致性快照：VACUUM INTO 到 pool 内的临时文件，再整块读出写进 ZIP。
      const audited: Array<CoreDatabase | 'audit'> = [...CORE_DATABASES];
      if (this.runtime.exists(this.storage.pathOf('audit'))) audited.push('audit');
      for (const [index, name] of audited.entries()) {
        const archive = name === 'audit' ? null : ARCHIVE_DATABASE[name];
        const database = name === 'audit' ? 'audit' : name;
        const temp = `${this.storage.locations.baseDir}/backup-staging-${id}-${index}.db`;
        staging.push(temp);
        await this.storage.database(database).backupTo(temp);
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

      // 2. vfs 附件：OPFS 普通文件，按桌面 `assets/vfs_blobs/<relative>` 归档。
      const blobs = await this.listBlobs();
      for (const [index, entry] of blobs.entries()) {
        const archivePath = `${VFS_BLOBS_ROOT}/${entry.relativePath}`;
        const size = (await this.files.stat(entry.path)).size;
        const hasher = this.ctx.crypto.createHasher('SHA-256');
        const stream = await this.files.openRead(entry.path);
        const reader = stream.getReader();
        const source = (async function* () {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        })();
        await writer.addStream(archivePath, source, {
          compression: 'deflated',
          onData: chunk => { hasher.update(chunk); },
        });
        files.push({ path: archivePath, size, sha256: hasher.digestHex() });
        totalSize += size;
        fileCount += 1;
        onProgress?.(audited.length + index + 1, audited.length + blobs.length + 1, archivePath);
      }

      // 3. 清单最后写：它要引用上面每个文件的大小与 SHA-256。
      const manifest = this.buildManifest(id, files);
      const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
      await writer.addBytes(MANIFEST_ENTRY, manifestBytes, { compression: 'deflated' });
      const compressedSize = await writer.finish();
      await sink.sync();
      return { zipPath, fileCount: fileCount + 1, totalSize: totalSize + manifestBytes.byteLength, compressedSize, backupId: id };
    } catch (error) {
      await sink.close().catch(() => undefined);
      await this.files.rm(zipPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      for (const temp of staging) {
        try { this.runtime.unlink(temp); }
        catch { /* boundary-allow empty-catch: pool file may already be gone */ }
      }
      await sink.close().catch(() => undefined);
    }
  }

  private buildManifest(id: string, files: BackupFile[]): BackupManifest {
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
      // 移动端不在 OPFS 备份里放密钥材料：明确声明“没有密钥”，仍是可整槽恢复的完整快照。
      key_policy: 'not_present',
      coverage: newCoverageLedger(),
    };
    // markFull 要求每个持久域都有证据；先把没纳入的域标 absent，再覆盖实际导出的域。
    for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
    for (const name of CORE_DATABASES) {
      const file = files.find(candidate => candidate.database_id === name);
      if (!file) throw new CommandError(`备份缺少核心数据库 ${name}`);
      updateCoverage(manifest, `database:${name}`, 'complete', [file.path]);
      try { manifest.schema_versions[name] = this.storage.migrations.currentVersion(name); }
      catch { manifest.schema_versions[name] = 0; }
    }
    const audit = files.find(candidate => candidate.path === AUDIT_ARCHIVE);
    updateCoverage(manifest, 'audit', audit ? 'complete' : 'absent', audit ? [audit.path] : []);
    const blobs = files.filter(candidate => candidate.path.startsWith(`${VFS_BLOBS_ROOT}/`)).map(candidate => candidate.path);
    updateCoverage(manifest, 'asset-root:vfs_blobs', blobs.length > 0 ? 'complete' : 'empty', blobs);
    markFull(manifest);
    return manifest;
  }

  private async listBlobs(): Promise<WalkEntry[]> {
    const exists = await this.files.exists(this.blobsDir).catch(() => false);
    if (!exists) return [];
    const entries: WalkEntry[] = [];
    try {
      for await (const entry of this.files.walk(this.blobsDir, { includeDirectories: false })) {
        if (entry.kind === 'file') entries.push(entry);
      }
    } catch (error) {
      if ((error as { kind?: string }).kind === 'NotFound') return [];
      throw error;
    }
    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /**
   * 导入 ZIP 到 `recovery/backups/imports/<id>/`。`zipPath` 可以是：
   * - OPFS 绝对路径（`/deep-student/...`）；
   * - `data:` URL（前端用 `<input type=file>` 读出的字节）；
   * - `mobile-picker:`（主线程弹出系统文件选择器，把文件写进 OPFS）。
   */
  async importArchive(zipPath: string, requestedId?: string | null): Promise<{ backupId: string; databaseCount: number; blobCount: number; stageDir: string }> {
    const tempZip = await this.resolveZip(zipPath);
    const source = await this.files.openFile(tempZip.path, { mode: 'read' });
    const reader = await ZipReader.open({
      size: source.size,
      read: (position, length) => source.read(position, length),
    }, {
      maxEntries: MAX_ARCHIVE_ENTRIES,
      tooManyEntries: (count, max) => new CommandError(`ZIP 文件数量超限: ${count} > ${max}`),
    });
    try {
      const entries = reader.entries;
      const manifestEntry = entries.find(entry => entry.name === MANIFEST_ENTRY);
      let manifestId = requestedId ?? null;
      let manifest: BackupManifest | null = null;
      if (manifestEntry) {
        if (manifestEntry.size > MAX_MANIFEST_BYTES) throw new CommandError(`备份清单过大: ${manifestEntry.size} 字节`);
        try {
          const parsed = JSON.parse(new TextDecoder().decode(await reader.readEntry(manifestEntry))) as { backup_id?: unknown; version?: unknown };
          manifest = parsed as unknown as BackupManifest;
          if (typeof parsed.backup_id === 'string' && parsed.backup_id.trim() !== '') manifestId ??= parsed.backup_id.trim();
        } catch { // boundary-allow empty-catch: 清单损坏不阻断数据导入；数据完整性由每个 DB 的头部校验兜底。
        }
      }
      const id = sanitizeBackupId(manifestId) ?? backupId('import');
      const stageDir = `${this.backupRoot}/imports/${id}`;
      await this.files.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      await this.files.mkdir(stageDir, { recursive: true });

      const databases = new Map<DatabaseName, { archive: string; entry: ZipEntry }>();
      let blobCount = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const blob = blobRelative(entry.name);
        if (blob !== null) {
          await this.copyEntryStream(reader, entry, `${stageDir}/vfs_blobs/${blob}`);
          blobCount += 1;
          continue;
        }
        const database = databaseForArchive(entry.name);
        if (database !== null && entry.name.toLowerCase().endsWith('.db')) {
          const archive = safeArchivePath(entry.name);
          if (!databases.has(database)) databases.set(database, { archive, entry });
        }
      }
      const required = CORE_DATABASES.filter(name => !databases.has(name));
      if (required.length > 0) throw new CommandError(`ZIP 备份缺少核心数据库: ${required.join(', ')}`);
      for (const database of databases.keys()) {
        const selected = databases.get(database)!;
        if (selected.entry.size > MAX_DATABASE_BYTES) {
          throw new CommandError(`备份中的数据库过大: ${selected.archive} (${selected.entry.size} 字节)`);
        }
        const target = archiveForDatabase(database);
        await this.copyEntry(reader, selected.entry, `${stageDir}/${target}`, selected.archive, true);
      }
      if (manifest) await this.files.writeText(`${stageDir}/${MANIFEST_ENTRY}`, `${JSON.stringify(manifest, null, 2)}\n`);
      return { backupId: id, databaseCount: databases.size, blobCount, stageDir };
    } finally {
      await source.close().catch(() => undefined);
      if (tempZip.temporary) await this.files.rm(tempZip.path, { force: true }).catch(() => undefined);
    }
  }

  /** 真正覆盖活动槽：关闭连接 → `importDb` → 替换 vfs_blobs → 由调用方请求重载。 */
  async restoreArchive(id: string): Promise<{ databaseCount: number; blobCount: number; preRestoreZip: string | null }> {
    const stageDir = `${this.backupRoot}/imports/${id}`;
    if (!(await this.files.exists(stageDir).catch(() => false))) {
      throw new CommandError(`导入暂存目录不存在: ${stageDir}`);
    }
    const present: DatabaseName[] = [];
    for (const database of ['vfs', 'llm_usage', 'chat_v2', 'mistakes', 'audit', 'browser'] as DatabaseName[]) {
      const archive = archiveForDatabase(database);
      if (await this.files.exists(`${stageDir}/${archive}`).catch(() => false)) present.push(database);
    }
    if (!CORE_DATABASES.every(name => present.includes(name))) {
      throw new CommandError('导入暂存备份不完整，拒绝覆盖活动数据槽');
    }

    // 覆盖前先把当前数据另存一份 ZIP，恢复失败时还能回到导入前状态。
    let preRestoreZip: string | null = null;
    try {
      const exported = await this.exportBackup(backupId('pre-restore'));
      preRestoreZip = exported.zipPath;
    } catch (error) {
      this.ctx.logger('storage').warn(`恢复前自动备份失败，继续恢复: ${failureMessage(error)}`);
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
    const blobs: WalkEntry[] = [];
    const snapshots = new Map<DatabaseName, Uint8Array | null>();
    const overwritten: DatabaseName[] = [];
    let blobBackup: string | null = null;
    try {
      // All handles have been closed/checkpointed by maintenance. Capture every
      // target before the first overwrite; exportFile buffers may be WASM views.
      for (const database of present) {
        const target = this.storage.pathOf(database);
        snapshots.set(database, this.runtime.exists(target) ? this.runtime.exportFile(target).slice() : null);
      }
      try {
        for await (const entry of this.files.walk(`${stageDir}/vfs_blobs`, { includeDirectories: false })) {
          if (entry.kind === 'file') blobs.push(entry);
        }
      } catch (error) {
        if ((error as { kind?: string }).kind !== 'NotFound') throw error;
      }
      for (const database of present) {
        const archive = archiveForDatabase(database);
        const bytes = await this.files.readBytes(`${stageDir}/${archive}`);
        assertSqliteDatabase(bytes, archive);
        overwritten.push(database);
        await importDb.call(this.runtime, this.storage.pathOf(database), bytes);
      }
      // 活动附件先完整暂存再替换：附件复制可能因 OPFS 空间不足中途失败，
      // 只回滚 SQLite 会让原 `vfs_blobs` 永久丢失。
      blobBackup = await this.stageActiveBlobs();
      await this.files.rm(this.blobsDir, { recursive: true, force: true }).catch(() => undefined);
      for (const entry of blobs) {
        const destination = `${this.blobsDir}/${entry.relativePath}`;
        await this.copyFile(entry.path, destination);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (blobBackup !== null) {
        try {
          await this.restoreActiveBlobs(blobBackup);
          blobBackup = null;
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
      lease.release();
      throw error;
    }
    if (blobBackup !== null) {
      await this.files.rm(blobBackup, { recursive: true, force: true }).catch((error) => {
        this.ctx.logger('storage').warn(`恢复成功后清理附件暂存失败: ${failureMessage(error)}`);
      });
    }
    return { databaseCount: present.length, blobCount: blobs.length, preRestoreZip };
  }

  /**
   * 把活动 `vfs_blobs` 整体挪到同级暂存目录；引擎不支持目录 rename 时退化为逐文件复制。
   * 返回 null 表示活动槽里本来就没有附件目录。
   */
  private async stageActiveBlobs(): Promise<string | null> {
    if (!(await this.files.exists(this.blobsDir).catch(() => false))) return null;
    const staged = `${this.blobsDir}.restore-tmp`;
    await this.files.rm(staged, { recursive: true, force: true }).catch(() => undefined);
    try {
      await this.files.rename(this.blobsDir, staged, { overwrite: true, createParents: true });
      return staged;
    } catch {
      // Chromium 的 OPFS 目录句柄没有 move()：目录 rename 抛 UnsupportedOnPlatform，改为复制。
      await this.copyBlobTree(this.blobsDir, staged);
      return staged;
    }
  }

  /** 用暂存副本完整换回活动 `vfs_blobs`，成功后删除暂存。 */
  private async restoreActiveBlobs(backupPath: string): Promise<void> {
    await this.files.rm(this.blobsDir, { recursive: true, force: true }).catch(() => undefined);
    try {
      await this.files.rename(backupPath, this.blobsDir, { overwrite: true, createParents: true });
    } catch {
      await this.copyBlobTree(backupPath, this.blobsDir);
    }
    await this.files.rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
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

  /** 可信 id：只保留桌面 `validate_backup_id` 接受的字符集。 */
  private async copyEntry(reader: ZipReader, entry: ZipEntry, destination: string, label: string, validateSqlite = false): Promise<void> {
    const bytes = await reader.readEntry(entry);
    if (validateSqlite && label.toLowerCase().endsWith('.db')) assertSqliteDatabase(bytes, label);
    await this.files.writeBytes(destination, bytes, { createParents: true });
  }

  /** 大附件（PDF / 视频）按块写进 OPFS，避免把整个文件读进 WebView 内存。 */
  private async copyEntryStream(reader: ZipReader, entry: ZipEntry, destination: string): Promise<void> {
    const stream = await reader.openEntry(entry);
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
    } finally {
      source.releaseLock();
      await sink.close().catch(() => undefined);
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
    } finally {
      source.releaseLock();
      await sink.close().catch(() => undefined);
    }
  }

  private async resolveZip(zipPath: string): Promise<{ path: string; temporary: boolean }> {
    if (zipPath.startsWith('mobile-picker:')) {
      const path = `${this.storage.locations.baseDir}/tmp/backups/${this.ctx.crypto.randomUUID()}.zip`;
      const answer = await this.ctx.shell.request<{ path?: unknown } | null>('mobile:pick-backup', { targetPath: path });
      if (answer === null || typeof answer !== 'object' || typeof answer.path !== 'string') {
        throw new CommandError('未选择备份文件');
      }
      if (!(await this.files.exists(answer.path).catch(() => false))) {
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
