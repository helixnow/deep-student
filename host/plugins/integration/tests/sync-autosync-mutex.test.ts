import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import type { MaintenanceStatusResponse } from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
// boundary-allow cross-plugin-impl: L22 集成测试经 L21 公开宿主装配验证唯一全局操作许可
import { createBackupHost } from '../../backup/tests/helpers.ts';

/**
 * `sync_r11_autosync.rs::r11_autosync_manual_mutex_try_acquire_fails_closed_and_recovers`
 * 的 TS 行为级移植。
 *
 * 自动/手动同步共用 L21 唯一的全局数据治理许可：手动同步走
 * `backup.syncCommandPorts().limiter.tryAcquire()`，自动同步走
 * `backup.tryAcquireOperation('sync')`。测试直接用真实协调器验证立即失败、
 * 稳定 busy 文案、holder 账本、显式 `release()` 后恢复，不建局部锁、不用替身。
 */
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setup(): Promise<TestHost> {
  const created = await createBackupHost();
  hosts.push(created.host);
  return created.host;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function maintenanceStatus(host: TestHost): Promise<MaintenanceStatusResponse> {
  return await host.invoke('data_governance_get_maintenance_status') as MaintenanceStatusResponse;
}

describe('sync_r11_autosync.rs', () => {
  it('r11_autosync_manual_mutex_try_acquire_fails_closed_and_recovers', async () => {
    const host = await setup();
    const ports = host.ctx.backup.syncCommandPorts();

    // 场景 A：手动同步持有同一把全局许可，自动同步的 tryAcquire 必须立即失败。
    const manualPermit = ports.limiter.tryAcquire();
    expect(manualPermit).not.toBeNull();
    let busyMessage = '';
    try { host.ctx.backup.tryAcquireOperation('sync'); }
    catch (error) { busyMessage = messageOf(error); }
    expect(busyMessage).toContain('已有数据治理操作正在运行');

    manualPermit!.release();

    // 场景 B：手动同步释放后自动同步可取得许可；持有期间账本可见 holder。
    const autoGuard = host.ctx.backup.tryAcquireOperation('sync');
    expect(autoGuard.snapshot.kind).toBe('sync');
    const heldStatus = await maintenanceStatus(host);
    expect(heldStatus.current_operation?.operation_id).toBe(autoGuard.operationId());
    expect(heldStatus.current_operation?.kind).toBe('sync');

    // 场景 C：自动同步持锁期间，手动同步同样立即失败并能看到 holder 信息。
    let secondMessage = '';
    try { host.ctx.backup.tryAcquireOperation('sync'); }
    catch (error) { secondMessage = messageOf(error); }
    expect(secondMessage).toContain('已有数据治理操作正在运行');
    expect(secondMessage).toContain(autoGuard.operationId());

    // 场景 D：显式 release 后账本清空，全局许可可再次获取。
    autoGuard.release();
    const releasedStatus = await maintenanceStatus(host);
    expect(releasedStatus.current_operation).toBeNull();
    const recovered = ports.limiter.tryAcquire();
    expect(recovered).not.toBeNull();
    recovered!.release();
  });
});
