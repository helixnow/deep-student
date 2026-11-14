/**
 * {@link StorageService} 实现与 Cordis 服务注册（`ctx.storage`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Service, type Context } from '@deepseek-ai/cordis';
import {
  DATABASE_NAMES,
  StorageError,
  type CoordinatedDatabaseName,
  type DatabaseHandle,
  type DatabaseMigrationReport,
  type DatabaseName,
  type MaintenanceLease,
  type MaintenanceOptions,
  type MaintenanceParticipant,
  type MigrationReport,
  type MigrationService,
  type OpenFileOptions,
  type StartupFinalizerReport,
  type StartupCoreRecovery,
  type StartupMigrationFailure,
  type StorageLocations,
  type StorageService,
} from './api.ts';

/** lib.rs:1375-1407 的维护顺序（主库在前）；核心恢复只进入其中被阻断的库。 */
const CORE_RECOVERY_DATABASES: readonly CoordinatedDatabaseName[] = ['mistakes', 'vfs', 'chat_v2', 'llm_usage'];
import { SqliteDatabase, MAINTENANCE_REFUSAL_MESSAGE } from './database.ts';
import { batchArchiveOldMistakes, batchCleanupOrphanedMessages } from './batch-operations.ts';
import { databasePath, resolveLocations } from './locations.ts';
import { StartupComponentHealth } from './migration/backup.ts';
import { MigrationCoordinator } from './migration/coordinator.ts';
import { DEFAULT_MIGRATIONS_DIR } from './migration/definitions/index.ts';
import { errorText, MigrationError } from './migration/errors.ts';
import type { MigrationLog } from './migration/helpers.ts';
import { loadSqlMigrations, Runner } from './migration/refinery.ts';
import { PROFILES } from './profiles.ts';
import { storageLog } from './logging.ts';
import { StartupFinalizerRegistry, type StartupFinalizerRegistration } from './startup-finalizers.ts';

export interface StorageServiceOptions {
  /** `AppInfo.dataDir`（Tauri `app_data_dir()`）。 */
  baseDir: string;
  /** 覆盖 `dirs::data_local_dir()`（测试用，避免写到真实用户目录）。 */
  dataLocalDir?: string;
  /** 迁移 SQL 根目录；默认仓库 `resources/app/migrations`（打包时由外壳指向资源目录）。 */
  migrationsDir?: string;
  /**
   * 迁移审计库路径；`null` 关闭审计（= Rust `MigrationCoordinator::with_audit_db(None)`）。
   * 省略时用 `<活动槽>/databases/audit.db`（与既有 `runAll` 相同）。
   */
  auditDbPath?: string | null;
  /** 迁移日志的附加观察者；主日志总会写入（Rust tracing / `log` 语义）。 */
  log?: MigrationLog;
  /** Startup orchestration (data-space preflight, pending switch, purge) precedes migrations. */
  beforeMigrations?: () => Promise<void>;
  /** Recovery-shell mode denies business database access. */
  assertReady?: () => void;
}

/** browser.db 首次打开时的 refinery 迁移失败（= Rust `BrowserError::Migration` 内文）。 */
export class BrowserMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserMigrationError';
  }
}

/**
 * refinery 经 `log` crate 写主日志的 target：verify 阶段的 missing / divergent 显式指定，
 * 其余是所在模块路径（`traits/mod.rs`、`traits/sync.rs`）。
 */
export function refineryLogTarget(message: string): string {
  if (message.startsWith('found migration on file system ') || message.endsWith(' is missing from the filesystem')) {
    return 'refinery_core::traits::missing';
  }
  if (message.startsWith('applied migration ') && message.includes(' is different than filesystem one ')) {
    return 'refinery_core::traits::divergent';
  }
  if (message.startsWith('current version: ') || message.startsWith('schema history table is empty')) return 'refinery_core::traits';
  return 'refinery_core::traits::sync';
}

