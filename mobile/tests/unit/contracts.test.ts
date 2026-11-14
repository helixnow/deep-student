/**
 * V06-04：Worker 用构建期打包的 `contracts/ipc` 构造契约集合（以前是 `ContractSet.empty()`，
 * 任何带命令的插件都注册失败、降级为维护占位）。
 */
import { describe, expect, it } from 'vitest';
import { definePlugin } from '../../../host/kernel/core.ts';
import { ContractSet as PortableContractSet } from '../../../host/kernel/contract-set.ts';
import { ContractSet } from '../../../host/kernel/contracts.ts';
import { createTestHost } from '../../../host/kernel/testing.ts';
import { bundledContracts } from '../../src/worker/contracts.ts';

function settingsPlugin() {
  const values = new Map<string, string>();
  return definePlugin({
    meta: { id: 'fixture.settings', commands: ['get_setting', 'save_setting'] },
    apply(ctx) {
      ctx.commands.register<{ key: string }>('get_setting', ({ key }) => values.get(key) ?? null);
      ctx.commands.register<{ key: string; value: string }>('save_setting', ({ key, value }) => {
        values.set(key, value);
        return true;
      });
    },
  });
}

describe('Worker contracts', () => {
  it('are the same set the desktop Host loads from contracts/ipc', () => {
    const bundled = bundledContracts();
    const desktop = ContractSet.fromDirectory();
    expect(bundled).toBeInstanceOf(PortableContractSet);
    expect([...bundled.commands.keys()].sort()).toEqual([...desktop.commands.keys()].sort());
    expect([...bundled.events.keys()].sort()).toEqual([...desktop.events.keys()].sort());
    expect(bundled.commands.size).toBeGreaterThan(1000);
    for (const name of ['get_setting', 'save_setting', 'notes_list']) expect(bundled.commands.get(name)).toEqual(desktop.commands.get(name));
  });

  it('a plugin with commands installs and its commands are invoked through contract validation', async () => {
    const host = await createTestHost({ contracts: bundledContracts(), plugins: [settingsPlugin()] });
    try {
      await expect(host.invoke('save_setting', { key: 'theme', value: 'dark' })).resolves.toBe(true);
      await expect(host.invoke('get_setting', { key: 'theme' })).resolves.toBe('dark');
      await expect(host.invoke('get_setting', { key: 42 })).rejects.toBeDefined();
      expect(host.eventsNamed('host://plugins-degraded')).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('the previous empty contract set could not install the same plugin', async () => {
    await expect(createTestHost({ contracts: PortableContractSet.empty(), plugins: [settingsPlugin()] }))
      .rejects.toThrow('ctx.commands.register("get_setting"): no contract for this command');
  });
});
