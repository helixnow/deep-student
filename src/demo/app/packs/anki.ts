/**
 * Anki 制卡与模板（官网 /user-guide/anki）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: 'Anki 制卡与模板',
  load: () => import('@/features/workbench/apps/system/TaskDashboardAppWindow').then((m) => m.default),
};

export default pack;
