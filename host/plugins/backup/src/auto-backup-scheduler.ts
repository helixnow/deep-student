/**
 * 自动备份调度器（`src-tauri/src/backup_config.rs:276–628` `start_auto_backup_scheduler` /
 * `check_and_perform_auto_backup`，`:693–711` 上次自动备份时间的读写）。
 *
 * - 启动 120 秒后首次检查，之后每次检查结束再等 3600 秒；每轮重新读取 `backup.config`，
 *   配置改动在下一轮生效（与 Rust 相同，没有立即触发）。
 * - 进程级重入标志 {@link AUTO_BACKUP_RUNNING} 对应 Rust 的 static `AUTO_BACKUP_RUNNING`。
 * - 计时器随插件卸载清除；在途备份在下一个检查点中止：释放快照屏障与全局租约、删除暂存目录，
 *   任务标记为取消，不写失败状态（Rust 进程退出时同样只留下本轮的尝试状态，下次启动重新到期）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import {
  BackupConfigError, cleanupOldBackups, createAutoBackupLock, createAutoBackupOutputDir,
  createAutoBackupStagingDir, defaultAutoBackupStatus, defaultBackupConfig, ensureWritable,
  getEffectiveBackupDir, parseAutoBackupStatus, parseBackupConfig, serializeAutoBackupStatus, sweepStaleAutoBackupStagingDirs,
  type AutoBackupStatus, type BackupConfig,
} from '../../../platform/settings/backup-config.ts';
import { isCryptoSecretBackupRelativePath, stripCryptoSecretsFromBackupDir } from '../../../platform/storage/backup-common.ts';
import { civilTime, nowEpochNanos, parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { join } from '../../../platform/util/path.ts';
import { ZipFileReader } from '../../../platform/zip/index.ts';
import type { BackupJobContext, BackupJobManager, BackupJobResultPayload } from '../api.ts';
import { createBackup, verifyWithAssets } from './backup-manager.ts';
import { ioMessage } from './io.ts';
import {
  MANIFEST_FILENAME, classifyRecoveryKind, parseManifest, saveManifest, validateForSlotRestore,
  type BackupManifest,
} from './manifest.ts';
import type { Operations } from './operations.ts';
import { exportBackupToZip } from './zip.ts';

export const AUTO_BACKUP_INITIAL_DELAY_MS = 120_000;
export const AUTO_BACKUP_CHECK_INTERVAL_MS = 3_600_000;

const BACKUP_CONFIG_KEY = 'backup.config';
const LAST_AUTO_BACKUP_KEY = 'backup.last_auto_backup_time';
const AUTO_BACKUP_STATUS_KEY = 'backup.auto_backup_status';

const HOUR_NS = 3_600_000_000_000n;
const GIB = 1024 * 1024 * 1024;
/** `PORTABLE_ASSET_BUDGET`（`backup_config.rs:445`）。 */
const PORTABLE_ASSET_BUDGET = 16 * GIB;
/** `PORTABLE_SNAPSHOT_BUDGET`（`backup_config.rs:481`）。 */
const PORTABLE_SNAPSHOT_BUDGET = 19n * BigInt(GIB);
const ABORTED_MESSAGE = '自动备份已中止：应用正在退出';

/** `AUTO_BACKUP_RUNNING`（`backup_config.rs:237`）：进程级，所有插件实例共享。 */
export const AUTO_BACKUP_RUNNING = createAutoBackupLock();

export interface AutoBackupSchedulerOptions {
  readonly ctx: Context;
  readonly jobs: BackupJobManager;
  readonly operations: Operations;
  /** Rust `Utc::now()`（纪元纳秒）；测试注入假时钟。 */
  readonly now?: () => bigint;
}

