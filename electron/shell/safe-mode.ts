/**
 * P1-2 安全模式与启动恢复（W06）。
 *
 * - `--safe-mode`：只有官方插件（Electron 强制官方 profile，Host 还应拒绝社区安装/启用/重载，见
 *   `.reports/lanes/plugin-closeout/interfaces/safe-mode.md`）。`DS_SAFE_MODE=1` 是给 Host 的内部传递值，
 *   非安全模式启动会删掉继承来的同名变量。
 * - 启动台账：`<Electron userData>/plugin-startup-state.json`（在 plugins 之外）。打包版上次遗留的 pending 计一次
 *   未就绪失败；本进程正常退出清 pending 且不计失败；Host 未就绪异常退出立即计一次。
 * - 连续两次未就绪失败后不再自动重启，弹原生对话框：保留配置并停止恢复，或备份
 *   `<appDataDir>/plugins/user.profile.json` 后以 `--safe-mode` 重启。备份失败不重启。
 *
 * 这不是物理隔离声明：安全模式只是换官方 profile 并拒绝社区 UI/安装，备份也不隔离已在运行的代码。
 *
 * RUST-FIX(RF-W06-safe-mode): Rust 没有 `--safe-mode`，也没有强制官方 profile / 拒绝社区 UI 的入口。
 * RUST-FIX(RF-W06-startup-recovery): Rust 没有启动就绪台账、未就绪崩溃计数与备份 profile 的原生恢复对话框。
 */
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const SAFE_MODE_ARG = '--safe-mode';
/** 交给 Host 的内部传递值；不作为用户可控的打包环境变量使用。 */
export const SAFE_MODE_ENV = 'DS_SAFE_MODE';
export const STARTUP_STATE_FILE = 'plugin-startup-state.json';
/** 连续未就绪失败到这个次数才要求用户明确选择。 */
export const RECOVERY_FAILURE_THRESHOLD = 2;

export function isSafeMode(argv: readonly string[]): boolean {
  return argv.includes(SAFE_MODE_ARG);
}

export interface StartupLedger {
  failures: number;
  pending: boolean;
}

function ledgerPath(file: string): string {
  return file;
}

function parseLedger(raw: unknown): StartupLedger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('plugin startup state must be an object');
  const record = raw as Record<string, unknown>;
  const failures = record.failures;
  const pending = record.pending;
  if (typeof failures !== 'number' || !Number.isSafeInteger(failures) || failures < 0) {
    throw new Error('plugin startup state failures must be a non-negative integer');
  }
  if (typeof pending !== 'boolean') throw new Error('plugin startup state pending must be a boolean');
  return { failures, pending };
}

/**
 * 一个台账同时记 main 进程以上次遗留 pending 计的失败与受托管 Host 的未就绪失败；同一进程内不重复计数。
 * 写盘是 `*.tmp` + rename 的原子替换。
 */
export class PluginStartupState {
  private readonly file: string;
  private state: StartupLedger;

  private constructor(file: string, state: StartupLedger) {
    this.file = file;
    this.state = state;
    this.save();
  }

  /** @param countAbandoned 打包版为 true：上次退出时 pending 未清，说明上一个会话没走到就绪/正常退出。 */
  static load(file: string, countAbandoned: boolean): PluginStartupState {
    let previous: StartupLedger = { failures: 0, pending: false };
    if (existsSync(file)) previous = parseLedger(JSON.parse(readFileSync(file, 'utf8')));
    const failures = previous.failures + (countAbandoned && previous.pending ? 1 : 0);
    return new PluginStartupState(file, { failures, pending: false });
  }

  /** 台账损坏时丢弃旧内容（main 记日志），不让一个读不懂的文件卡死启动。 */
  static reset(file: string): PluginStartupState {
    return new PluginStartupState(file, { failures: 0, pending: false });
  }

  get path(): string {
    return ledgerPath(this.file);
  }

  get failures(): number {
    return this.state.failures;
  }

  get pending(): boolean {
    return this.state.pending;
  }

  get needsRecovery(): boolean {
    return this.state.failures >= RECOVERY_FAILURE_THRESHOLD;
  }

  /** 每次启动 Host 前调用：显式标记“这次启动还没到达就绪”。 */
  begin(): void {
    this.state = { failures: this.state.failures, pending: true };
    this.save();
  }

  /** `app.startupReady`（Host 的 dstu.shell startupGate 只发一次）到达：清零连续失败。 */
  ready(): void {
    this.state = { failures: 0, pending: false };
    this.save();
  }

  /** 正常退出/重启：清 pending，不算失败（否则正常退出会被误计崩溃）。 */
  cleanExit(): void {
    this.state = { failures: 0, pending: false };
    this.save();
  }

