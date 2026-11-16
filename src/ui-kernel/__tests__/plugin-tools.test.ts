/**
 * 用户插件给学习助手新增的工具：Host 在 v2 清单里列出工具名与标题，聊天界面按标题显示工具块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPluginAgentToolName, pluginAgentToolLocalName, pluginAgentToolTitle, recordPluginAgentTools, resetPluginAgentToolsForTest,
} from '../services/plugin-tools';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';

const NAME = 'plugin_0123456789ab_lookup_timetable';
const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never;

beforeEach(() => resetPluginAgentToolsForTest());

describe('plugin agent tool titles', () => {
  it('recognises only the Host-generated shape', () => {
    expect(isPluginAgentToolName(NAME)).toBe(true);
    expect(pluginAgentToolLocalName(NAME)).toBe('lookup_timetable');
    for (const other of ['lookup_timetable', 'builtin-web_search', 'mcp_lookup', 'plugin_lookup_timetable', 'plugin_0123456789AB_x1', `builtin-${NAME}`]) {
      expect(isPluginAgentToolName(other), other).toBe(false);
      expect(pluginAgentToolLocalName(other), other).toBeUndefined();
    }
  });

  it('records the titles a manifest lists and ignores malformed entries', () => {
    recordPluginAgentTools([
      { agentTools: [{ name: NAME, title: '查课表' }] },
      {},
      { agentTools: [{ name: 'web_search', title: '冒充内置工具' }, { name: 'plugin_ba9876543210_empty', title: '' }, null as never] },
    ]);
    expect(pluginAgentToolTitle(NAME)).toBe('查课表');
    expect(pluginAgentToolTitle('web_search')).toBeUndefined();
    expect(pluginAgentToolTitle('plugin_ba9876543210_empty')).toBeUndefined();
  });

  it('keeps a title after its plugin left the manifest, also across a reload', async () => {
    recordPluginAgentTools([{ agentTools: [{ name: NAME, title: '查课表' }] }]);
    recordPluginAgentTools([]); // the plugin was disabled or uninstalled
    expect(pluginAgentToolTitle(NAME)).toBe('查课表');
    vi.resetModules();
    const reloaded = await import('../services/plugin-tools');
    expect(reloaded.pluginAgentToolTitle(NAME)).toBe('查课表');
    // A newer version may rename the tool.
    reloaded.recordPluginAgentTools([{ agentTools: [{ name: NAME, title: '今日课表' }] }]);
    expect(reloaded.pluginAgentToolTitle(NAME)).toBe('今日课表');
  });

  it('shows the declared title on tool chips, and only the local name for a tool this device never saw declared', () => {
    expect(getReadableToolName(NAME, t)).not.toContain('plugin_0123456789ab');
    expect(getReadableToolName(NAME, t)).not.toBe('查课表');
    recordPluginAgentTools([{ agentTools: [{ name: NAME, title: '查课表' }] }]);
    expect(getReadableToolName(NAME, t)).toBe('查课表');
    // Built-in and MCP names are unaffected.
    expect(getReadableToolName('mcp_brave_search', t, { providerName: 'Brave' })).toContain('Brave');
  });
});
