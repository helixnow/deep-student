/**
 * 模型与供应商配置（官网 /user-guide/models）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '模型与供应商配置',
  load: () => import('@/features/workbench/apps/system/SettingsAppWindow').then((m) => m.default),
};

export default pack;