/** `StorageService.openFile` 与 worker 任务 `openFile` 共用的开库规则（默认 `plain` profile）。 */
export function openFileDatabase(filePath: string, options?: OpenFileOptions): SqliteDatabase {
  const profile = typeof options?.profile === 'object' ? options.profile : PROFILES[options?.profile ?? 'plain'];
  return new SqliteDatabase({
    name: options?.label ?? path.basename(filePath),
    path: filePath,
    profile,
    mustExist: options?.mustExist,
    createParentDirs: options?.createParentDirs,
  });
}

export class StorageServiceImpl implements StorageService {
  private resolvedLocations?: StorageLocations;
  private readonly options: StorageServiceOptions;
  get locations(): StorageLocations {
    this.options.assertReady?.();
    return this.resolvedLocations ??= resolveLocations(this.options.baseDir, { dataLocalDir: this.options.dataLocalDir });
  }
  readonly migrations: MigrationService;
  /** `StartupComponentHealthState`（lib.rs:1080）：启动迁移报告的最新健康快照。 */
  componentHealth = new StartupComponentHealth();
  private startupMigration?: { report: MigrationReport | null; failure: StartupMigrationFailure | null };
  private coreRecovery?: { reason: string; databases: readonly CoordinatedDatabaseName[] };
  private readonly handles = new Map<DatabaseName, SqliteDatabase>();
  private readonly adHoc = new Set<SqliteDatabase>();
  private readonly maintenance = new Set<DatabaseName>();
  private readonly enteringMaintenance = new Set<DatabaseName>();
  private readonly migrationsDir: string;
  private readonly finalizers = new StartupFinalizerRegistry({
    onLateError: (error) => storageLog('dstu_storage::lifecycle', 'error', `启动收尾钩子 ${error.finalizer} 晚注册执行失败: ${errorText(error.cause)}`),
  });
  private readonly participants = new Map<string, { participant: MaintenanceParticipant; order: number }>();
  private nextParticipantOrder = 0;
  private participantMaintenance = false;
  private readonly participantRefs = new Map<string, { entry: { participant: MaintenanceParticipant; order: number }; count: number; ready: Promise<void> }>();
  private shutDown = false;

  constructor(options: StorageServiceOptions) {
    this.options = options;
    this.migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.migrations = new CoordinatorMigrationService(this);
  }

  pathOf(name: DatabaseName): string {
    if (!DATABASE_NAMES.includes(name)) throw new StorageError('UNKNOWN_DATABASE', `Unknown database: ${String(name)}`);
    return databasePath(this.locations, name);
  }

  /** 服务已卸载时拒绝一切会打开连接的入口，否则在途任务会拿到没人关闭的新连接。 */
  private assertOpen(database?: string): void {
    if (this.shutDown) throw new StorageError('TX_CLOSED', 'Storage service is disposed', database === undefined ? undefined : { database });
  }

  database(name: DatabaseName): DatabaseHandle {
    this.assertOpen(name);
    this.options.assertReady?.();
    if (this.maintenance.has(name)) {
      throw new StorageError('MAINTENANCE', `Database ${name} is in maintenance mode`, { database: name });
    }
    let handle = this.handles.get(name);
    if (handle === undefined) {
      handle = new SqliteDatabase({
        name,
        path: this.pathOf(name),
        profile: PROFILES[name],
        onFirstOpen: name === 'browser' ? (h) => this.migrateBrowser(h) : undefined,
      });
      this.handles.set(name, handle);
    }
    return handle;
  }

  /** `BrowserDatabase::run_migrations`：grouped=false、abort_divergent=false、abort_missing=false。 */
  private migrateBrowser(handle: SqliteDatabase): void {
    const runner = new Runner(loadSqlMigrations(path.join(this.migrationsDir, 'browser')), {
      grouped: false,
      abortDivergent: false,
      abortMissing: false,
      log: (level, message) => {
        storageLog(refineryLogTarget(message), level, message);
        this.options.log?.(level, `[refinery:browser] ${message}`);
      },
    });
    try {
      runner.run(handle.rawConnection());
    } catch (error) {
      throw new BrowserMigrationError(`Failed to migrate browser.db: ${errorText(error)}`, { cause: error });
    }
  }

  openFile(filePath: string, options?: OpenFileOptions): DatabaseHandle {
    this.assertOpen(options?.label);
    this.options.assertReady?.();
    const handle = openFileDatabase(filePath, options);
    this.adHoc.add(handle);
    return handle;
  }