export interface AutoBackupScheduler {
  /** 启动调度（只生效一次）；120 秒后首次检查。 */
  start(): void;
  /** 清除计时器并中止在途备份；之后不再触发。 */
  stop(): void;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

interface CheckEnv {
  readonly ctx: Context;
  readonly jobs: BackupJobManager;
  readonly operations: Operations;
  readonly now: () => bigint;
  readonly aborted: () => boolean;
  readonly log: Logger;
}

type RecoveryKind = 'disaster_recovery' | 'partial_archive';

class AutoBackupAborted extends Error {
  constructor() {
    super(ABORTED_MESSAGE);
    this.name = 'AutoBackupAborted';
  }
}

export function createAutoBackupScheduler(options: AutoBackupSchedulerOptions): AutoBackupScheduler {
  const { ctx, jobs, operations } = options;
  const log: Logger = ctx.logger('backup');
  const now = options.now ?? nowEpochNanos;
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const env: CheckEnv = { ctx, jobs, operations, now, aborted: () => stopped, log };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(fire, delayMs);
  };

  const runOnce = async (): Promise<void> => {
    if (!AUTO_BACKUP_RUNNING.tryAcquire()) {
      log.debug('[AutoBackup] 上一次备份仍在运行，跳过本次检查');
      return;
    }
    let failure: unknown = null;
    try {
      await checkAndPerformAutoBackup(env);
    } catch (error) {
      failure = error;
    } finally {
      AUTO_BACKUP_RUNNING.release();
    }
    if (failure !== null) log.warn(`[AutoBackup] 自动备份检查失败: ${ioMessage(failure)}`);
  };

