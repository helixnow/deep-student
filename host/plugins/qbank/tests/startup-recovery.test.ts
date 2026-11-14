/**
 * V04-05：`lib.rs:3512-3514` 在 build_app_state 最前面同步调用
 * `qbank_generation::recover_interrupted_tasks`（`mod.rs:35-39` → `task_repo.rs:321-342`）：
 * queued/running → failed，error 固定为「应用重启导致任务中断，请重新生成」，写 finished_at；失败只记 warn。
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import qbank from '../index.ts';
import { createTask, getTask, markCompleted, markRunning } from '../repository/generation-tasks.ts';
import {
  QBANK_STARTUP_RECOVERY_FINALIZER, recoverInterruptedTasksAtStartup, registerQbankStartupRecovery,
} from '../src/startup-recovery.ts';
import { createMigratedStorage } from './support/storage.ts';

const RESTART_ERROR = '应用重启导致任务中断，请重新生成';

function recordingLog() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (message: string) => { lines.push(`info ${message}`); },
      warn: (message: string) => { lines.push(`warn ${message}`); },
    },
  };
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-startup-recovery-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({
        dataDir: base,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-startup-recovery' },
      }),
    },
  });
  return {
    storage, host,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('V04-05 qbank startup recovery (lib.rs:3512-3514)', () => {
  it('a storage without the finalizer API leaves plugin apply intact and only warns', () => {
    const warns: string[] = [];
    const ctx = { logger: () => ({ info() {}, warn: (message: string) => { warns.push(message); } }), storage: {} };
    expect(() => registerQbankStartupRecovery(ctx as never)).not.toThrow();
    expect(warns).toEqual([expect.stringContaining('[QbankGeneration] startup recovery finalizer not registered:')]);
  });

  it('registers a startup finalizer that fails queued/running generation tasks with the Rust message', async () => {
    const f = await fixture();
    try {
      const db = f.storage.database('vfs');
      createTask(db, 'task_queued', 'exam_1', '{}', 'stream_q');
      createTask(db, 'task_running', 'exam_1', '{}', 'stream_r');
      markRunning(db, 'task_running');
      createTask(db, 'task_done', 'exam_1', '{}', 'stream_d');
      markCompleted(db, 'task_done', [], 0, [], [], 0);
      const done = getTask(db, 'task_done');

      expect(f.storage.finalizerNames()).toContain(QBANK_STARTUP_RECOVERY_FINALIZER);
      await f.storage.runStartupFinalizers();

      for (const id of ['task_queued', 'task_running']) {
        const task = getTask(db, id)!;
        expect(task).toMatchObject({ status: 'failed', error: RESTART_ERROR });
        expect(task.finished_at).not.toBeNull();
        expect(task.finished_at).toBe(task.updated_at);
      }
      expect(getTask(db, 'task_done')).toEqual(done);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  it('V09-P1-3: an unload before startup withdraws the finalizer; a reinstall after startup does not fail running tasks', async () => {
    const f = await fixture();
    try {
      const db = f.storage.database('vfs');
      const registered = () => f.storage.finalizerNames().filter(name => name === QBANK_STARTUP_RECOVERY_FINALIZER);

      await f.host.unload('dstu.qbank');
      expect(registered()).toEqual([]);
      await f.host.install(qbank);
      expect(registered()).toEqual([QBANK_STARTUP_RECOVERY_FINALIZER]);
      createTask(db, 'task_before_start', 'exam_1', '{}', 'stream_b');
      await f.storage.runStartupFinalizers();
      expect(getTask(db, 'task_before_start')).toMatchObject({ status: 'failed', error: RESTART_ERROR });

      createTask(db, 'task_after_start', 'exam_1', '{}', 'stream_a');
      markRunning(db, 'task_after_start');
      await f.host.unload('dstu.qbank');
      await f.host.install(qbank);
      expect(f.host.plugins.map(plugin => plugin.id)).toContain('dstu.qbank');
      expect(registered()).toEqual([]);
      expect(getTask(db, 'task_after_start')).toMatchObject({ status: 'running', error: null });
    } finally {
      await f.dispose();
    }
  }, 60_000);

  it('logs the Rust warning with the recovered count and returns it', async () => {
    const f = await fixture();
    try {
      const db = f.storage.database('vfs');
      createTask(db, 'task_a', 'exam_1', '{}', 'stream_a');
      createTask(db, 'task_b', 'exam_1', '{}', 'stream_b');
      const { lines, log } = recordingLog();
      expect(recoverInterruptedTasksAtStartup(() => db, log)).toBe(2);
      expect(lines).toEqual(['warn [QbankGeneration] 启动恢复：2 个中断任务已标记为 failed']);
      expect(recoverInterruptedTasksAtStartup(() => db, log)).toBe(0);
      expect(lines).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  it('a failing recovery only warns (mod.rs:36-38), so the startup finalizer chain still completes', async () => {
    const f = await fixture();
    try {
      const { lines, log } = recordingLog();
      expect(recoverInterruptedTasksAtStartup(() => { throw new Error('VFS 数据库未初始化'); }, log)).toBe(0);
      expect(lines).toEqual(['warn [QbankGeneration] 启动恢复中断任务失败: VFS 数据库未初始化']);

      f.storage.database('vfs').exec('DROP TABLE qbank_generation_tasks');
      await expect(f.storage.runStartupFinalizers()).resolves.toMatchObject({
        completed: expect.arrayContaining([QBANK_STARTUP_RECOVERY_FINALIZER]),
      });
    } finally {
      await f.dispose();
    }
  }, 60_000);
});
