import { expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';

it('R4-SYNC-03: status rejects maintenance before opening any database or resolving device identity', async () => {
  const pathOf = vi.fn(() => { throw new Error('must not read paths'); });
  const deviceId = vi.fn(async () => 'device');
  const host = await createTestHost({ plugins: [sync], provide: { storage: { pathOf }, paths: { deviceId },
    vfsDatabase: { isInMaintenanceMode: () => true } } });
  try {
    await expect(host.invoke('data_governance_get_sync_status')).rejects.toBe('数据治理操作正在进行（维护模式），请稍后再试。');
    expect(pathOf).not.toHaveBeenCalled(); expect(deviceId).not.toHaveBeenCalled();
  } finally { await host.dispose(); }
});

it('R4-SYNC-03: empty resolve logs then checks maintenance; retired nonempty requests do neither', async () => {
  const order: string[] = [];
  const host = await createTestHost({ plugins: [sync], provide: { storage: {}, paths: {},
    vfsDatabase: { isInMaintenanceMode: () => { order.push('maintenance'); return true; } } } });
  const disposeLog = host.ctx.logger.exporter({ export: entry => {
    if (entry.name === 'sync' && entry.type === 'info') order.push(String(entry.args[0]));
  } });
  try {
    await expect(host.invoke('data_governance_resolve_conflicts', { strategy: '', cloudManifestJson: '' })).rejects.toBe('数据治理操作正在进行（维护模式），请稍后再试。');
    expect(order).toEqual(['[data_governance] 开始解决冲突，策略: ', 'maintenance']);
    order.length = 0;
    await expect(host.invoke('data_governance_resolve_conflicts', { strategy: 'keep_local', cloudManifestJson: '' })).rejects.toContain('批量清单级冲突接口已停用');
    expect(order).toEqual([]);
  } finally { disposeLog(); await host.dispose(); }
});

it('R4-SYNC-03: status logs final aggregate before resolving the device ID', async () => {
  const order: string[] = [];
  const host = await createTestHost({ plugins: [sync], provide: {
    storage: { pathOf: () => '/nonexistent-sync-status-fixture' },
    paths: { deviceId: async () => { order.push('device'); return 'device'; } },
  } });
  const disposeLog = host.ctx.logger.exporter({ export: entry => {
    if (entry.name === 'sync' && entry.type === 'info') order.push(String(entry.args[0]));
  } });
  try {
    await expect(host.invoke('data_governance_get_sync_status')).resolves.toMatchObject({ total_pending_changes: 0, total_synced_changes: 0 });
    expect(order).toEqual(['[data_governance] 同步状态: pending=0, synced=0, databases=0', 'device']);
  } finally { disposeLog(); await host.dispose(); }
});
