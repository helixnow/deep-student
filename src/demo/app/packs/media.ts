/**
 * 音视频（官网 /user-guide/media）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '音视频',
  load: () => import('@/features/workbench/apps/system/MediaStudioAppWindow').then((m) => m.default),
};

export default pack;
