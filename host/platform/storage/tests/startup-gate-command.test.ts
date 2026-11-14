import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import shell from '../../../../electron/index.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await host?.dispose(); host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});
async function start(recovery: boolean, withGate = true) {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-startup-gate-'));
  if (recovery) {
    // A genuine malformed persisted pointer enters the production recovery path.
    fs.mkdirSync(path.join(base, 'recovery'), { recursive: true });
    fs.writeFileSync(path.join(base, 'recovery/current-startup-incident.json'), '{');
  }
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [...(withGate ? [shell] : []), secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
    shell: () => null,
  });
  return host;
}

it.each([false, true])('get_startup_recovery_status waits for the real gate before returning (recovery=%s)', async (recovery) => {
  const h = await start(recovery);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const pending = h.invoke('get_startup_recovery_status').then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(119_999);
  expect(settled).toBe(false);
  h.ctx.startupGate.markStartupReady();
  expect(await pending).toMatchObject({ recovery_required: recovery });
  expect(h.ctx.startupGate.isStartupReady()).toBe(true);
  // startup_gate.rs::late_subscriber_sees_ready_immediately
  expect(await h.invoke('get_startup_recovery_status')).toMatchObject({ recovery_required: recovery });
});

it('wait_times_out_when_never_marked_then_succeeds_after_mark: kernel returns the Rust 120-second AppError', async () => {
  const h = await start(true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = h.invoke('get_startup_recovery_status');
  const assertion = expect(pending).rejects.toEqual({
    error_type: 'Unknown', message: '应用启动初始化超时（120 秒），请重启应用', details: null,
  });
  await vi.advanceTimersByTimeAsync(120_000);
  await assertion;
  expect(h.ctx.startupGate.isStartupReady()).toBe(false);
  h.ctx.startupGate.markStartupReady();
  expect(await h.invoke('get_startup_recovery_status')).toMatchObject({ recovery_required: true });
});

it('get_startup_recovery_status reports state read failure after readiness', async () => {
  const h = await start(true);
  h.ctx.startupGate.markStartupReady();
  const status = vi.spyOn(h.ctx.dataSpace, 'status').mockImplementation(() => { throw new Error('启动恢复状态锁已损坏'); });
  try {
    await expect(h.invoke('get_startup_recovery_status')).rejects.toEqual({
      error_type: 'Unknown', message: '读取启动恢复状态失败: 启动恢复状态锁已损坏', details: null,
    });
  } finally { status.mockRestore(); }
});

it('missing startupGate is a visible wiring error, never an implicit ready state', async () => {
  const h = await start(true, false);
  await expect(h.invoke('get_startup_recovery_status')).rejects.toEqual({
    error_type: 'Unknown', message: '启动完成闸门服务未注册', details: null,
  });
});
