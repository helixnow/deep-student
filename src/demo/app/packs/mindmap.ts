/**
 * 第 08 章「思维导图」：打开《线性代数》第 5 章「特征值与特征向量」导图（画布视图），
 * 几处要点已做好挖空。大纲 / 导图切换、编辑、搜索、背诵模式（揭示、难点优先、
 * 背不出的做成卡片）、版本历史都走 ../data/notes/mindmaps 的内存后端。
 *
 * 学习桌面里导图在笔记工作区的标签页中打开；这里直接渲染同一份 MindMapContentView
 * 的独立导图窗口，省掉笔记编辑器（Milkdown）的下载。
 */
import type { DemoAppPack } from '../types';
import { MM_EIGEN_ID, handleDemoMindmaps } from '../data/notes/mindmaps';
import { patchSettingsStrings } from '../data/notes/i18nPatch';

const pack: DemoAppPack = {
  title: '思维导图',
  load: () => import('@/features/workbench/apps/mindmap/MindmapAppWindow').then((m) => m.default),
  instanceKey: MM_EIGEN_ID,
  handle: handleDemoMindmaps,
  namespaces: ['common', 'mindmap', 'workbench', 'app_menu'],
  prepare: patchSettingsStrings,
};

export default pack;
