/**
 * 文档阅读与翻译（官网 /user-guide/reading-translation）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '文档阅读与翻译',
  load: () => import('@/features/workbench/apps/content/ContentAppWindow').then((m) => m.createContentWindowComponent('textbook')),
};

export default pack;
