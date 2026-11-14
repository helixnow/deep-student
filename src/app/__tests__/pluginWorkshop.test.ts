import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render } from '@testing-library/react';
import { usePluginManagerWorkshop } from '@/features/plugin-manager/workshop';
import { UiKernel } from '@/ui-kernel/kernel';
import plugin from '@/ui-plugins/official/plugin-workshop';
import { workshopContributions } from '@/ui-plugins/official/plugin-workshop/api';
import '@/app/pluginWorkshop';

vi.mock('@/features/plugin-manager/host-adapter', () => ({ createHostPluginManagerAdapter: () => ({ list: async () => ({ plugins: [] }) }) }));

describe('workshop production assembly', () => {
  it('RF-P5-workshop-assembly: uses the paired workshop caller and revokes manager binding on unload', async () => {
    const invoke = vi.fn(async () => ({ id: 'dstu-plugin-development', markdown: '---\nname: dstu-plugin-development\ndescription: Workshop\n---\n', schemaToolIds: [] }));
    const kernel = new UiKernel({ invoke });
    expect(workshopContributions.values()).toHaveLength(1);
    await kernel.install(plugin, { origin: 'builtin' });
    const entry = kernel.slots.list('chat.toolResults').find(item => item.key === 'dstu_plugin_propose_install');
    expect(entry?.owner).toBe('dstu.plugin-workshop');
    expect(invoke).toHaveBeenCalledWith('plugin:host|call', {
      caller: 'dstu.plugin-workshop', service: 'pluginWorkshop', method: 'developmentSkill', args: [false],
    });
    function ManagerBinding() {
      return React.createElement('p', null, usePluginManagerWorkshop() ? 'bound' : 'unbound');
    }
    const view = render(React.createElement(ManagerBinding));
    expect(view.getByText('bound')).toBeInTheDocument();
    await act(async () => { await kernel.unload(plugin.meta.id); });
    expect(view.getByText('unbound')).toBeInTheDocument();
    expect(kernel.slots.list('chat.toolResults')).toEqual([]);
    await kernel.dispose();
  });
});
