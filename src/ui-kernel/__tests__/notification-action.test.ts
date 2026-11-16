import { describe, expect, it, vi } from 'vitest';
import { openPluginNotificationTarget } from '../community';
import { SlotStore } from '../slots';
import type { UiKernel } from '../kernel';

function kernelWithViews() {
  const slots = new SlotStore();
  slots.declare({ name: 'views', cardinality: 'keyed' });
  slots.contribute('views', 'alice.one', { id: 'a-today', key: 'alice.one/today', value: {} });
  slots.contribute('views', 'alice.one', { id: 'b-settings', key: 'alice.one/settings', value: {} });
  const navigate = vi.fn();
  const navigation = { canNavigate: (view: string) => !!slots.get('views', view), navigate };
  return { kernel: { slots, navigation } as unknown as Pick<UiKernel, 'slots' | 'navigation'>, navigate };
}

describe('plugin notification click', () => {
  it('opens the named view, or the plugin\'s first view', () => {
    const { kernel, navigate } = kernelWithViews();
    expect(openPluginNotificationTarget(kernel, { kind: 'plugin', pluginId: 'alice.one', view: 'alice.one/settings', params: { tab: 1 } })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('alice.one', 'alice.one/settings', { tab: 1 });
    expect(openPluginNotificationTarget(kernel, { kind: 'plugin', pluginId: 'alice.one' })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('alice.one', 'alice.one/today', undefined);
  });

  it('ignores other actions and plugins without a view', () => {
    const { kernel, navigate } = kernelWithViews();
    expect(openPluginNotificationTarget(kernel, { kind: 'plugin', pluginId: 'bob.two' })).toBe(false);
    expect(openPluginNotificationTarget(kernel, { kind: 'automation', runId: 'x' })).toBe(false);
    expect(openPluginNotificationTarget(kernel, null)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
