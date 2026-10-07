/**
 * 数据管理与云同步（官网 /user-guide/data-sync）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '数据管理与云同步',
  load: () => import('@/features/workbench/apps/system/SettingsAppWindow').then((m) => m.default),
};

export default pack;
