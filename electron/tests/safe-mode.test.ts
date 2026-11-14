/**
 * P1-2：`--safe-mode` 的启动台账与恢复选择（纯模块；Electron 接线见 safe-mode-host.test.ts）。
 *
 * 覆盖：打包版遗留 pending 计一次、开发态不计；正常退出清 pending 且不误计；已就绪后的崩溃不进恢复；
 * 连续两次未就绪才弹对话框；保留配置不备份不重启；备份失败不重启；安全模式不再弹恢复。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  backupUserProfile,
  createStartupRecovery,
  isSafeMode,
  PluginStartupState,
  RECOVERY_FAILURE_THRESHOLD,
  safeModeRestartArgs,
  SAFE_MODE_ARG,
  SAFE_MODE_ENV,
  STARTUP_STATE_FILE,
} from '../shell/safe-mode.ts';

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-safe-mode-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ledgerFile(dir: string): string {
  return join(dir, STARTUP_STATE_FILE);
}

function writeLedger(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

interface RecoveryHarness {
  state: PluginStartupState;
  appDataDir: string;
  dialogs: Array<{ buttons: string[]; message: string }>;
  relaunches: string[][];
  logs: string[];
  recovery: ReturnType<typeof createStartupRecovery>;
}

function harness(options: {
  argv?: string[];
  failures?: number;
  pending?: boolean;
  answer?: (message: string) => number;
  dialogError?: unknown;
  appDataDir?: string;
} = {}): RecoveryHarness {
  const dir = tempDir();
  const appDataDir = options.appDataDir ?? join(dir, 'appdata');
  const file = ledgerFile(dir);
  writeLedger(file, { failures: options.failures ?? 0, pending: options.pending ?? false });
  const state = PluginStartupState.load(file, false);
  const dialogs: RecoveryHarness['dialogs'] = [];
  const relaunches: string[][] = [];
  const logs: string[] = [];
  const answer = options.answer ?? (() => 0);
  const recovery = createStartupRecovery({
    state,
    appDataDir,
    argv: options.argv ?? ['/app/deep-student', '--some-flag'],
    showMessageBox: async (message) => {
      dialogs.push({ buttons: message.buttons, message: message.message });
      if (options.dialogError !== undefined) throw options.dialogError;
      return { response: answer(message.message) };
    },
    relaunch: (args) => relaunches.push(args),
    log: (message) => logs.push(message),
  });
  return { state, appDataDir, dialogs, relaunches, logs, recovery };
}

/** The recovery dialog resolves asynchronously; let its then/catch handlers run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('safe-mode flag', () => {
  it('RF-W06-safe-mode: only the literal --safe-mode argument enables safe mode; relaunch keeps one and preserves other args', () => {
    expect(isSafeMode(['/app/deep-student'])).toBe(false);
    expect(isSafeMode(['/app/deep-student', '--safe-mode'])).toBe(true);
    expect(isSafeMode(['/app/deep-student', '--safe-mode=1'])).toBe(false);
    expect(safeModeRestartArgs(['/app/deep-student', '--profile=x', SAFE_MODE_ARG])).toEqual(['--profile=x', SAFE_MODE_ARG]);
    expect(safeModeRestartArgs(['/app/deep-student', '--safe-mode', '--safe-mode'])).toEqual([SAFE_MODE_ARG]);
    expect(SAFE_MODE_ENV).toBe('DS_SAFE_MODE');
  });
});

describe('PluginStartupState', () => {
  it('B4 normal exit breaks a failure streak before a packaged relaunch', () => {
    const file = ledgerFile(tempDir());
    const state = PluginStartupState.load(file, true);
    state.begin(); state.failed(); state.begin(); state.cleanExit();
    const next = PluginStartupState.load(file, true);
    expect(next.failures).toBe(0);
    expect(next.pending).toBe(false);
    next.begin(); next.failed();
    expect(next.needsRecovery).toBe(false);
  });
  it('RF-W06-startup-recovery: a pending ledger left by packaged launch counts once, while a dev abandonment does not', () => {
    const dir = tempDir();
    const packagedFile = ledgerFile(dir);
    writeLedger(packagedFile, { failures: 0, pending: true });
    const packaged = PluginStartupState.load(packagedFile, true);
    expect(packaged.failures).toBe(1);
    expect(packaged.pending).toBe(false);
    expect(packaged.needsRecovery).toBe(false);
    // 计数后立刻清 pending：同一次遗留只算一次。
    expect(JSON.parse(readFileSync(packagedFile, 'utf8'))).toEqual({ failures: 1, pending: false });

    const devFile = ledgerFile(tempDir());
    writeLedger(devFile, { failures: 0, pending: true });
    const dev = PluginStartupState.load(devFile, false);
    expect(dev.failures).toBe(0);
    expect(dev.pending).toBe(false);
  });

  it('two abandoned packaged startups reach the recovery threshold', () => {
    const dir = tempDir();
    const file = ledgerFile(dir);
    const first = PluginStartupState.load(file, true);
    expect(first.failures).toBe(0);
    first.begin();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ failures: 0, pending: true });
    const second = PluginStartupState.load(file, true);
    expect(second.failures).toBe(1);
    second.begin();
    const third = PluginStartupState.load(file, true);
    expect(third.failures).toBe(RECOVERY_FAILURE_THRESHOLD);
    expect(third.needsRecovery).toBe(true);
  });

  it('RF-W06-startup-recovery: a normal quit clears pending without counting a failure', () => {
    const dir = tempDir();
    const file = ledgerFile(dir);
    const state = PluginStartupState.load(file, true);
    state.begin();
    state.cleanExit();
    expect(state.failures).toBe(0);
    expect(state.pending).toBe(false);
    expect(PluginStartupState.load(file, true).failures).toBe(0);
  });

  it('an unexpected pre-ready exit counts, a ready Host resets, and a failure without pending is ignored', () => {
    const dir = tempDir();
    const state = PluginStartupState.load(ledgerFile(dir), true);
    state.failed();
    expect(state.failures).toBe(0);
    state.begin();
    state.failed();
    expect(state.failures).toBe(1);
    expect(state.pending).toBe(false);
    state.begin();
    state.ready();
    expect(state.failures).toBe(0);
    expect(state.pending).toBe(false);
  });

  it('writes an atomic ledger and rejects a malformed one', () => {
    const dir = tempDir();
    const file = ledgerFile(dir);
    PluginStartupState.load(file, true).begin();
    expect(readdirSync(dir)).toEqual([STARTUP_STATE_FILE]);
    writeLedger(file, { failures: -1, pending: false });
    expect(() => PluginStartupState.load(file, true)).toThrow(/failures/);
    writeFileSync(file, '{not json');
    expect(() => PluginStartupState.load(file, true)).toThrow();
    writeLedger(file, { failures: 1.5, pending: false });
    expect(() => PluginStartupState.load(file, true)).toThrow(/failures/);
    writeLedger(file, { failures: 1, pending: 'yes' });
    expect(() => PluginStartupState.load(file, true)).toThrow(/pending/);
  });
});

describe('backupUserProfile', () => {
  it('copies the profile to a unique .bak and keeps the original untouched', () => {
    const appDataDir = tempDir();
    mkdirSync(join(appDataDir, 'plugins'), { recursive: true });
    const source = join(appDataDir, 'plugins', 'user.profile.json');
    writeFileSync(source, '{"plugins":["demo"]}');
    const first = backupUserProfile(appDataDir, 1_700_000_000_000);
    const second = backupUserProfile(appDataDir, 1_700_000_000_000);
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first!).toContain('user.profile.json.safe-mode-1700000000000-');
    expect(first!.endsWith('.bak')).toBe(true);
    expect(readFileSync(first!, 'utf8')).toBe('{"plugins":["demo"]}');
    expect(readFileSync(source, 'utf8')).toBe('{"plugins":["demo"]}');
  });

  it('returns null when there is no user profile', () => {
    expect(backupUserProfile(tempDir())).toBeNull();
  });

  it('throws when the copy cannot be made (a directory in place of the file)', () => {
    const appDataDir = tempDir();
    mkdirSync(join(appDataDir, 'plugins', 'user.profile.json'), { recursive: true });
    expect(() => backupUserProfile(appDataDir)).toThrow();
  });
});

describe('createStartupRecovery', () => {
  it('B3 HostReady without app.startupReady still counts two failures', () => {
    const h = harness();
    h.recovery.beginStart();
    expect(h.recovery.unexpectedExit(false)).toBe(true);
    expect(h.state.failures).toBe(1);
    h.recovery.beginStart();
    expect(h.recovery.unexpectedExit(false)).toBe(false);
    expect(h.state.failures).toBe(2);
    expect(h.dialogs).toHaveLength(1);
  });
  it('starts the Host below the threshold and stops it only when the ledger already needs recovery', async () => {
    const below = harness({ failures: 1 });
    expect(below.recovery.mayStartHost()).toBe(true);
    expect(below.dialogs).toEqual([]);

    const at = harness({ failures: 2 });
    expect(at.recovery.mayStartHost()).toBe(false);
    await settle();
    expect(at.dialogs).toHaveLength(1);
    expect(at.dialogs[0]!.buttons).toEqual(['保留配置并停止恢复', '备份配置并以安全模式重启']);
    // A second check does not stack dialogs.
    expect(at.recovery.mayStartHost()).toBe(false);
    await settle();
    expect(at.dialogs).toHaveLength(1);
  });

  it('does not count a Host that had become ready and lets the supervisor retry it', async () => {
    const h = harness();
    h.recovery.beginStart();
    h.recovery.ready();
    expect(h.recovery.unexpectedExit(false)).toBe(true);
    expect(h.state.failures).toBe(0);
    expect(h.state.pending).toBe(false);
    await settle();
    expect(h.dialogs).toEqual([]);
  });

  it('RF-W06-startup-recovery: asks only after two consecutive pre-ready exits, and keeping the profile neither backs up nor restarts', async () => {
    const h = harness();
    h.recovery.beginStart();
    expect(h.recovery.unexpectedExit(true)).toBe(true);
    await settle();
    expect(h.dialogs).toEqual([]);
    expect(h.state.failures).toBe(1);

    h.recovery.beginStart();
    expect(h.recovery.unexpectedExit(true)).toBe(false);
    await settle();
    expect(h.dialogs).toHaveLength(1);
    expect(h.state.needsRecovery).toBe(true);
    expect(h.relaunches).toEqual([]);
    expect(h.logs).toContain('[startup] recovery declined; keeping the user profile');
    expect(existsSync(join(h.appDataDir, 'plugins', 'user.profile.json'))).toBe(false);
  });

  it('RF-W06-startup-recovery: an explicit recovery backs up user.profile.json and relaunches with exactly one --safe-mode', async () => {
    const appDataDir = tempDir();
    mkdirSync(join(appDataDir, 'plugins'), { recursive: true });
    writeFileSync(join(appDataDir, 'plugins', 'user.profile.json'), '{"plugins":["demo"]}');
    const h = harness({ failures: 2, appDataDir, answer: () => 1 });
    h.recovery.mayStartHost();
    await settle();
    expect(h.relaunches).toEqual([['--some-flag', SAFE_MODE_ARG]]);
    const backups = readdirSync(join(appDataDir, 'plugins')).filter((name) => name.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(appDataDir, 'plugins', backups[0]!), 'utf8')).toBe('{"plugins":["demo"]}');
    expect(existsSync(join(appDataDir, 'plugins', 'user.profile.json'))).toBe(true);
    expect(h.logs.some((line) => line.includes('copied the user profile'))).toBe(true);
  });

  it('a failed backup reports an error and cancels the restart', async () => {
    const appDataDir = tempDir();
    mkdirSync(join(appDataDir, 'plugins', 'user.profile.json'), { recursive: true });
    const h = harness({ failures: 2, appDataDir, answer: () => 1 });
    h.recovery.mayStartHost();
    await settle();
    expect(h.relaunches).toEqual([]);
    expect(h.dialogs).toHaveLength(2);
    expect(h.dialogs[1]!.message).toContain('备份插件配置失败');
    expect(h.logs.some((line) => line.includes('safe-mode restart cancelled'))).toBe(true);
  });

  it('a failed dialog is logged and does not crash startup', async () => {
    const h = harness({ failures: 2, dialogError: new Error('no display') });
    expect(h.recovery.mayStartHost()).toBe(false);
    await settle();
    expect(h.logs.some((line) => line.includes('cannot show the recovery dialog'))).toBe(true);
    expect(h.relaunches).toEqual([]);
  });

  it('RF-W06-startup-recovery: a safe-mode session never offers recovery again and does not count pre-ready exits', async () => {
    const h = harness({ failures: 5, argv: ['/app/deep-student', SAFE_MODE_ARG] });
    expect(h.recovery.mayStartHost()).toBe(true);
    h.recovery.beginStart();
    expect(h.recovery.unexpectedExit(true)).toBe(true);
    h.recovery.beginStart();
    expect(h.recovery.unexpectedExit(true)).toBe(true);
    await settle();
    expect(h.dialogs).toEqual([]);
    expect(h.state.failures).toBe(5);
  });

  it('a successful startup resets the ledger so the next launch retries the user profile', async () => {
    // 安全模式是上一次会话停在恢复阈值后的唯一入口；它启动成功即清零，下一次普通启动重新尝试用户 profile。
    const dir = tempDir();
    const file = ledgerFile(dir);
    writeLedger(file, { failures: 2, pending: false });
    const state = PluginStartupState.load(file, true);
    const recovery = createStartupRecovery({
      state,
      appDataDir: join(dir, 'appdata'),
      argv: ['/app/deep-student', SAFE_MODE_ARG],
      showMessageBox: async () => ({ response: 0 }),
      relaunch: () => { throw new Error('must not relaunch'); },
      log: () => {},
    });
    expect(recovery.mayStartHost()).toBe(true);
    recovery.beginStart();
    recovery.ready();
    expect(state.failures).toBe(0);
    expect(state.pending).toBe(false);
    expect(PluginStartupState.load(file, true).failures).toBe(0);
    await settle();
  });
});
