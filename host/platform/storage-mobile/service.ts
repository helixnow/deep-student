/**
 * 移动端 `ctx.storage`（{@link StorageService}）：注册库在 OPFS pool 中按桌面相同的相对布局存放，
 * 每库一条连接（{@link MobileDatabase}），启动时用与桌面相同的 refinery 迁移建库。
 *
 * 原型范围：库句柄、openFile、迁移、批处理、维护屏障、启动 finalizer 完整；与桌面的差异与不支持的能力
 * 见 `capabilities.ts`（移动端能力清单），不支持的能力抛 `UNSUPPORTED_ON_PLATFORM`。
 */
import type {
  ConnectionProfile,
  CoordinatedDatabaseName,
  DatabaseMigrationReport,
  DatabaseName,
  DatabaseHandle,
  MaintenanceLease,
  MaintenanceOptions,
  MaintenanceParticipant,
  MigrationReport,
  MigrationService,
  OpenFileOptions,
  StartupCoreRecovery,
  StartupFinalizerReport,
  StartupMigrationFailure,
  StorageLocations,
  StorageService,
} from '../storage/api.ts';
import { batchArchiveOldMistakes, batchCleanupOrphanedMessages } from '../storage/batch-operations.ts';
import { databaseLocation } from '../storage/database-layout.ts';
import { posix } from '../util/path.ts';
import { StorageError, unsupportedOnPlatform } from '../storage/errors.ts';
import { PROFILES } from '../storage/profiles.ts';
import { StartupFinalizerRegistry, type StartupFinalizerRegistration } from '../storage/startup-finalizers.ts';
import { MOBILE_PLATFORM, STORAGE_BROWSER_DATABASE } from './capabilities.ts';
import { MEMORY_DATABASE, MobileConnection } from './connection.ts';
import { MobileDatabase, SharedDatabase, type StorageWarn } from './database.ts';
import { MOBILE_MIGRATION_ORDER, migrateMobileDatabase } from './migrations.ts';
import type { SqliteRuntime } from './sqlite-wasm.ts';
import {
  DATABASE_DEPENDENCIES,
  MobileComponentHealth,
  coreRecoveryPlan,
  dependencySkipReason,
  migrationFailureReason,
  migrationStatusPayload,
} from './startup.ts';

export type MobileStorageLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface MobileStorageOptions {
  readonly runtime: SqliteRuntime;
  /** OPFS pool 内的数据根目录（= `AppInfo.dataDir`）。 */
  readonly baseDir: string;
  readonly log?: MobileStorageLog;
}

const REGISTERED: Record<Exclude<DatabaseName, 'browser'>, true> = { mistakes: true, vfs: true, chat_v2: true, llm_usage: true, audit: true, sync_state: true };
/** 移动端可注册的库（`browser` 只随桌面发布）。 */
const REGISTERED_DATABASES = Object.keys(REGISTERED) as Exclude<DatabaseName, 'browser'>[];

/** OPFS pool 路径是 POSIX 风格的绝对虚拟路径。 */
function join(...parts: string[]): string {
  return posix.resolve('/', ...parts);
}

