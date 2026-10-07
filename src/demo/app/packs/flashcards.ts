/**
 * 第 15 章「闪卡」：闪卡应用窗口，卡片库是一套「高等数学 · 错题本」，三张今天到期。
 * 复习、评分、统计、记忆曲线都走 ../flashcards 的内存 FSRS-6 后端（与学习桌面演示同一份）。
 */
import type { DemoAppPack } from '../types';
import { handleDemoFlashcards } from '../../flashcards';

const pack: DemoAppPack = {
  title: '闪卡',
  load: () => import('@/features/workbench/apps/system/FlashcardsAppWindow').then((m) => m.default),
  handle: handleDemoFlashcards,
  namespaces: ['flashcards', 'workbench', 'app_menu', 'sidebar'],
};

export default pack;
