/**
 * Learning Hub 学习中心命令
 *
 * 仅保留有真实 window 事件消费者的动作。无监听的命令不得出现在面板中
 * （点击无反应 = 禁止）。历史空壳已于 2026-07-20 删除，勿再加 TODO stub。
 */

import {
  Translate,
  NotePencil,
  Lightbulb,
  FileText,
} from '@phosphor-icons/react';
import i18next from 'i18next';
import type { Command } from '../registry/types';
import { isLearningCommandEnabled } from '../registry/capabilityRegistry';

// ============================================================================
// 事件名常量 — 命令面板 dispatch / 消费者 addEventListener 共享
// ============================================================================

export const LEARNING_EVENTS = {
  OPEN_TRANSLATE: 'LEARNING_OPEN_TRANSLATE', // → useLearningHubEvents
  OPEN_ESSAY_GRADING: 'LEARNING_OPEN_ESSAY_GRADING', // → useLearningHubEvents
  GRADE_ESSAY: 'LEARNING_GRADE_ESSAY', // → EssayGradingWorkbench
  ESSAY_SUGGESTIONS: 'LEARNING_ESSAY_SUGGESTIONS', // → EssayGradingWorkbench
} as const;

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

/**
 * Learning Hub 命令
 * 使用 i18next.t() + kw() 进行运行时国际化
 */
export const learningCommands: Command[] = [
  {
    id: 'learning.translate',
    get name() { return i18next.t('command_palette:commands.learning.translate', 'Open Translator'); },
    get description() { return i18next.t('command_palette:descriptions.learning.translate', 'Launch AI translation workbench'); },
    category: 'learning',
    shortcut: 'mod+t',
    icon: Translate,
    get keywords() { return kw('learning.translate'); },
    priority: 100,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.translate'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.OPEN_TRANSLATE));
    },
  },
  {
    id: 'learning.essay-grading',
    get name() { return i18next.t('command_palette:commands.learning.essay-grading', 'Open Essay Grading'); },
    get description() { return i18next.t('command_palette:descriptions.learning.essay-grading', 'Launch AI essay grading tool'); },
    category: 'learning',
    icon: NotePencil,
    get keywords() { return kw('learning.essay-grading'); },
    priority: 95,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.essay-grading'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.OPEN_ESSAY_GRADING));
    },
  },
  {
    id: 'learning.grade-essay',
    get name() { return i18next.t('command_palette:commands.learning.grade-essay', 'Grade Essay'); },
    get description() { return i18next.t('command_palette:descriptions.learning.grade-essay', 'AI grade current essay'); },
    category: 'learning',
    shortcut: 'mod+g',
    icon: FileText,
    get keywords() { return kw('learning.grade-essay'); },
    priority: 94,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.grade-essay'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.GRADE_ESSAY));
    },
  },
  {
    id: 'learning.essay-suggestions',
    get name() { return i18next.t('command_palette:commands.learning.essay-suggestions', 'Get Suggestions'); },
    get description() { return i18next.t('command_palette:descriptions.learning.essay-suggestions', 'Get essay improvement suggestions'); },
    category: 'learning',
    icon: Lightbulb,
    get keywords() { return kw('learning.essay-suggestions'); },
    priority: 93,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.essay-suggestions'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.ESSAY_SUGGESTIONS));
    },
  },
];