/** 库位置与桌面共用 `database-layout.ts`（活动槽固定为 slotA：移动端暂无数据空间切换）。 */
function databasePath(activeDir: string, dataLocalDir: string, name: DatabaseName): string {
  const { root, segments } = databaseLocation(name);
  return join(root === 'active' ? activeDir : dataLocalDir, ...segments);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProfile(profile: OpenFileOptions['profile']): ConnectionProfile {
  if (profile === undefined) return PROFILES.plain;
  return typeof profile === 'string' ? PROFILES[profile] : profile;
}

export class MobileStorageService implements StorageService {
  readonly locations: StorageLocations;
  readonly migrations: MigrationService;
  private readonly runtime: SqliteRuntime;
  private readonly log: MobileStorageLog;
  private readonly warn: StorageWarn;
  private readonly registered = new Map<DatabaseName, MobileDatabase>();
  private readonly files = new Set<MobileDatabase | SharedDatabase>();
  private readonly participants = new Map<string, MaintenanceParticipant>();
  /** `late: 'run'` 的异步失败记日志：Worker 里的未处理拒绝到不了外壳（桌面不传，写 stderr）。 */
  private readonly finalizers = new StartupFinalizerRegistry({
    onLateError: error => this.log('error', `${error.message}: ${errorText(error.cause)}`),
  });
  private maintenanceActive = false;
  private readonly maintenance = new Set<DatabaseName>();
  private startupReport: MigrationReport | null = null;
  private coreRecovery?: StartupCoreRecovery;
  private readonly drains: Array<() => void | Promise<void>> = [];
  private shutDown = false;
  /** 最近一次 `runAll()` 的组件健康（backup 插件按同名字段探测）。 */
  componentHealth = new MobileComponentHealth();

  constructor(options: MobileStorageOptions) {
    this.runtime = options.runtime;
    this.log = options.log ?? (() => undefined);
    this.warn = message => this.log('warn', message);
    const activeDir = join(options.baseDir, 'slots', 'slotA');
    this.locations = { baseDir: options.baseDir, activeSlot: 'slotA', activeDir, dataLocalDir: join(options.baseDir, 'local') };
    this.migrations = {
      runAll: () => this.runAll(),
      migrateSingle: async (name) => {
        this.assertOpen();
        return this.migrateOne(name);
      },
      currentVersion: (name) => {
        // 桌面经 `openFile(…, { label: '<库>#version' })` 读版本，卸载后的错误带这个标签。
        this.assertOpen(`${name}#version`);
        const conn = this.database(name).rawConnection();
        return conn.pluck<number | null>("SELECT CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history') THEN (SELECT MAX(version) FROM refinery_schema_history) ELSE 0 END") ?? 0;
      },
      needsMigration: (name) => {
        this.assertOpen();
        const files = this.runtime.migrations[name];
        const versions = Object.keys(files).map(file => Number(/^[UV](\d+)/.exec(file)?.[1] ?? 0));
        return Math.max(0, ...versions) > this.migrations.currentVersion(name);
      },
    };
  }

  pathOf(name: DatabaseName): string {
    return databasePath(this.locations.activeDir, this.locations.dataLocalDir, name);
  }

  private connect(path: string, label: string, profile: ConnectionProfile): MobileConnection {
    return new MobileConnection(this.runtime.sqlite3, this.runtime.open(path), path, { label, profile, unlink: file => this.runtime.unlink(file) });
  }

  /** 迁移指纹回放用的 scratch（桌面 `fingerprint.ts` `openScratch`）：内存库，不占 pool 槽位；调用方负责关闭。 */
  openScratch(): MobileConnection {
    return new MobileConnection(this.runtime.sqlite3, this.runtime.openMemory(), MEMORY_DATABASE, { label: 'migration-scratch', profile: PROFILES.plain });
  }

  /** 服务已卸载时拒绝一切会打开连接的入口：漏开的连接没人关闭，插件重装后还会成为同一文件上的第二条连接（V06-06）。 */
  private assertOpen(database?: string): void {
    if (this.shutDown) throw new StorageError('TX_CLOSED', 'Storage service is disposed', database === undefined ? undefined : { database });
  }

  database(name: DatabaseName): MobileDatabase {
    this.assertOpen(name);
    if (this.maintenance.has(name)) {
      throw new StorageError('MAINTENANCE', `Database ${name} is in maintenance mode`, { database: name });
    }
    return this.registeredHandle(name, false);
  }

  private registeredHandle(name: DatabaseName, deferOpen: boolean): MobileDatabase {
    const existing = this.registered.get(name);
    if (existing !== undefined) return existing;
    if (name === 'browser') throw unsupportedOnPlatform(STORAGE_BROWSER_DATABASE, MOBILE_PLATFORM, 'the browser database and its migrations ship with the desktop build only');
    const profile = PROFILES[name];
    if (profile === undefined) throw new StorageError('UNKNOWN_DATABASE', `Unknown database: ${String(name)}`);
    const path = this.pathOf(name);
    const handle = new MobileDatabase({ name, path, profile, open: () => this.connect(path, name, profile), warn: this.warn, deferOpen });
    this.registered.set(name, handle);
    return handle;
  }

  /**
   * 每个库文件只保留一条连接（同一文件的第二条连接看不到第一条的写入，关闭时还会互相覆盖）：
   * 指向注册库文件时与注册句柄共用连接，profile 以注册库为准；同一文件已被 `openFile` 打开时抛 `BUSY`。
   */
  openFile(path: string, options: OpenFileOptions = {}): DatabaseHandle {
    this.assertOpen(options.label);
    const profile = resolveProfile(options.profile);
    const file = join(path);
    const label = options.label ?? path;
    if ((options.mustExist === true || profile.readonly === true) && !this.runtime.exists(file)) {
      throw new StorageError('SQLITE', 'unable to open database file', { sqliteCode: 'SQLITE_CANTOPEN', database: label, phase: 'execute' });
    }
    const registered = REGISTERED_DATABASES.find(name => this.pathOf(name) === file);
    if (registered !== undefined) {
      const shared = new SharedDatabase(label, file, () => this.database(registered));
      this.files.add(shared);
      return shared;
    }
    for (const open of this.files) {
      if (open.isClosed) this.files.delete(open);
      else if (open.path === file) {
        throw new StorageError('BUSY', `database file ${file} is already open as ${open.name}; close that handle first`, { database: label, sqliteCode: 'SQLITE_BUSY' });
      }
    }
    const handle = new MobileDatabase({ name: label, path: file, profile, open: () => this.connect(file, label, profile), warn: this.warn });
    this.files.add(handle);
    return handle;
  }

  close(handle: DatabaseHandle): void {
    if (!(handle instanceof MobileDatabase || handle instanceof SharedDatabase) || !this.files.has(handle)) {
      throw new StorageError('UNKNOWN_DATABASE', `close() only accepts handles returned by openFile (got ${handle.name})`);
    }
    this.files.delete(handle);
    handle.close();
  }

  batchArchiveOldMistakes(daysOld: number): number {
    return batchArchiveOldMistakes(this.database('mistakes'), daysOld);
  }

  batchCleanupOrphanedMessages(): number {
    return batchCleanupOrphanedMessages(this.database('mistakes'));
  }

  /**
   * 桌面迁移在独立的 `plain` 连接上执行后关闭；移动端同一文件不能并存两条连接，
   * 因此先断开已注册句柄的连接（句柄保持有效，下次访问时按库 profile 重新打开）。
   */
  private migrateOne(id: CoordinatedDatabaseName): DatabaseMigrationReport {
    this.registered.get(id)?.detachConnection();
    const path = this.pathOf(id);
    let conn: MobileConnection;
    try {
      conn = this.connect(path, `${id}#migration`, PROFILES.plain);
    } catch (error) {
      // coordinator.ts `migrateDatabase`：打开失败记为 `MigrationError.database`。
      throw new StorageError('SQLITE', `Database error: ${errorText(error)}`, { database: id, cause: error });
    }
    try {
      const report = migrateMobileDatabase(id, conn, this.runtime.migrations[id], (level, message) => this.log(level, message));
      this.log(report.success ? 'info' : 'error', `migration ${id}: ${report.fromVersion} -> ${report.toVersion} (${report.appliedCount} applied, ${report.durationMs}ms)${report.error ? `: ${report.error}` : ''}`);
      return report;
    } finally {
      conn.close();
    }
  }

  /** backup.ts `currentDatabaseVersionOrZero`：文件不存在或无法读取时为 0。 */
  private currentVersionOrZero(id: CoordinatedDatabaseName): number {
    const path = this.pathOf(id);
    if (!this.runtime.exists(path)) return 0;
    let conn: MobileConnection | undefined;
    try {
      conn = this.connect(path, id, { ...PROFILES.plain, readonly: true });
      return conn.pluck<number | null>("SELECT CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history') THEN (SELECT MAX(version) FROM refinery_schema_history) ELSE 0 END") ?? 0;
    } catch {
      return 0;
    } finally {
      conn?.close();
    }
  }

  /**
   * coordinator.ts `runAll`：按依赖顺序迁移；单库失败只阻断该库及依赖它的库，报告仍正常返回。
   * 失败库的报告与桌面相同记为 `toVersion = fromVersion`、`appliedCount = 0`。
   */
  async runAll(): Promise<MigrationReport> {
    this.assertOpen();
    const started = Date.now();
    const databases: DatabaseMigrationReport[] = [];
    const health = new MobileComponentHealth();
    let error: string | null = null;
    for (const id of MOBILE_MIGRATION_ORDER) {
      const dependency = DATABASE_DEPENDENCIES[id].find(dep => databases.find(r => r.id === dep)?.success !== true);
      if (dependency !== undefined) {
        const reason = dependencySkipReason(dependency);
        this.log('warn', `migration ${id} skipped: ${reason}`);
        health.markDependencyBlocked(id, dependency, reason);
        const current = this.currentVersionOrZero(id);
        databases.push({ id, fromVersion: current, toVersion: current, appliedCount: 0, success: false, durationMs: 0, error: reason });
        continue;
      }
      const fromVersion = this.currentVersionOrZero(id);
      const migrationStarted = Date.now();
      let failure: string | null;
      try {
        const report = this.migrateOne(id);
        failure = report.success ? null : report.error ?? 'unknown error';
        if (failure === null) {
          databases.push(report);
          continue;
        }
      } catch (caught) {
        failure = errorText(caught);
      }
      const reason = migrationFailureReason(id, failure, this.pathOf(id));
      this.log('error', reason);
      health.markBlocked(id, reason);
      error = error === null ? reason : `${error}; ${reason}`;
      databases.push({ id, fromVersion, toVersion: fromVersion, appliedCount: 0, success: false, durationMs: Date.now() - migrationStarted, error: reason });
    }
    const report: MigrationReport = { databases, success: databases.every(r => r.success), totalDurationMs: Date.now() - started, error };
    this.componentHealth = health;
    this.startupReport ??= report;
    return report;
  }

  startupMigrationReport(): MigrationReport | null {
    return this.startupReport;
  }

  /** 见 startup.ts：移动端没有桌面 `runAll` 的全局失败来源。 */
  startupMigrationFailure(): StartupMigrationFailure | null {
    return null;
  }

  startupMaintenance(): { reason: string } | null {
    return this.coreRecovery === undefined ? null : { reason: this.coreRecovery.reason };
  }

  startupCoreRecovery(): StartupCoreRecovery | null {
    return this.coreRecovery === undefined ? null : { reason: this.coreRecovery.reason, databases: [...this.coreRecovery.databases] };
  }

  /**
   * lib.rs:1312-1318：启动迁移后 vfs / mistakes 被阻断时 Rust 不构建 AppState。与桌面相同，在业务插件
   * 装配前对被阻断的核心库进入维护屏障，租约由调用方持有到卸载；不满足条件时返回 `null`。
   */
  async enterCoreRecoveryBarrier(): Promise<MaintenanceLease | null> {
    if (this.coreRecovery !== undefined || this.startupReport === null) return null;
    const plan = coreRecoveryPlan(this.componentHealth);
    if (plan === null) return null;
    const lease = await this.enterMaintenance(plan.databases);
    this.coreRecovery = plan;
    return lease;
  }

  /** backup 插件 `announceMigrationStatus` 在移动端的等价物：启动报告对应的状态事件载荷。 */
  migrationStatusPayload(): Record<string, unknown> | null {
    return this.startupReport === null ? null : migrationStatusPayload(this.startupReport, this.componentHealth);
  }

  async enterMaintenance(names: readonly DatabaseName[] = [...this.registered.keys()], options: MaintenanceOptions = {}): Promise<MaintenanceLease> {
    if (this.maintenanceActive) throw new StorageError('MAINTENANCE', 'storage is already in maintenance mode');
    this.maintenanceActive = true;
    const deadline = Date.now() + (options.drainTimeoutMs ?? 30_000);
    const entered: MobileDatabase[] = [];
    const exits: (() => void)[] = [];
    try {
      for (const participant of this.participants.values()) {
        if (participant.databases !== undefined && !participant.databases.some(name => names.includes(name))) continue;
        await participant.enterMaintenance();
        exits.unshift(() => participant.exitMaintenance());
      }
      for (const name of names) {
        const handle = this.registeredHandle(name, true);
        this.maintenance.add(name);
        await handle.enterMaintenance(deadline);
        entered.push(handle);
      }
    } catch (error) {
      for (const handle of entered) handle.exitMaintenance();
      for (const exit of exits) exit();
      for (const name of names) this.maintenance.delete(name);
      this.maintenanceActive = false;
      throw error;
    }
    let released = false;
    return {
      databases: [...names],
      release: () => {
        if (released) return;
        released = true;
        for (const handle of entered) handle.exitMaintenance();
        for (const exit of exits) exit();
        for (const name of names) this.maintenance.delete(name);
        this.maintenanceActive = false;
      },
    };
  }

  registerFinalizer(name: string, fn: () => void | Promise<void>, options?: StartupFinalizerRegistration): () => void {
    return this.finalizers.register(name, fn, options);
  }

  finalizerNames(): readonly string[] {
    return this.finalizers.names();
  }

  runStartupFinalizers(): Promise<StartupFinalizerReport> {
    return this.finalizers.run();
  }

  registerMaintenanceParticipant(name: string, participant: MaintenanceParticipant): () => void {
    if (this.maintenanceActive) throw new StorageError('MAINTENANCE', 'cannot register a maintenance participant during maintenance');
    if (this.participants.has(name)) throw new StorageError('MAINTENANCE_PARTICIPANT_DUPLICATE', `maintenance participant "${name}" is already registered`);
    this.participants.set(name, participant);
    return () => {
      if (this.participants.get(name) === participant) this.participants.delete(name);
    };
  }

  /**
   * 关闭全部连接（WAL 内容随连接关闭 checkpoint 回库文件）；实例仍可用，之后的 `database()` / `openFile()`
   * 重新打开文件（测试借此模拟进程重开）。插件卸载用 {@link unload}。
   */
  dispose(): void {
    for (const handle of [...this.files, ...this.registered.values()]) {
      try {
        handle.close();
      } catch (error) {
        this.log('warn', `closing ${handle.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.files.clear();
    this.registered.clear();
  }

  /** 终态：关闭全部连接，之后一切开库入口抛 `TX_CLOSED`。可重复调用。 */
  shutdown(): void {
    this.shutDown = true;
    this.dispose();
  }

  /** 卸载时在关闭全部连接之前等待 `drain` 完成（后登记的先执行）；失败只记日志，不阻止关库。 */
  beforeShutdown(drain: () => void | Promise<void>): void {
    this.drains.push(drain);
  }

  /** 插件卸载：先等 {@link beforeShutdown} 登记的收尾，再 {@link shutdown}（Cordis 并发释放同一插件的 effect，收尾不能靠登记顺序）。 */
  async unload(): Promise<void> {
    for (const drain of this.drains.splice(0).reverse()) {
      try { await drain(); }
      catch (error) { this.log('warn', `storage 卸载前的收尾失败: ${errorText(error)}`); }
    }
    this.shutdown();
  }
}
