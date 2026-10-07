/**
 * 第 11 章「题目集与练习」：题目集窗口，打开「高等数学 · 极限与导数」。
 * 题目、作答判分、错题、知识点、统计、复习计划走 ./question-bank/backend 的内存后端。
 */
import type { DemoAppPack } from '../types';
import { handleQuestionBank } from './question-bank/backend';
import { QB_MAIN_ID } from './question-bank/data';
import { patchPracticeStrings } from '../data/practice/i18nPatch';

const pack: DemoAppPack = {
  title: '题目集与练习',
  load: () => import('./question-bank/QuestionBankDemo').then((m) => m.default),
  instanceKey: QB_MAIN_ID,
  handle: handleQuestionBank,
  namespaces: ['exam_sheet', 'learningHub', 'review', 'practice', 'workbench', 'dstu', 'stats', 'app_menu'],
  prepare: patchPracticeStrings,
};

export default pack;
