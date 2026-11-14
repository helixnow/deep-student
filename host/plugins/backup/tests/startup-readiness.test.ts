/** B02：commands.rs:434-439 先等真实 F2 startup gate，再读取维护状态。 */
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createStartupGate } from '../../../../electron/startup-gate.ts';
import type { StartupGate } from '../../../../electron/api.ts';
import { createBackupHost } from './helpers.ts';

const hosts: TestHost[] = [];
const gates: StartupGate[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.markStartupReady();
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setup(gate: StartupGate): Promise<TestHost> {
  gates.push(gate);
  const { host } = await createBackupHost({ startupGate: gate });
  hosts.push(host);
  return host;
}

it('B02 maintenance status stays pending until the real F2 startup gate is ready', async () => {
  const gate = createStartupGate();
  const host = await setup(gate);
  let settled = false;
  const outcome = host.invoke('data_governance_get_maintenance_status').then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; },
  );
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  gate.markStartupReady();
  expect(await outcome).toMatchObject({ value: { is_in_maintenance_mode: false, blocked_components: [] } });
});

it('B02 maintenance status preserves the Rust 120-second startup timeout error', async () => {
  const gate = createStartupGate();
  const host = await setup(gate);
  // 只推进真实 F2 gate 的时钟，不修改生产 120s 常量或测试/IPC 预算。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const outcome = host.invoke('data_governance_get_maintenance_status').then(
    value => { settled = true; return value; },
    error => { settled = true; return error; },
  );
  await vi.advanceTimersByTimeAsync(119_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toBe('应用启动初始化超时（120 秒），请重启应用');
});

it('B02 maintenance status returns immediately when the real F2 gate is already ready', async () => {
  const gate = createStartupGate();
  gate.markStartupReady();
  const host = await setup(gate);
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: false, blocked_components: [], current_operation: null,
  });
});