  close(handle: DatabaseHandle): void {
    if (!(handle instanceof SqliteDatabase) || !this.adHoc.has(handle)) {
      throw new StorageError('UNKNOWN_DATABASE', `Handle ${handle.name} was not opened with openFile`);
    }
    this.adHoc.delete(handle);
    handle.close();
  }

  /**
   * `Database::switch_to_path`（database/mod.rs:869）：把注册库的主连接重定向到新文件。
   * 句柄身份保持不变；维护屏障期间抛 `MAINTENANCE`（`get_conn_safe` 的拒绝文案）。
   */
  switchToPath(name: DatabaseName, newPath: string): void {
    this.assertOpen(name);
    this.options.assertReady?.();
    if (!DATABASE_NAMES.includes(name)) throw new StorageError('UNKNOWN_DATABASE', `Unknown database: ${String(name)}`);
    if (this.maintenance.has(name)) {
      throw new StorageError('MAINTENANCE', `主数据库${MAINTENANCE_REFUSAL_MESSAGE}`, { database: name });
    }
    const handle = this.handles.get(name);
    if (handle === undefined) {
      // Rust 的 Database 在启动时已存在；这里按 switch_to_path 的最终连接参数直接建立。
      this.handles.set(name, new SqliteDatabase({
        name,
        path: newPath,
        profile: { ...PROFILES[name], synchronous: 'NORMAL' },
      }));
      return;
    }
    handle.switchTo(newPath);
  }

  /**
   * `DatabaseManager::switch_database`（database/manager.rs:108）。Host 用同步 better-sqlite3，
   * 没有读连接池可重建；保留维护屏障拒绝与命令层“刷新数据库连接池失败”的错误形状。
   */
  refreshPool(name: DatabaseName): void {
    if (this.maintenance.has(name)) {
      throw new StorageError('MAINTENANCE', '主数据库连接池处于维护屏障，拒绝切换数据库文件', { database: name });
    }
  }

  /** `batch_operations.rs:17-33`。 */
  batchArchiveOldMistakes(daysOld: number): number {
    return batchArchiveOldMistakes(this.database('mistakes'), daysOld);
  }

  /** `batch_operations.rs:35-49`。 */
  batchCleanupOrphanedMessages(): number {
    return batchCleanupOrphanedMessages(this.database('mistakes'));
  }

  registerFinalizer(name: string, fn: () => void | Promise<void>, options?: StartupFinalizerRegistration): () => void {
    return this.finalizers.register(name, fn, options);
  }

  runStartupFinalizers(): Promise<StartupFinalizerReport> {
    return this.finalizers.run();
  }

  finalizerNames(): readonly string[] {
    return this.finalizers.names();
  }

