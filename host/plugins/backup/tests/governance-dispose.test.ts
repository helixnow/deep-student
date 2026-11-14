/** V09 P2-4：备份插件卸载时沙箱命令先返回，等测试槽收尾有上限，卡住的槽不拖住整条卸载链。 */
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import type { SlotMigrationTestResponse } from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
import { Governance, GOVERNANCE_DISPOSE_WAIT_MS } from '../src/governance.ts';
import { createBackupHost } from './helpers.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.dispose();
});

const OK: SlotMigrationTestResponse = { success: true, report: '' };
const TIMED_OUT = `${GOVERNANCE_DISPOSE_WAIT_MS}ms 内未收尾`;

/** 卸载先中止进行中的命令：沙箱命令立即以停止原因返回，测试本身留在后台。 */
function settled(invoke: Promise<unknown>): Promise<string> {
  return invoke.then(value => `resolved ${JSON.stringify(value)}`, (error: unknown) => String(error instanceof Error ? error.message : error));
}

/** Slot C 停在 `executeSlotCTest` 里，直到测试调用 `release`。 */
async function heldSlotC(): Promise<{ host: TestHost; logs: string[]; release: () => void; test: Promise<string> }> {
  const { host } = await createBackupHost();
  hosts.push(host);
  const logs: string[] = [];
  host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) { logs.push(message.args.map(String).join(' ')); },
  });
  let release: (() => void) | undefined;
  vi.spyOn(Governance.prototype as unknown as Record<string, () => Promise<SlotMigrationTestResponse>>, 'executeSlotCTest')
    .mockImplementation(() => new Promise(resolve => { release = () => resolve(OK); }));
  const test = settled(host.invoke('data_governance_run_slot_c_empty_db_test', {}));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  return { host, logs, release: () => release!(), test };
}

it('V09 P2-4: a slot test that never settles holds backup unload for GOVERNANCE_DISPOSE_WAIT_MS, then unload proceeds with a warning', async () => {
  const { host, logs, release, test } = await heldSlotC();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const step = GOVERNANCE_DISPOSE_WAIT_MS / 10;
  const start = Date.now();
  let unloadedAt: number | undefined;
  const unloading = host.unload('dstu.backup').then(() => { unloadedAt = Date.now(); });

  for (let i = 0; i < 20 && unloadedAt === undefined; i++) await vi.advanceTimersByTimeAsync(step);
  await unloading;
  expect(unloadedAt! - start).toBeGreaterThanOrEqual(GOVERNANCE_DISPOSE_WAIT_MS);
  expect(unloadedAt! - start).toBeLessThanOrEqual(GOVERNANCE_DISPOSE_WAIT_MS + step);
  expect(logs.filter(line => line.includes(TIMED_OUT))).toHaveLength(1);

  expect(await test).toContain('is being unregistered');

  vi.useRealTimers();
  release();
});

it('V09 P2-4: a slot test that settles within the budget is still awaited by unload, without a warning', async () => {
  const { host, logs, release, test } = await heldSlotC();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let unloaded = false;
  const unloading = host.unload('dstu.backup').then(() => { unloaded = true; });

  await vi.advanceTimersByTimeAsync(GOVERNANCE_DISPOSE_WAIT_MS / 2);
  expect(unloaded).toBe(false);
  expect(await test).toContain('is being unregistered');
  release();
  await unloading;
  expect(logs.filter(line => line.includes(TIMED_OUT))).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
