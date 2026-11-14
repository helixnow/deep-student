/**
 * `data_governance_run_slot_c_empty_db_test` / `data_governance_run_slot_d_clone_db_test`
 * 经生产入口：Rust commands.rs:225-372,1280-1296。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { setStorageLogger } from '../../../platform/storage/logging.ts';
import type {} from '../api.ts';
import { createBackupHost, createDatabaseFile, createRealStorage } from './helpers.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  setStorageLogger(null);
});

async function setup(): Promise<{ host: TestHost; activeDir: string; logs: string[] }> {
  const created = await createBackupHost({
    storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
  });
  hosts.push(created.host);
  const logs: string[] = [];
  created.host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) { logs.push(`${message.type} ${message.args.map(String).join(' ')}`); },
  });
  // 与正式 F3 插件相同的父线程日志桥；使用真实 runner，不替换迁移任务或算法。
  setStorageLogger(target => {
    const logger = created.host.ctx.logger(target);
    return {
      target, info: logger.info.bind(logger), warn: logger.warn.bind(logger),
      error: logger.error.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger),
    };
  });
  return { host: created.host, activeDir: join(created.host.app.dataDir, 'slots', 'slotA'), logs };
}

it('run_slot_c_empty_db_test migrates an empty slot, reports per database and cleans the slot', async () => {
  const { host, activeDir, logs } = await setup();
  const result = await host.invoke('data_governance_run_slot_c_empty_db_test', {}) as {
    success: boolean; report: string;
  };

  expect(result.success, result.report).toBe(true);
  expect(result.report).toMatch(/^结果: 成功 \(\d+ms\)\n/);
  for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage']) {
    expect(result.report).toMatch(new RegExp(`  \\[${id}\\] v0 -> v\\d+, 应用 \\d+ 个迁移, \\d+ms\\n`));
  }
  // Rust 264-265：结束后清空并重建 slotC。
  const slotC = join(dirname(activeDir), 'slotC');
  expect(existsSync(slotC)).toBe(true);
  expect(readdirSync(slotC)).toEqual([]);
  // MigrationCoordinator 的 tracing 输出不得丢失。
  expect(logs.some(line => line.startsWith('info') && line.includes('[MigrationCoordinator] 迁移完成'))).toBe(true);
}, 120_000);

it('run_slot_d_clone_db_test reports every missing source database and cleans the slot', async () => {
  const { host, activeDir } = await setup();
  const result = await host.invoke('data_governance_run_slot_d_clone_db_test', {}) as {
    success: boolean; report: string;
  };

  expect(result).toEqual({
    success: false,
    report: '复制文件时出错: /chat_v2.db: 源数据库不存在; /mistakes.db: 源数据库不存在; '
      + '/llm_usage.db: 源数据库不存在; databases/vfs.db: 源数据库不存在\n',
  });
  expect(readdirSync(join(dirname(activeDir), 'slotD'))).toEqual([]);
});

it('slot sandbox reset clears leftovers without a synchronous recursive delete on the Host loop', async () => {
  const { host, activeDir } = await setup();
  const slotD = join(dirname(activeDir), 'slotD');
  mkdirSync(join(slotD, 'databases'), { recursive: true });
  writeFileSync(join(slotD, 'chat_v2.db'), 'leftover');
  writeFileSync(join(slotD, 'databases', 'vfs.db'), 'leftover');
  const cjs = createRequire(import.meta.url)('node:fs') as { rmSync: (path: string, options?: { recursive?: boolean }) => void };
  const original = cjs.rmSync;
  const recursive: string[] = [];
  cjs.rmSync = (path, options) => { if (options?.recursive) recursive.push(path); return original(path, options); };
  syncBuiltinESMExports();
  try {
    const result = await host.invoke('data_governance_run_slot_d_clone_db_test', {}) as { success: boolean };
    expect(result.success).toBe(false);
  } finally {
    cjs.rmSync = original;
    syncBuiltinESMExports();
  }
  expect(recursive).toEqual([]);
  expect(readdirSync(slotD)).toEqual([]);
});

it.skipIf(process.getuid?.() === 0)('a slot that cannot be reset still yields the Rust failure report instead of a command error', async () => {
  const { host, activeDir } = await setup();
  for (const file of ['chat_v2.db', 'mistakes.db', 'llm_usage.db', 'databases/vfs.db']) {
    createDatabaseFile(join(activeDir, file));
  }
  const slots = dirname(activeDir);
  chmodSync(slots, 0o555);
  try {
    // commands.rs:232-235/278-281 `let _ = create_dir_all`：建目录失败被忽略，迁移/复制再报出根因。
    // 修复前 resetDir 直接抛 EACCES，两个命令都以命令错误结束，诊断报告整体失败。
    const slotC = await host.invoke('data_governance_run_slot_c_empty_db_test') as { success: boolean; report: string };
    expect(slotC.success).toBe(false);
    expect(slotC.report).toMatch(/^结果: 失败!\n {2}ROOT CAUSE: .+\n$/);
    const denied = 'Permission denied (os error 13)';
    await expect(host.invoke('data_governance_run_slot_d_clone_db_test')).resolves.toEqual({
      success: false,
      report: `复制文件时出错: /chat_v2.db: ${denied}; /mistakes.db: ${denied}; /llm_usage.db: ${denied}; databases/vfs.db: ${denied}\n`,
    });
    const report = await host.invoke<string>('data_governance_get_migration_diagnostic_report');
    expect(report).toContain('--- 空库迁移测试 (Slot C) ---\n结果: 失败!\n  ROOT CAUSE: ');
    expect(report).toContain(`复制文件时出错: /chat_v2.db: ${denied};`);
  } finally {
    chmodSync(slots, 0o755);
  }
}, 120_000);

it.each([
  'data_governance_get_migration_diagnostic_report',
  'data_governance_run_slot_d_clone_db_test',
] as const)('%s keeps the Host loop responsive after real migration starts', async (command) => {
  const { host, activeDir, logs } = await setup();
  for (const file of ['chat_v2.db', 'mistakes.db', 'llm_usage.db', 'databases/vfs.db']) {
    createDatabaseFile(join(activeDir, file));
  }
  let started = false;
  let ticks = 0;
  let settled = false;
  const timer = setInterval(() => {
    started ||= logs.some(line => line.includes('[Migration] 开始迁移数据库'));
    if (started && !settled) ticks += 1;
  }, 5);
  const before = performance.now();
  try {
    const result = await host.invoke(command);
    settled = true;
    const elapsed = Math.trunc(performance.now() - before);
    // 只计实际迁移日志出现后的心跳，不能仅用 worker 启动/模块加载阶段证明不阻塞。
    expect(started).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    if (command === 'data_governance_get_migration_diagnostic_report') {
      expect(result).toEqual(expect.stringContaining('=== Deep Student 迁移诊断报告 ==='));
      expect(result).toEqual(expect.stringContaining('--- 空库迁移测试 (Slot C) ---'));
      expect(result).toEqual(expect.stringContaining('--- 当前库重试迁移测试 (Slot D) ---'));
      expect(readdirSync(join(dirname(activeDir), 'slotC'))).toEqual([]);
    } else {
      expect(result).toMatchObject({ success: true, report: expect.stringContaining('结果: 成功') });
      expect(Object.keys(result as object).sort()).toEqual(['report', 'success']);
    }
    expect(readdirSync(join(dirname(activeDir), 'slotD'))).toEqual([]);
    // 测试测量回执，不向生产 IPC 增加 threadId 或计时字段，也不设业务耗时阈值。
    console.info('L21 migration worker probe', { command, elapsed_ms: elapsed, ticks_after_migration_start: ticks });
  } finally { clearInterval(timer); }
}, 120_000);

it('concurrent slot C commands keep reset, worker migration and cleanup in one serial lifecycle', async () => {
  const { host, activeDir } = await setup();
  const results = await Promise.all([
    host.invoke('data_governance_run_slot_c_empty_db_test'),
    host.invoke('data_governance_run_slot_c_empty_db_test'),
  ]);
  for (const result of results) {
    expect(result).toMatchObject({ success: true, report: expect.stringContaining('结果: 成功') });
  }
  expect(readdirSync(join(dirname(activeDir), 'slotC'))).toEqual([]);
}, 120_000);
