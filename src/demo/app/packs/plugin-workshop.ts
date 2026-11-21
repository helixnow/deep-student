/**
 * 第 20 章「AI 插件工坊与插件管理」：设置窗口的「工具与扩展 → 插件管理」页，
 * 展示自然语言插件创作栏、3 个真实学习场景自制/社区插件卡片、5 组内置能力与微信 iLink Bot 渠道插件。
 */
import type { DemoAppPack } from '../types';
import { chain } from '../shared';
import { handleDemoModelSettings } from '../data/settings/models';
import { handleDemoSettingsShell } from '../data/settings/common';
import { handleDemoPlugins } from '../data/settings/plugins';

const pack: DemoAppPack = {
  title: 'AI 插件工坊与插件管理',
  load: () => import('../data/settings/SettingsWindow').then((m) => m.default),
  handle: chain(handleDemoPlugins, handleDemoModelSettings, handleDemoSettingsShell),
  namespaces: ['settings', 'plugin_manager', 'workbench', 'forms', 'data', 'chat_host'],
  async prepare() {
    const { setPendingSettingsRoute } = await import('@/utils/pendingSettingsTab');
    setPendingSettingsRoute({ tab: 'plugins' });
  },
  isReady: (root) => /高数公式速查表|我的插件/.test(root.textContent ?? ''),
};

export default pack;
