/**
 * 深度调研与智能记忆（官网 /user-guide/research-memory）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '深度调研与智能记忆',
  load: () => import('@/features/workbench/apps/chat/ChatSessionWindowFrame').then((m) => m.default),
};

export default pack;
