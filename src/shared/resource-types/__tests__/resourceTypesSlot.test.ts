/**
 * `resource.types` 槽位接线：官方宿主声明 keyed 槽位并贡献 8 个内置类型；
 * 卸载官方 Learning Hub 插件即撤销整张表。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import learningHubPlugin from '@/ui-plugins/official/learning-hub';
import { OFFICIAL_RESOURCE_TYPE_IDS } from '../official';

let kernel: UiKernel | undefined;
afterEach(async () => {
  await kernel?.dispose();
  kernel = undefined;
});

async function installHost(): Promise<UiKernel> {
  const k = new UiKernel(memoryRegistryAdapters());
  await k.install(learningHubPlugin, { origin: 'builtin' });
  return k;
}

describe('resource.types slot', () => {
  it('is declared keyed by the Learning Hub host and lists every official type', async () => {
    kernel = await installHost();
    expect(kernel.slots.definition('resource.types')).toMatchObject({ cardinality: 'keyed' });
    const entries = kernel.slots.list('resource.types');
    expect(entries.map((entry) => entry.key)).toEqual([...OFFICIAL_RESOURCE_TYPE_IDS]);
    expect(new Set(entries.map((entry) => entry.owner))).toEqual(new Set(['dstu.ui.learning-hub']));
    for (const entry of entries) {
      expect(entry.value.type).toBe(entry.key);
      expect(entry.value.operations).toHaveLength(9);
      expect(entry.value.labelKey).toMatch(/^learningHub:resourceType\./);
    }
  });

  it('withdraws the table when the host plugin unloads', async () => {
    kernel = await installHost();
    await kernel.unload('dstu.ui.learning-hub');
    expect(kernel.slots.list('resource.types')).toEqual([]);
  });
});
