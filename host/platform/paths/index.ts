/**
 * `ctx.paths` 实现。推导规则与引用见 ./api.ts 与 ../API.md。
 */
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import type { DataSlot, PathsService, SlotLayout } from './api.ts';
import type { PathFlavor } from '../files/api.ts';
import { isWithin, parseAbsolute } from '../files/path.ts';
import type { Logger, LogService } from '../log/api.ts';
import { decodeUtf8Strict, rustTrim, utf8ErrorMessage } from '../util/portable.ts';
import { atomicWriteFile, createDirAll } from '../util/durable-fs.ts';
import { ioMessage, rustJoin } from './compat.ts';
import { deviceIdShortHash, normalizeDeviceId } from './device-id-core.ts';
import { SHELL_OS_DIRS_ENV, parseShellOsDirs, resolveAppIdentifier, resolveOsDirs, resolveOsHome, type Env, type Platform } from './os-dirs.ts';

export type * from './api.ts';
export { APP_IDENTIFIER_ENV, SHELL_OS_DIRS_ENV, parseShellOsDirs, resolveAppIdentifier, resolveOsDirs, resolveOsHome } from './os-dirs.ts';
export type { Env, Platform, ShellOsDirKey, ShellOsDirs } from './os-dirs.ts';

export interface PathsOptions {
  /** `AppInfo.dataDir`。 */
  dataDir: string;
  platform: Platform;
  env?: Env;
  /** 设备身份相关日志（对应 Rust tracing）。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function separatorOf(platform: Platform): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/';
}

// ------------------------------------------------------------------ 设备身份

export { deviceIdShortHash, normalizeDeviceId };

/** `device_hostname()`：COMPUTERNAME → HOSTNAME → HOST → "device"（只看环境变量，同 Rust）。 */
function deviceHostname(env: Env): string {
  return env.COMPUTERNAME ?? env.HOSTNAME ?? env.HOST ?? 'device';
}

/** `fs::read_to_string(path).ok()`：读取失败或内容不是合法 UTF-8 都返回 null。 */
async function readUtf8File(path: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  return utf8ErrorMessage(bytes) === null ? decodeUtf8Strict(bytes) : null;
}

async function readDeviceIdFile(path: string): Promise<string | null> {
  // Rust `read_to_string(path).ok()?`：任何读取失败（含非法 UTF-8）都视为该候选不存在。
  const raw = await readUtf8File(path);
  if (raw === null) return null;
  const trimmed = rustTrim(raw);
  return trimmed === '' ? null : normalizeDeviceId(trimmed);
}

/**
 * `data_governance/commands_sync.rs:1197-1220` 的旧位置兼容读取：
 * `fs::read_to_string` 后 `trim()`，非空即原样返回（此处**不**规范化，和 Rust 包装层一致）。
 */
async function readLegacyRootDeviceId(path: string): Promise<string | null> {
  const raw = await readUtf8File(path);
  if (raw === null) return null;
  const trimmed = rustTrim(raw);
  return trimmed === '' ? null : trimmed;
}

async function writeDeviceIdAtomic(path: string, id: string): Promise<void> {
  await createDirAll(dirname(path));
  await atomicWriteFile(path, id);
}

export interface DeviceIdResolution {
  id: string;
  persisted: boolean;
}

type DeviceLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** `resolve_or_create_device_id`（路径注入）。 */
export async function resolveOrCreateDeviceId(
  primary: string | null,
  legacy: readonly string[],
  env: Env,
  log: DeviceLog,
): Promise<DeviceIdResolution> {
  if (primary !== null) {
    const id = await readDeviceIdFile(primary);
    if (id !== null) return { id, persisted: true };
  }
  for (const path of legacy) {
    const id = await readDeviceIdFile(path);
    if (id === null) continue;
    if (primary !== null) {
      try {
        await writeDeviceIdAtomic(primary, id);
        log('info', `设备 ID 已从旧路径 ${path} 迁移到主路径 ${primary}`);
      } catch (error) {
        log('warn', `设备 ID 迁移到主路径 ${primary} 失败（旧路径仍可用，稍后重试）: ${ioMessage(error)}`);
      }
    }
    return { id, persisted: true };
  }
  const newId = normalizeDeviceId(`${deviceHostname(env)}-${randomUUID().slice(0, 8)}`);
  if (primary === null) {
    log('error', '应用数据目录尚未初始化，设备 ID 无法持久化');
    return { id: newId, persisted: false };
  }
  try {
    await writeDeviceIdAtomic(primary, newId);
    log('info', `新设备 ID 已保存到主路径: ${primary}`);
    return { id: newId, persisted: true };
  } catch (error) {
    log('error', `新设备 ID 写入主路径 ${primary} 失败，无法持久化: ${ioMessage(error)}`);
    return { id: newId, persisted: false };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Rust `Path::exists()`：任何 metadata 错误都视为不存在。
    return false;
  }
}

/** `persist_device_id_to_paths`（路径注入）。 */
export async function persistDeviceIdToPaths(
  primary: string | null,
  legacy: readonly string[],
  newId: string,
  log: DeviceLog,
): Promise<void> {
  if (rustTrim(newId) === '') throw new Error('new device id must not be empty');
  let primaryWritten = false;
  if (primary !== null) {
    await writeDeviceIdAtomic(primary, newId);
    primaryWritten = true;
  }
  let wroteAny = primaryWritten;
  for (const path of legacy) {
    if (!(await exists(path))) continue;
    try {
      await writeDeviceIdAtomic(path, newId);
      wroteAny = true;
    } catch (error) {
      if (!primaryWritten) throw error;
      log('warn', `更新旧设备 ID 副本 ${path} 失败（主路径已更新，读取仍以主路径为准）: ${ioMessage(error)}`);
    }
  }
  if (!wroteAny) {
    for (const path of legacy) {
      try {
        await writeDeviceIdAtomic(path, newId);
        wroteAny = true;
        break;
      } catch (error) {
        log('warn', `写入旧设备 ID 位置 ${path} 失败: ${ioMessage(error)}`);
      }
    }
  }
  if (!wroteAny) throw new Error('no writable device id location');
}

// ------------------------------------------------------------------ 服务

/** 判定"真实用户数据"用的根。 */
export interface UserHomeRoots {
  /** 真实用户目录（`userInfo().homedir`）。 */
  readonly realHome: string;
  /**
   * 测试自有的临时目录。它可能就在真实 home 内（服务器作业 `~/oc-jobs-tmp/<id>`、Windows
   * `<profile>\AppData\Local\Temp`），其中的路径属于测试；包含真实 home 的临时目录不算。
   */
  readonly tempDirs: readonly string[];
}

/** Vitest worker 加载本模块时的临时目录：测试随后改写 TMPDIR，先前建的目录仍算测试自有。 */
const STARTUP_TEMP_DIR = tmpdir();

function currentUserHomeRoots(): UserHomeRoots {
  return { realHome: userInfo().homedir, tempDirs: [STARTUP_TEMP_DIR, tmpdir()] };
}

/** 宿主机与目标平台两种写法都试（测试常在 macOS 上以 `platform: 'win32'` 构造）。 */
function pathFlavors(platform: Platform): PathFlavor[] {
  const host: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';
  const target: PathFlavor = platform === 'win32' ? 'win32' : 'posix';
  return host === target ? [host] : [host, target];
}

function pathWithin(child: string, parent: string, flavors: readonly PathFlavor[]): boolean {
  return flavors.some((flavor) => {
    const c = parseAbsolute(child, flavor).parsed;
    const p = parseAbsolute(parent, flavor).parsed;
    return c !== null && p !== null && isWithin(c, p, flavor);
  });
}

/** `path` 在真实 home 内且不在测试自有的临时目录内（按组件比较，Windows 不区分大小写）。 */
export function isRealUserPath(path: string, platform: Platform, roots: UserHomeRoots): boolean {
  const flavors = pathFlavors(platform);
  if (!pathWithin(path, roots.realHome, flavors)) return false;
  return !roots.tempDirs.some((temp) => !pathWithin(roots.realHome, temp, flavors) && pathWithin(path, temp, flavors));
}

/** Vitest 进程中 `home` 是否落在真实用户目录内（测试不得读写该处）。 */
export function isRealUserHomeUnderTest(home: string, platform: Platform = process.platform === 'win32' ? 'win32' : 'linux'): boolean {
  return process.env.VITEST !== undefined && isRealUserPath(home, platform, currentUserHomeRoots());
}

const SANDBOXED_DIR_VARIABLES = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'] as const;

/**
 * Vitest 的 home 沙箱：落在真实用户目录内的 `DS_SHELL_OS_DIRS` 条目与 XDG/AppData 变量去掉，
 * home 仍在真实目录内时改到 `<dataDir>/.test-home`，否则设备 ID 旧路径迁移会读取并复制真实用户的
 * `.device_id`。测试显式指向别处（含真实 home 内的临时目录）的值保留，sync 状态库等按它定位。
 * 无需改动时返回 null。
 */
export function sandboxTestEnv(env: Env, platform: Platform, dataDir: string, roots: UserHomeRoots): Record<string, string | undefined> | null {
  const isReal = (value: string) => isRealUserPath(value, platform, roots);
  const out: Record<string, string | undefined> = { ...env };
  let changed = false;
  const shell = Object.entries(parseShellOsDirs(platform, env).dirs);
  const shellKept = shell.filter(([, value]) => !isReal(value));
  if (shellKept.length !== shell.length) {
    if (shellKept.length === 0) delete out[SHELL_OS_DIRS_ENV];
    else out[SHELL_OS_DIRS_ENV] = JSON.stringify(Object.fromEntries(shellKept));
    changed = true;
  }
  for (const key of SANDBOXED_DIR_VARIABLES) {
    const value = out[key];
    if (value === undefined || (value !== '' && !isReal(value))) continue;
    delete out[key];
    changed = true;
  }
  if (isReal(resolveOsHome(platform, out))) {
    const sandbox = rustJoin(dataDir, separatorOf(platform), '.test-home');
    out.HOME = sandbox;
    out.USERPROFILE = sandbox;
    changed = true;
  }
  return changed ? out : null;
}

function isolatedTestEnv(platform: Platform, dataDir: string): Record<string, string | undefined> | null {
  return process.env.VITEST === undefined ? null : sandboxTestEnv(process.env, platform, dataDir, currentUserHomeRoots());
}

export function createPaths(options: PathsOptions): PathsService {
  const platform = options.platform;
  // 注入的环境做副本：persistDeviceIdAfterRestore 写入 DEVICE_ID 时不影响调用方对象。
  const env: Record<string, string | undefined> = options.env ? { ...options.env }
    : isolatedTestEnv(platform, options.dataDir) ?? process.env;
  const sep = separatorOf(platform);
  const log: DeviceLog = options.log ?? ((level, message) => console[level](`[dstu_storage::data_space::device_id] ${message}`));
  const os = resolveOsDirs(platform, env);
  for (const problem of parseShellOsDirs(platform, env).problems) log('warn', `[paths] ${problem}，该项改按环境变量推导`);
  const base = options.dataDir;
  const { identifier, problem: identifierProblem } = resolveAppIdentifier(platform, env, base);
  if (identifierProblem !== null) log('warn', `[paths] ${identifierProblem}，改用 app data 目录名 ${identifier}`);
  const j = (root: string, ...parts: string[]) => rustJoin(root, sep, ...parts);

  const appLogDir = platform === 'darwin' ? j(os.home, 'Library/Logs', identifier) : j(os.dataLocal, identifier, 'logs');
  const slotsDir = j(base, 'slots');
  const deviceIdFile = j(base, '.device_id');
  const legacyRootDeviceIdFile = j(base, 'device_id');
  const legacyDeviceIdFiles = [
    legacyRootDeviceIdFile,
    ...[os.dataLocal, os.config, os.home].map((dir) => j(dir, 'deep-student', '.device_id')),
  ];
  const debugLogRoots = [...new Set([appLogDir, base, j(slotsDir, 'slotA'), j(slotsDir, 'slotB')])]
    .sort((a, b) => compareRustPaths(a, b, platform));
  let unpersistedDeviceId: string | null = null;

  /**
   * `dstu-storage/src/data_space/device_id.rs::get_device_id()` 的权威语义：
   * `DEVICE_ID` env → 主路径 `.device_id` → 旧路径（命中即迁移）→ 生成并写主路径。
   *
   * 与 `data_governance/commands_sync.rs::get_device_id` 的旧根优先包装分开：
   * L20 继续用 `deviceId()`；L23/L11 等需要底层身份语义的消费方用 `dataSpaceDeviceId()`。
   */
  async function resolveAuthoritativeDeviceId(): Promise<string> {
    const fromEnv = env.DEVICE_ID;
    if (fromEnv !== undefined && fromEnv !== '') return normalizeDeviceId(fromEnv);
    if (unpersistedDeviceId !== null) return unpersistedDeviceId;
    const resolution = await resolveOrCreateDeviceId(deviceIdFile, legacyDeviceIdFiles, env, log);
    if (resolution.persisted) return resolution.id;
    unpersistedDeviceId = resolution.id;
    log('error', `设备 ID 持久化失败，本进程内使用临时设备 ID ${resolution.id}（重启后会变化，云端会出现新设备目录）`);
    return resolution.id;
  }

  const slot: SlotLayout = {
    mainDatabase: (dir) => j(dir, 'mistakes.db'),
    vfsDatabase: (dir) => j(dir, 'databases', 'vfs.db'),
    auditDatabase: (dir) => j(dir, 'databases', 'audit.db'),
    chatV2Database: (dir) => j(dir, 'chat_v2.db'),
    llmUsageDatabase: (dir) => j(dir, 'llm_usage.db'),
    browserDatabase: (dir) => j(dir, 'browser.db'),
    secureDir: (dir) => j(dir, '.secure'),
    masterKeyFile: (dir) => j(dir, '.master_key'),
    join: (dir, ...segments) => j(dir, ...segments),
  };

  const service: PathsService = {
    identifier,
    os,
    appDataDir: base,
    appLocalDataDir: j(os.dataLocal, identifier),
    appConfigDir: j(os.config, identifier),
    appCacheDir: j(os.cache, identifier),
    appLogDir,
    slotsDir,
    slotStateFile: j(slotsDir, 'state.json'),
    slotDir: (s: DataSlot) => j(slotsDir, s),
    recoveryBackupsDir: j(base, 'recovery', 'backups'),
    baseSecureDir: j(base, '.secure'),
    deviceIdFile,
    legacyDeviceIdFiles,
    baseJoin: (...segments) => j(base, ...segments),
    mainLogFile: j(appLogDir, 'deep-student.log'),
    crashLogDir: j(appLogDir, 'crash'),
    debugLogsDir: j(appLogDir, 'debug-logs'),
    structuredLogDir: (kind) => j(appLogDir, kind),
    debugLogRoots,
    fallbackSecureDir: j(os.dataLocal, 'deep-student', '.secure'),
    syncStateDatabase: j(os.dataLocal, 'deep-student', 'sync', 'sync_state.db'),
    slot,

    async deviceId() {
      // `data_governance/commands_sync.rs:1197-1213`：先兼容读取旧位置 `app_data_dir/device_id`。
      // 命中时把原值写回 `DEVICE_ID`（Rust `std::env::set_var`）并直接返回，优先于主路径与 env。
      const legacyRootId = await readLegacyRootDeviceId(legacyRootDeviceIdFile);
      if (legacyRootId !== null) {
        env.DEVICE_ID = legacyRootId;
        log('info', `[data_governance] 迁移旧 device_id (app_data_dir) → 统一: ${legacyRootId}`);
        // 旧值同时落到统一主路径（`dstu-storage/.../device_id.rs` 的一次性迁移语义）。
        // 主路径已存在时不覆盖，保持 Rust 包装层"只读旧文件"的优先级。
        if (!(await exists(deviceIdFile))) {
          try {
            await writeDeviceIdAtomic(deviceIdFile, normalizeDeviceId(legacyRootId));
          } catch (error) {
            log('warn', `设备 ID 迁移到主路径 ${deviceIdFile} 失败（旧路径仍可用，稍后重试）: ${ioMessage(error)}`);
          }
        }
        return legacyRootId;
      }
      return resolveAuthoritativeDeviceId();
    },
    async dataSpaceDeviceId() {
      return resolveAuthoritativeDeviceId();
    },
    normalizeDeviceId,
    deviceIdShortHash,
    generateDeviceIdAfterRestore: () => normalizeDeviceId(`${deviceHostname(env)}-${randomUUID().slice(0, 8)}`),
    async persistDeviceIdAfterRestore(newId) {
      await persistDeviceIdToPaths(deviceIdFile, legacyDeviceIdFiles, newId, log);
      env.DEVICE_ID = newId;
    },
    async rotateDeviceIdAfterRestore() {
      const oldId = await service.deviceId();
      const newId = service.generateDeviceIdAfterRestore();
      await service.persistDeviceIdAfterRestore(newId);
      log('info', `设备 ID 已在恢复后轮换: old=${oldId}, new=${newId}`);
      return [oldId, newId] as const;
    },
  };
  return service;
}

/** `Vec<PathBuf>::sort()`：按路径组件逐个比较（`/a/b` < `/a-b`）。 */
export function compareRustPaths(a: string, b: string, platform: NodeJS.Platform = process.platform): number {
  const separators = platform === 'win32' ? /[\\/]+/ : /\/+/;
  const pa = a.split(separators);
  const pb = b.split(separators);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Buffer.from(pa[i] ?? '');
    const y = Buffer.from(pb[i] ?? '');
    const c = Buffer.compare(x, y);
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

/** Cordis 插件：`ctx.paths`。依赖 kernel 提供的 `ctx.app`。 */
export default definePlugin({
  meta: { id: 'dstu.platform.paths', lane: 'F4-platform', provides: ['paths'] },
  apply(ctx: Context) {
    // log inject 了 paths（定位日志目录），按拓扑排序总在 paths 之后装载，apply 时取不到；
    // 所以每条日志现取 log 服务，log 未装载或已卸载时回落到 Cordis logger。
    const target = 'dstu_storage::data_space::device_id';
    const fallback = ctx.logger(target);
    type DeviceIdLogger = Pick<Logger, 'info' | 'warn' | 'error'>;
    let bound: { service: LogService; logger: DeviceIdLogger } | undefined;
    const logger = (): DeviceIdLogger => {
      const service = ctx.reflect.get('log', false) as LogService | undefined;
      if (service === undefined) return fallback;
      if (bound?.service !== service) bound = { service, logger: (service.logger(target) as Logger | undefined) ?? fallback };
      return bound.logger;
    };
    ctx.reflect.provide('paths', createPaths({
      dataDir: ctx.app.dataDir,
      platform: ctx.app.platform,
      log: (level, message) => logger()[level](message),
    }));
  },
});
