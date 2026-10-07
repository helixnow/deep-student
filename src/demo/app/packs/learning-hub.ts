/**
 * 资源库（官网 /user-guide/learning-hub）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '资源库',
  load: () => import('@/features/workbench/apps/files/FilesAppWindow').then((m) => m.default),
};

export default pack;
