/**
 * 待办与番茄钟（官网 /user-guide/productivity）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '待办与番茄钟',
  load: () => import('@/features/workbench/apps/system/TodoAppWindow').then((m) => m.default),
};

export default pack;
