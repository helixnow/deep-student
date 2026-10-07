/**
 * 第 14 章「模型与供应商配置」：设置窗口的「模型服务」页。13 家预置供应商 + 一家本机
 * Ollama；硅基流动、DeepSeek、月之暗面已存密钥（只有掩码，没有任何真实密钥），各功能
 * 槽位已分配，嵌入维度 1024（bge-m3）设为默认。切到「模型分配」可以改槽位、管理维度，
 * 全部在内存里生效；测试连接、获取模型列表、ChatGPT 登录等需要联网的提示去桌面版。
 */
import type { DemoAppPack } from '../types';
import { chain } from '../shared';
import { DEMO_MODEL_SETTINGS, handleDemoModelSettings } from '../data/settings/models';
import { handleDemoSettingsShell } from '../data/settings/common';

const pack: DemoAppPack = {
  title: '模型与供应商配置',
  load: () => import('../data/settings/SettingsWindow').then((m) => m.default),
  handle: chain(handleDemoModelSettings, handleDemoSettingsShell),
  settings: DEMO_MODEL_SETTINGS,
  namespaces: ['settings', 'workbench', 'forms', 'data', 'chat_host'],
  async prepare() {
    // 走生产里「直达某分区」的入口：桌面布局切到该页，窄窗口（手机宽度）跳过分区列表直接进内容
    const { setPendingSettingsRoute } = await import('@/utils/pendingSettingsTab');
    setPendingSettingsRoute({ tab: 'apis' });
  },
};

export default pack;
