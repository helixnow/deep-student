/**
 * 第 12 章「Anki 制卡与模板」：「Anki 制卡」任务看板——一个任务正在生成卡片、一个有失败分段、
 * 一个已暂停，其余已完成；展开任务能看到生成的卡片（问答 / 填空 / 单词 / 公式模板）。
 * 看板里的「管理模板」切到同一窗口的模板库（可编辑、设默认、新建）。
 * 导出 APKG / 同步到 Anki 需要本机文件与 AnkiConnect，演示里给出桌面版提示。
 */
import type { DemoAppPack } from '../types';
import { handleAnki } from './anki/backend';
import { patchPracticeStrings } from '../data/practice/i18nPatch';

const pack: DemoAppPack = {
  title: 'Anki 制卡与模板',
  load: () => import('./anki/AnkiDemo').then((m) => m.default),
  handle: handleAnki,
  namespaces: ['anki', 'template', 'workbench', 'app_menu', 'sidebar'],
  prepare: patchPracticeStrings,
};

export default pack;
