/**
 * 作文批改（官网 /user-guide/essay）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '作文批改',
  load: () => import('@/features/workbench/apps/content/ContentAppWindow').then((m) => m.createContentWindowComponent('essay')),
};

export default pack;