  function fire(): void {
    timer = null;
    if (stopped) return;
    const background = backgroundTasks(ctx);
    // F4 `backgroundTasks`：退出时等待在途检查；正在关闭时拒绝新任务。
    const pending = background === undefined ? runOnce() : background.spawn(runOnce);
    if (pending === null) return;
    const next = (): void => schedule(AUTO_BACKUP_CHECK_INTERVAL_MS);
    void pending.then(next, next);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      log.info('[AutoBackup] 自动备份调度器已启动');
      schedule(AUTO_BACKUP_INITIAL_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function backgroundTasks(ctx: Context): BackgroundTasks | undefined {
  try { return ctx.get('backgroundTasks') as BackgroundTasks | undefined; }
  catch { return undefined; }
}

function databaseError(error: unknown): BackupConfigError {
  return new BackupConfigError(AppError.database(`数据库错误: ${ioMessage(error)}`), { cause: error });
}

function readSetting(settings: SettingsStore, key: string): string | null {
  try { return settings.get(key); }
  catch (error) { throw databaseError(error); }
}

function writeSetting(settings: SettingsStore, key: string, value: string): void {
  try { settings.save(key, value); }
  catch (error) { throw databaseError(error); }
}

/** `BackupConfig::load`。 */
function loadBackupConfig(settings: SettingsStore): BackupConfig {
  const raw = readSetting(settings, BACKUP_CONFIG_KEY);
  return raw === null ? defaultBackupConfig() : parseBackupConfig(raw);
}

/** `AutoBackupStatus::load`。 */
function loadAutoBackupStatus(settings: SettingsStore): AutoBackupStatus {
  const raw = readSetting(settings, AUTO_BACKUP_STATUS_KEY);
  return raw === null ? defaultAutoBackupStatus() : parseAutoBackupStatus(raw);
}

/** `AutoBackupStatus::save`。 */
function saveAutoBackupStatus(settings: SettingsStore, status: AutoBackupStatus): void {
  writeSetting(settings, AUTO_BACKUP_STATUS_KEY, serializeAutoBackupStatus(status));
}

/** `get_last_auto_backup_time`：解析失败记 warn 并视为从未备份。 */
function getLastAutoBackupTime(settings: SettingsStore, log: Logger): bigint | null {
  const raw = readSetting(settings, LAST_AUTO_BACKUP_KEY);
  if (raw === null) return null;
  const parsed = parseRfc3339(raw);
  if (parsed === null) {
    log.warn(`[AutoBackup] 解析上次备份时间失败: ${rfc3339ParseError(raw)}`);
    return null;
  }
  return parsed.epochNanos;
}

/**
 * chrono `ParseError` 的 Display（只用于日志）：形状不完整为 premature end of input，
 * 合法前缀后还有字符为 trailing input，形状完整但字段越界为 input is out of range。
 */
function rfc3339ParseError(value: string): string {
  const shape = 'dddd-dd-ddTdd:dd:dd';
  for (let i = 0; i < shape.length; i++) {
    if (i >= value.length) return 'premature end of input';
    const char = value[i]!;
    const expected = shape[i]!;
    const ok = expected === 'd' ? char >= '0' && char <= '9'
      : expected === 'T' ? char === 'T' || char === 't' || char === ' '
        : char === expected;
    if (!ok) return 'input contains invalid characters';
  }
  const tail = /^(?:\.\d+)?(?:[Zz]|[+\-\u2212]\d{2}:\d{2})/.exec(value.slice(shape.length));
  if (tail === null) {
    return /^(?:\.\d*)?(?:[+\-\u2212](?:\d{0,2}|\d{2}:\d?))?$/.test(value.slice(shape.length))
      ? 'premature end of input'
      : 'input contains invalid characters';
  }
  return shape.length + tail[0].length < value.length ? 'trailing input' : 'input is out of range';
}

/** `Utc::now().format("%Y%m%d-%H%M%S")`。 */
function zipTimestamp(epochNanos: bigint): string {
  const t = civilTime(epochNanos, false);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}-${pad(t.hour)}${pad(t.minute)}${pad(t.second)}`;
}

/** `check_and_perform_auto_backup`（`backup_config.rs:318–628`）。 */
async function checkAndPerformAutoBackup(env: CheckEnv): Promise<void> {
  const { ctx, jobs, log } = env;
  const settings = ctx.settings;
  const config = loadBackupConfig(settings);

  if (!config.autoBackupEnabled) {
    const status = loadAutoBackupStatus(settings);
    if (status.nextDueAt !== null) {
      status.nextDueAt = null;
      saveAutoBackupStatus(settings, status);
    }
    return;
  }

  const lastBackupTime = getLastAutoBackupTime(settings, log);
  const now = env.now();
  const intervalHours = BigInt(config.autoBackupIntervalHours);
  const interval = intervalHours * HOUR_NS;
  const nextDue = lastBackupTime === null ? now : lastBackupTime + interval;
  // chrono `num_hours()` 向零截断，与 BigInt 除法相同；时钟回拨（now < last）时为负数，不到期。
  const shouldBackup = lastBackupTime === null || (now - lastBackupTime) / HOUR_NS >= intervalHours;

  if (!shouldBackup) {
    const status = loadAutoBackupStatus(settings);
    const nextDueAt = toRfc3339(nextDue);
    if (status.nextDueAt !== nextDueAt) {
      status.nextDueAt = nextDueAt;
      saveAutoBackupStatus(settings, status);
    }
    return;
  }

  log.info('[AutoBackup] 开始执行自动备份...');
  const job = jobs.createJob('export');
  job.setParams({ backup_type: 'automatic_backup', include_assets: true, compression_level: 6, include_checksums: true });
  job.markRunning('scan', 2, '自动灾备：正在建立一致性快照', 0, 4);

  let status: AutoBackupStatus;
  try {
    status = loadAutoBackupStatus(settings);
  } catch (error) {
    // RUST-FIX(RF-W30-auto-backup-job-stuck-running): Rust 在这里 `?` 直接返回，任务停在 running。
    job.fail(`读取自动备份状态失败: ${ioMessage(error)}`);
    throw error;
  }
  status.lastAttemptAt = toRfc3339(now);
  status.lastError = null;
  status.lastJobId = job.job_id;
  status.nextDueAt = toRfc3339(now + interval);
  try {
    saveAutoBackupStatus(settings, status);
  } catch (error) {
    job.fail(`持久化自动备份尝试状态失败: ${ioMessage(error)}`);
    throw error;
  }

  let outcome: { artifactName: string; recoveryKind: RecoveryKind };
  try {
    outcome = await performAttempt(env, config, job);
  } catch (error) {
    if (env.aborted()) {
      job.cancelled(ABORTED_MESSAGE);
      log.info(`[AutoBackup] ${ABORTED_MESSAGE}`);
      return;
    }
    status.lastError = ioMessage(error);
    status.nextDueAt = toRfc3339(now + HOUR_NS);
    try {
      saveAutoBackupStatus(settings, status);
    } catch (saveError) {
      log.error(`[AutoBackup] 持久化失败状态失败: ${ioMessage(saveError)}`);
    }
    job.fail(ioMessage(error));
    throw error;
  }

  const completedAt = env.now();
  try {
    writeSetting(settings, LAST_AUTO_BACKUP_KEY, toRfc3339(completedAt));
  } catch (error) {
    job.fail(`持久化自动备份成功时间失败: ${ioMessage(error)}`);
    throw error;
  }
  status.lastSuccessAt = toRfc3339(completedAt);
  status.lastError = null;
  status.nextDueAt = toRfc3339(completedAt + interval);
  try {
    saveAutoBackupStatus(settings, status);
  } catch (error) {
    job.fail(`持久化自动备份成功状态失败: ${ioMessage(error)}`);
    throw error;
  }
  const disasterRecovery = outcome.recoveryKind === 'disaster_recovery';
  const result: BackupJobResultPayload = {
    success: true,
    output_path: outcome.artifactName,
    resolved_path: null,
    message: disasterRecovery
      ? '自动灾备恢复点已验证并发布'
      : '自动便携归档已发布（未加密 ZIP 不含密钥材料，导入后不能整槽恢复；恢复后需重新输入 API 凭据）',
    error: null,
    duration_ms: null,
    stats: { automatic: true, recovery_kind: outcome.recoveryKind, restorable: disasterRecovery },
    requires_restart: false,
    checkpoint_path: null,
    resumable_job_id: null,
  };
  job.complete(`自动备份完成: ${outcome.artifactName}`, 4, 4, result);
}

/** `FileManager::get_writable_app_data_dir`：运行时根是活动数据槽，不可写时按 Rust 顺序回退。 */
async function writableAppDataDir(ctx: Context): Promise<string> {
  const primary = ctx.storage.locations.activeDir;
  if (await ensureWritable(primary)) return primary;
  let paths: PathsService | undefined;
  try { paths = ctx.get('paths') as PathsService | undefined; }
  catch { paths = undefined; }
  if (paths === undefined) return primary;
  const fallback = join(paths.os.data, 'DeepStudent');
  if (await ensureWritable(fallback)) return fallback;
  const temp = join(paths.os.temp, 'deep_student_data');
  if (!(await ensureWritable(temp))) ctx.logger('backup').warn(`⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 ${temp}`);
  return temp;
}

/** 全局租约内的一次备份尝试（`backup_config.rs:390–533` 的 permit + spawn_blocking 闭包）。 */
async function performAttempt(
  env: CheckEnv,
  config: BackupConfig,
  job: BackupJobContext,
): Promise<{ artifactName: string; recoveryKind: RecoveryKind }> {
  const { ctx, operations, log } = env;
  // RUST-FIX(RF-W30-auto-backup-operation-guard): Rust 只拿 BACKUP_GLOBAL_LIMITER 许可（backup_config.rs:399），
  // 不登记当前操作、不持有跨进程锁；这里取完整数据治理租约，kind=AutoBackup。
  const acquired = await operations.acquireForJob('auto_backup', job.job_id, env.aborted);
  if (acquired === 'cancelled') throw new AutoBackupAborted();
  try {
    const root = await writableAppDataDir(ctx);
    const backupsDir = await getEffectiveBackupDir(config, root);
    await createAutoBackupOutputDir(backupsDir);
    // RUST-FIX(RF-W30-auto-backup-staging-sweep): Rust 的 TempDir 在进程退出或崩溃时不会 drop，暂存目录永久残留。
    await sweepStaleAutoBackupStagingDirs(root, message => log.warn(message), message => log.info(message));
    // 原始备份包含 crypto/，只能暂存在本机应用数据目录；自定义目录可能被网盘客户端同步。
    const staging = await createAutoBackupStagingDir(root);
    try {
      return await backupThroughStaging(env, config, job, root, staging.path, backupsDir);
    } finally {
      // tempfile::TempDir 的 drop：清理失败不覆盖本轮结果。
      await staging.cleanup().catch((error: unknown) => {
        log.debug(`[AutoBackup] 清理暂存目录失败 ${staging.path}: ${ioMessage(error)}`);
      });
    }
  } finally {
    acquired.release();
  }
}

async function backupThroughStaging(
  env: CheckEnv,
  config: BackupConfig,
  job: BackupJobContext,
  root: string,
  stagingDir: string,
  backupsDir: string,
): Promise<{ artifactName: string; recoveryKind: RecoveryKind }> {
  const { ctx, operations, log } = env;
  let barrier;
  try { barrier = await operations.enterSnapshotBarrier(); }
  catch (error) { throw new Error(`无法建立一致自动备份快照: ${ioMessage(error)}`); }

  if (config.slimBackup || config.backupTiers !== undefined) {
    log.warn('[AutoBackup] 已忽略旧版精简/分级自动备份配置：自动恢复点必须是可替换数据槽的完整快照');
  }
  let manifest: BackupManifest | null = null;
  let backupFailure: unknown = null;
  try {
    // 自动恢复点不能因默认体积阈值静默降级；产物限制在导入器的解压预算内。
    manifest = await createBackup(
      { ctx, backupRoot: stagingDir, activeDir: root, baseDir: ctx.app.dataDir },
      {
        includeAssets: true,
        assetOptions: { max_file_size: PORTABLE_ASSET_BUDGET, max_total_size: PORTABLE_ASSET_BUDGET },
        checkContinue: () => { if (env.aborted()) throw new AutoBackupAborted(); },
      },
    );
  } catch (error) {
    backupFailure = error;
  }
  try { barrier.release(); }
  catch (error) { throw new Error(`自动备份后恢复数据库连接失败: ${ioMessage(error)}`); }
  if (backupFailure !== null) {
    if (env.aborted()) throw new AutoBackupAborted();
    throw new Error(`完整自动备份失败: ${ioMessage(backupFailure)}`);
  }
  if (manifest === null) throw new Error('完整自动备份失败: 备份未生成清单');

  job.markRunning('verify', 65, '一致性屏障已解除；资产与数据库必须同属一个快照，因此快照阶段无法进一步缩短', 2, 4);
  try { validateForSlotRestore(manifest); }
  catch (error) { throw new Error(`自动备份未达到可恢复完整快照要求，已拒绝导出: ${ioMessage(error)}`); }
  const databaseBytes = manifest.files.reduce((total, file) => total + BigInt(file.size), 0n);
  const assetBytes = BigInt(manifest.assets?.total_size ?? 0);
  if (databaseBytes + assetBytes > PORTABLE_SNAPSHOT_BUDGET) {
    throw new Error('自动备份超过 19 GiB 可移植恢复预算，已拒绝发布无法通过 ZIP 导入的恢复点');
  }

  const backupSubdir = join(stagingDir, manifest.backup_id);
  // 自动备份 ZIP 未加密且可能落在网盘同步目录：打包前剥离 crypto/，恢复后需重新输入 API Key。
  const stripped = stripCryptoSecretsFromBackupDir(backupSubdir);
  if (stripped > 0) {
    markPortableArchiveAfterSecretStripping(manifest, backupSubdir);
    let verification;
    try { verification = await verifyWithAssets(ctx, stagingDir, manifest); }
    catch (error) { throw new Error(`便携归档剥离密钥后校验失败: ${ioMessage(error)}`); }
    // RUST-FIX(RF-W30-auto-backup-portable-verify-result): Rust 只处理 Err，is_valid=false 的结果被忽略后照常发布。
    if (!verification.isValid) {
      const errors = [...verification.databaseErrors,
        ...verification.assetErrors.map(error => `资产校验失败 [${error.path}]: ${error.message}`)];
      throw new Error(`便携归档剥离密钥后校验失败: ${errors.join('; ')}`);
    }
    log.info(`[AutoBackup] 已从备份产物剥离 ${stripped} 个敏感密钥条目（ZIP 不包含 API 凭据解密材料）`);
  }

  const zipName = `auto-backup-${zipTimestamp(env.now())}.zip`;
  job.markRunning('compress', 80, '一致性屏障已解除；正在压缩并发布自动备份', 3, 4);
  let zipPath: string;
  try {
    zipPath = (await exportBackupToZip(ctx, backupSubdir, {
      compressionLevel: 6,
      outputPath: join(backupsDir, zipName),
      includeChecksums: true,
    }, () => undefined, env.aborted)).zipPath;
  } catch (error) {
    if (env.aborted()) throw new AutoBackupAborted();
    throw new Error(`ZIP 导出失败: ${ioMessage(error)}`);
  }
  log.info(`[AutoBackup] 自动备份完成: ${zipName}`);
  if (config.maxBackupCount !== null) {
    await cleanupOldBackups(backupsDir, config.maxBackupCount, message => log.warn(message), message => log.info(message));
  }
  // 可恢复性按 ZIP 内实际（便携）清单判定，而不是暂存目录里的本地清单。
  const portable = await readPublishedManifest(zipPath);
  return { artifactName: zipName, recoveryKind: classifyRecoveryKind(portable).kind };
}

/** `mark_portable_archive_after_secret_stripping`（`backup_config.rs:248–274`）。 */
function markPortableArchiveAfterSecretStripping(manifest: BackupManifest, backupSubdir: string): void {
  manifest.files = manifest.files.filter(file => !isCryptoSecretBackupRelativePath(file.path));
  manifest.snapshot_kind = 'partial_overlay';
  manifest.required_components = [];
  manifest.included_components = manifest.included_components.filter(component => component !== 'crypto');
  manifest.key_policy = 'excluded_portable';
  const crypto = manifest.coverage?.domains.crypto;
  if (crypto === undefined) throw new Error('自动备份覆盖账本缺少 crypto 域');
  crypto.status = 'excluded';
  crypto.paths = [];
  crypto.file_count = 0;
  crypto.total_size = 0;
  crypto.detail = 'excluded from unencrypted portable archive';
  try { saveManifest(join(backupSubdir, MANIFEST_FILENAME), manifest); }
  catch (error) { throw new Error(`更新便携归档清单失败: ${ioMessage(error)}`); }
}

/** `zip_export::portable_manifest_bytes` 的结果：直接读取已发布 ZIP 里的清单。 */
async function readPublishedManifest(zipPath: string): Promise<BackupManifest> {
  let bytes: Uint8Array;
  try {
    const reader = await ZipFileReader.open(zipPath);
    try {
      const entry = reader.find(MANIFEST_FILENAME);
      if (entry === undefined) throw new Error(`ZIP 中缺少 ${MANIFEST_FILENAME}`);
      bytes = await reader.readEntry(entry);
    } finally {
      await reader.close();
    }
  } catch (error) {
    throw new Error(`生成便携清单用于分类失败: ${ioMessage(error)}`);
  }
  try { return parseManifest(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (error) { throw new Error(`解析便携清单失败: ${ioMessage(error)}`); }
}