  /** Host 未就绪异常退出；只有本次启动仍 pending 时计一次。 */
  failed(): void {
    if (!this.state.pending) return;
    this.state = { failures: this.state.failures + 1, pending: false };
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

/**
 * 备份 `<appDataDir>/plugins/user.profile.json` 到同目录唯一文件名，保留原文件。
 * 没有该文件时返回 null（无需备份）；复制失败向上抛，调用方不得继续重启。
 */
export function backupUserProfile(appDataDir: string, now: number = Date.now()): string | null {
  const source = join(appDataDir, 'plugins', 'user.profile.json');
  if (!existsSync(source)) return null;
  const backup = `${source}.safe-mode-${now}-${randomUUID()}.bak`;
  copyFileSync(source, backup, constants.COPYFILE_EXCL);
  return backup;
}

/** `app.relaunch({ args })` 的参数：去掉 argv[0] 与已有 `--safe-mode`，只留一个。 */
export function safeModeRestartArgs(argv: readonly string[]): string[] {
  return [...argv.slice(1).filter((arg) => arg !== SAFE_MODE_ARG), SAFE_MODE_ARG];
}

export interface RecoveryMessage {
  type: 'warning' | 'error';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export interface StartupRecoveryDeps {
  state: PluginStartupState;
  /** 用户数据根；备份 `<appDataDir>/plugins/user.profile.json`。 */
  appDataDir: string;
  /** 本次启动的参数（含打包版 argv[0] 或开发态的 Electron + 入口）。 */
  argv: readonly string[];
  showMessageBox(message: RecoveryMessage): Promise<{ response: number }>;
  /** 以给定参数重启，然后结束当前进程。 */
  relaunch(args: string[]): void;
  log(message: string): void;
}

export interface StartupRecovery {
  /** false：本次不启动 Host（已弹恢复对话框或不需要再尝试）。 */
  mayStartHost(): boolean;
  beginStart(): void;
  ready(): void;
  cleanExit(): void;
  /** Host 自行退出；返回 false 让 HostSupervisor 取消自动重启。 */
  unexpectedExit(transportPreReady?: boolean): boolean;
}

const RECOVERY_BUTTON = 1;

export function createStartupRecovery(deps: StartupRecoveryDeps): StartupRecovery {
  const safeMode = isSafeMode(deps.argv);
  let prompted = false;

  const reportBackupFailure = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log(`[startup] cannot back up the user profile; safe-mode restart cancelled: ${detail}`);
    void deps.showMessageBox({
      type: 'error',
      title: 'Deep Student',
      message: '备份插件配置失败，未以安全模式重启',
      detail,
      buttons: ['确定'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).catch((dialogError: unknown) => deps.log(`[startup] cannot show the backup error dialog: ${String(dialogError)}`));
  };

  const requestRecovery = (): void => {
    if (prompted) return;
    prompted = true;
    void deps.showMessageBox({
      type: 'warning',
      title: 'Deep Student',
      message: '应用连续两次没有启动成功',
      detail: '用户插件配置（user.profile.json）可能导致启动失败。'
        + '可以保留配置并停止自动恢复；或先备份该文件，再以安全模式（仅官方插件）重新启动。',
      buttons: ['保留配置并停止恢复', '备份配置并以安全模式重启'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response !== RECOVERY_BUTTON) {
        deps.log('[startup] recovery declined; keeping the user profile');
        return;
      }
      let backup: string | null;
      try {
        backup = backupUserProfile(deps.appDataDir);
      } catch (error) {
        reportBackupFailure(error);
        return;
      }
      deps.log(backup === null
        ? '[startup] no user profile to back up; restarting in safe mode'
        : `[startup] copied the user profile to ${backup}; restarting in safe mode`);
      deps.relaunch(safeModeRestartArgs(deps.argv));
    }, (error: unknown) => {
      deps.log(`[startup] cannot show the recovery dialog: ${String(error)}`);
    });
  };

  return {
    mayStartHost: () => {
      // 安全模式本身不再弹恢复：已经只有官方插件，重复对话框只会挡住重启。
      if (safeMode) return true;
      if (!deps.state.needsRecovery) return true;
      requestRecovery();
      return false;
    },
    beginStart: () => deps.state.begin(),
    ready: () => deps.state.ready(),
    cleanExit: () => deps.state.cleanExit(),
    unexpectedExit: () => {
      // 就绪后的崩溃仍按 HostSupervisor 的退避重启；安全模式没有可退回的 profile。
      // Transport HostReady does not certify startup finalizers. Only app.startupReady clears pending.
      if (!deps.state.pending || safeMode) return true;
      deps.state.failed();
      if (!deps.state.needsRecovery) return true;
      requestRecovery();
      return false;
    },
  };
}
