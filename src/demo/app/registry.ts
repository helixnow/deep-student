/**
 * 单应用演示目录：id = 官网用户指南章节 slug（ds-web docs/user-guide/<id>.md）。
 * 官网据此给每章嵌演示；烟测与海报截图逐个跑这张表。
 */
import type { DemoAppEntry } from './types';

export const DEMO_APPS: DemoAppEntry[] = [
  { id: 'flashcards', height: 640, pack: () => import('./packs/flashcards') },
];
