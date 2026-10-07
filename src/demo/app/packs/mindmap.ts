/**
 * 思维导图（官网 /user-guide/mindmap）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '思维导图',
  load: () => import('@/features/workbench/apps/mindmap/MindmapAppWindow').then((m) => m.default),
};

export default pack;