  registerMaintenanceParticipant(name: string, participant: MaintenanceParticipant): () => void {
    if (typeof name !== 'string' || name.length === 0
      || typeof participant?.enterMaintenance !== 'function'
      || typeof participant?.exitMaintenance !== 'function') {
      throw new StorageError('INVALID_PARAM', 'maintenance participant requires a non-empty name and enter/exit hooks');
    }
    if (this.participantMaintenance || this.maintenance.size > 0 || this.enteringMaintenance.size > 0) {
      throw new StorageError('MAINTENANCE', `cannot register maintenance participant "${name}" during maintenance`);
    }
    if (this.participants.has(name)) {
      throw new StorageError('MAINTENANCE_PARTICIPANT_DUPLICATE', `maintenance participant "${name}" is already registered`);
    }
    const entry = { participant, order: this.nextParticipantOrder++ };
    this.participants.set(name, entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.participants.get(name) === entry) this.participants.delete(name);
    };
  }

  async enterMaintenance(names: readonly DatabaseName[] = DATABASE_NAMES, options?: MaintenanceOptions): Promise<MaintenanceLease> {
    const deadline = Date.now() + (options?.drainTimeoutMs ?? 30_000);
    const entered: DatabaseName[] = [];
    for (const name of names) {
      if (this.maintenance.has(name) || this.enteringMaintenance.has(name)) {
        throw new StorageError('MAINTENANCE', `Database ${name} is already in maintenance mode`, { database: name });
      }
    }
    // Reserve the databases against re-entry, but let in-flight participants
    // finish borrowing their dependencies before closing the database barrier.
    for (const name of names) this.enteringMaintenance.add(name);
    this.participantMaintenance = true;
    let enteredNow: string[] = [];
    try {
      enteredNow = await this.enterParticipants(names, deadline);
      for (const name of names) {
        this.maintenance.add(name);
        entered.push(name);
      }
      for (const name of names) {
        const handle = this.handles.get(name);
        if (handle !== undefined) await handle.enterMaintenance(deadline);
      }
    } catch (error) {
      for (const name of entered) this.releaseOne(name);
      this.releaseParticipants(enteredNow);
      throw error;
    } finally {
      for (const name of names) this.enteringMaintenance.delete(name);
    }
    let released = false;
    return {
      databases: entered,
      release: () => {
        if (released) return;
        released = true;
        for (const name of entered) this.releaseOne(name);
        this.releaseParticipants(enteredNow);
      },
    };
  }

  private participantApplies(participant: MaintenanceParticipant, names: readonly DatabaseName[]): boolean {
    return participant.databases === undefined
      || participant.databases.length === 0
      || participant.databases.some((name) => names.includes(name));
  }

  private async enterParticipants(names: readonly DatabaseName[], deadline: number): Promise<string[]> {
    const entered: string[] = [];
    const ordered = [...this.participants.entries()].sort((a, b) => a[1].order - b[1].order);
    try {
      for (const [name, entry] of ordered) {
        if (!this.participantApplies(entry.participant, names)) continue;
        let current = this.participantRefs.get(name);
        if (current === undefined) {
          const participant: { enterMaintenance(deadline: number): void | Promise<void> } = entry.participant;
          // Publish before yielding: disjoint database leases may drain the
          // same participant concurrently and must share one enter operation.
          current = { entry, count: 1, ready: Promise.resolve().then(() => participant.enterMaintenance(deadline)) };
          this.participantRefs.set(name, current);
        } else {
          current.count += 1;
        }
        entered.push(name);
        await current.ready;
      }
      return entered;
    } catch (error) {
      this.releaseParticipants(entered);
      throw error;
    }
  }

  private releaseParticipants(names: readonly string[]): void {
    for (const name of [...names].reverse()) {
      const current = this.participantRefs.get(name);
      if (current === undefined) continue;
      if (current.count <= 1) {
        this.participantRefs.delete(name);
        this.exitParticipant(name, current.entry.participant);
      } else {
        current.count -= 1;
      }
    }
    if (this.participantRefs.size === 0) this.participantMaintenance = false;
  }

  private exitParticipant(name: string, participant: MaintenanceParticipant): void {
    try { participant.exitMaintenance(); }
    catch (error) {
      storageLog('dstu_storage::maintenance', 'warn', `维护参与者 ${name} 退出失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private releaseOne(name: DatabaseName): void {
    this.maintenance.delete(name);
    this.handles.get(name)?.exitMaintenance();
  }

  startupMigrationReport(): MigrationReport | null {
    return this.startupMigration?.report ?? null;
  }

  startupMigrationFailure(): StartupMigrationFailure | null {
    return this.startupMigration?.failure ?? null;
  }

  startupMaintenance(): { reason: string } | null {
    const failure = this.startupMigrationFailure();
    if (failure?.maintenanceForced) return { reason: failure.error };
    return this.coreRecovery === undefined ? null : { reason: this.coreRecovery.reason };
  }

  startupCoreRecovery(): StartupCoreRecovery | null {
    return this.coreRecovery === undefined ? null : { reason: this.coreRecovery.reason, databases: [...this.coreRecovery.databases] };
  }

  /**
   * lib.rs:1312-1318：启动迁移 Ok 但 vfs / mistakes 被阻断时 Rust 不构建 AppState。Host 改为在业务插件
   * 装配前对被阻断的核心库进入维护屏障，租约交给调用方持有到卸载；不满足条件时返回 `null`。
   */
  async enterCoreRecoveryBarrier(): Promise<MaintenanceLease | null> {
    if (this.coreRecovery !== undefined || this.startupMigration?.report == null) return null;
    const health = this.componentHealth;
    if (!health.requiresCoreRecovery()) return null;
    const databases = CORE_RECOVERY_DATABASES.filter(name => health.isBlocked(name));
    const reason = [...new Set(health.issues()
      .filter(issue => issue.status === 'blocked' && issue.dependency == null
        && (CORE_RECOVERY_DATABASES as readonly string[]).includes(issue.component))
      .map(issue => issue.reason ?? `${issue.component} blocked`))].join('; ');
    const lease = await this.enterMaintenance(databases);
    this.coreRecovery = { reason, databases };
    return lease;
  }

  /** 只记录第一次 `runAll()`；全局失败按 lib.rs:1194-1306 重建组件健康。 */
  recordStartupMigration(outcome: { report: MigrationReport } | { error: unknown }): void {
    if (this.startupMigration !== undefined) return;
    if ('report' in outcome) {
      this.startupMigration = { report: outcome.report, failure: null };
      return;
    }
    const failure = classifyStartupMigrationFailure(outcome.error);
    this.startupMigration = { report: null, failure };
    const health = new StartupComponentHealth();
    if (failure.maintenanceForced) {
      const reason = failure.recovered
        ? `迁移失败后已恢复旧版数据结构: ${failure.error}`
        : `启动迁移无法建立安全状态: ${failure.error}`;
      for (const component of ['vfs', 'mistakes', 'chat_v2', 'llm_usage']) health.markBlocked(component, reason);
    } else {
      health.markDegraded('mistakes', failure.error);
    }
    this.componentHealth = health;
  }

  /** 迁移协调器（每次新建，与 Rust `MigrationCoordinator::new(active_dir)` 一致）。 */
  coordinator(): MigrationCoordinator {
    this.assertOpen();
    return new MigrationCoordinator({
      appDataDir: this.locations.activeDir,
      migrationsDir: this.migrationsDir,
      auditDbPath: this.options.auditDbPath,
      log: this.options.log,
    });
  }

  async prepareMigrations(): Promise<void> {
    this.assertOpen();
    await this.options.beforeMigrations?.();
    this.options.assertReady?.();
  }

  /**
   * 关闭全部连接；实例仍可用，之后的 `database()` / `openFile()` 重新打开文件
   * （`createStorageService` 的调用方借此模拟进程重开）。服务卸载用 {@link shutdown}。
   */
  dispose(): void {
    for (const h of this.adHoc) h.close();
    this.adHoc.clear();
    for (const h of this.handles.values()) h.close();
    this.handles.clear();
  }

  /** 服务卸载：关闭全部连接，之后一切开库入口抛 `TX_CLOSED`。可重复调用。 */
  shutdown(): void {
    this.shutDown = true;
    this.dispose();
  }
}

/** lib.rs:1194-1288 + `data_governance::should_force_maintenance_mode_on_init_failure`。 */
export function classifyStartupMigrationFailure(error: unknown): StartupMigrationFailure {
  if (!(error instanceof MigrationError)) {
    return { error: errorText(error), kind: null, recovered: false, maintenanceForced: true };
  }
  const detail = error.detail;
  const recovered = detail.kind === 'RecoveredFromBackup';
  const fingerprintDrift = detail.kind === 'VerificationFailed' && detail.reason.includes('Schema fingerprint drift detected');
  return {
    error: `Migration error: ${error.message}`,
    kind: detail.kind,
    recovered,
    maintenanceForced: recovered || !fingerprintDrift,
  };
}

class CoordinatorMigrationService implements MigrationService {
  private readonly storage: StorageServiceImpl;

  constructor(storage: StorageServiceImpl) {
    this.storage = storage;
  }

  async runAll(): Promise<MigrationReport> {
    await this.storage.prepareMigrations();
    // 构造时加载迁移定义；Rust 在编译期内嵌，资源目录缺失属于打包错误，不是 run_all 失败。
    const coordinator = this.storage.coordinator();
    let coreReport;
    try {
      coreReport = await coordinator.runAll();
    } catch (error) {
      this.storage.recordStartupMigration({ error });
      throw error;
    }
    this.storage.componentHealth = coreReport.componentHealth;
    const report: MigrationReport = {
      databases: coreReport.databases.map((d): DatabaseMigrationReport => ({ ...d })),
      success: coreReport.success,
      totalDurationMs: coreReport.totalDurationMs,
      error: coreReport.error,
    };
    this.storage.recordStartupMigration({ report });
    return report;
  }

  async migrateSingle(name: CoordinatedDatabaseName): Promise<DatabaseMigrationReport> {
    await this.storage.prepareMigrations();
    return { ...this.storage.coordinator().migrateSingle(name) };
  }

  currentVersion(name: CoordinatedDatabaseName | 'browser'): number {
    const file = this.storage.pathOf(name);
    if (!fs.existsSync(file)) return 0;
    const handle = this.storage.openFile(file, { label: `${name}#version`, profile: 'plain', mustExist: true });
    try {
      const exists = handle.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')");
      if (exists !== 1) return 0;
      return handle.pluck<number | null>('SELECT MAX(version) FROM refinery_schema_history') ?? 0;
    } finally {
      this.storage.close(handle);
    }
  }

  needsMigration(name: CoordinatedDatabaseName): boolean {
    return this.storage.coordinator().needsMigration(name);
  }
}

/** 测试与工具脚本：不经 Cordis 直接创建存储服务（真实 SQLite，调用方给临时目录）。 */
export function createStorageService(options: StorageServiceOptions): StorageServiceImpl {
  return new StorageServiceImpl(options);
}

/**
 * Cordis 服务：`ctx.storage`。依赖 F1 提供的 `ctx.app.dataDir`；卸载时关闭全部连接。
 */
export class StorageCordisService extends Service {
  readonly impl: StorageServiceImpl;
  private readonly drains: Array<() => void | Promise<void>> = [];

  constructor(ctx: Context, options?: Omit<StorageServiceOptions, 'baseDir'>) {
    super(ctx, 'storage');
    this.impl = new StorageServiceImpl({ baseDir: ctx.app.dataDir, ...options });
    // Cordis 并发释放同一插件的顶层 effect；需要在关库前写完的收尾只能经 beforeShutdown 排序。
    ctx.effect(() => async () => {
      for (const drain of this.drains.splice(0).reverse()) {
        try { await drain(); }
        catch (error) { storageLog('dstu_storage::lifecycle', 'warn', `storage 卸载前的收尾失败: ${errorText(error)}`); }
      }
      this.impl.shutdown();
    });
    // 把接口方法暴露在服务实例上，使 `ctx.storage` 满足 StorageService。
    Object.assign(this, {
      migrations: this.impl.migrations,
      pathOf: this.impl.pathOf.bind(this.impl),
      database: this.impl.database.bind(this.impl),
      openFile: this.impl.openFile.bind(this.impl),
      close: this.impl.close.bind(this.impl),
      enterMaintenance: this.impl.enterMaintenance.bind(this.impl),
      startupMigrationReport: this.impl.startupMigrationReport.bind(this.impl),
      startupMigrationFailure: this.impl.startupMigrationFailure.bind(this.impl),
      startupMaintenance: this.impl.startupMaintenance.bind(this.impl),
      startupCoreRecovery: this.impl.startupCoreRecovery.bind(this.impl),
      registerFinalizer: this.impl.registerFinalizer.bind(this.impl),
      runStartupFinalizers: this.impl.runStartupFinalizers.bind(this.impl),
      finalizerNames: this.impl.finalizerNames.bind(this.impl),
      registerMaintenanceParticipant: this.impl.registerMaintenanceParticipant.bind(this.impl),
    });
    Object.defineProperty(this, 'locations', { get: () => this.impl.locations });
  }

  /** 卸载时在关闭全部连接之前等待 `drain` 完成（后登记的先执行）；失败只记日志，不阻止关库。 */
  beforeShutdown(drain: () => void | Promise<void>): void {
    this.drains.push(drain);
  }
}

export type { StorageService };
