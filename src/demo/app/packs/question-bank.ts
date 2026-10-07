/**
 * 题目集与练习（官网 /user-guide/question-bank）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '题目集与练习',
  load: () => import('@/features/workbench/apps/content/ContentAppWindow').then((m) => m.createContentWindowComponent('exam')),
};

export default pack;
