/**
 * 笔记（官网 /user-guide/notes）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '笔记',
  load: () => import('@/features/workbench/apps/notes/NotesWorkspaceApp').then((m) => m.default),
};

export default pack;
