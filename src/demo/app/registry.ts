/**
 * 单应用演示目录：id = 官网用户指南章节 slug（ds-web docs/user-guide/<id>.md）。
 * 官网据此给每章嵌演示；烟测与海报截图逐个跑这张表。
 *
 * 学习桌面（workbench）与移动端（mobile）两章不在这里：它们演示的就是整个壳，
 * 官网直接嵌 demo.html?desktop=1 与手机宽度的 demo.html。
 */
import type { DemoAppEntry } from './types';

export const DEMO_APPS: DemoAppEntry[] = [
  { id: 'chat', height: 680, pack: () => import('./packs/chat') },
  { id: 'research-memory', height: 680, pack: () => import('./packs/research-memory') },
  { id: 'learning-hub', height: 640, pack: () => import('./packs/learning-hub') },
  { id: 'reading-translation', height: 680, pack: () => import('./packs/reading-translation') },
  { id: 'paper-search', height: 680, pack: () => import('./packs/paper-search') },
  { id: 'media', height: 660, pack: () => import('./packs/media') },
  { id: 'notes', height: 660, pack: () => import('./packs/notes') },
  { id: 'mindmap', height: 640, pack: () => import('./packs/mindmap') },
  { id: 'essay', height: 680, pack: () => import('./packs/essay') },
  { id: 'productivity', height: 620, pack: () => import('./packs/productivity') },
  { id: 'question-bank', height: 660, pack: () => import('./packs/question-bank') },
  { id: 'anki', height: 640, pack: () => import('./packs/anki') },
  { id: 'flashcards', height: 640, pack: () => import('./packs/flashcards') },
  { id: 'models', height: 660, pack: () => import('./packs/models') },
  { id: 'skills-mcp', height: 640, pack: () => import('./packs/skills-mcp') },
  { id: 'data-sync', height: 660, pack: () => import('./packs/data-sync') },
];

/**
 * 演示整个壳的两章：官网嵌 demo.html（对话演示的入口）。烟测与海报也覆盖它们；
 * width 给了就按这个宽度拍海报、官网用手机尺寸的框。
 */
export const SHELL_DEMOS: Array<{ id: string; title: string; height: number; width?: number; entry: string }> = [
  { id: 'workbench', title: '学习桌面', height: 700, entry: 'demo.html?desktop=1' },
  { id: 'mobile', title: '移动端', height: 780, width: 390, entry: 'demo.html' },
];
