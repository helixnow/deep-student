/**
 * Learning Hub 学习中心命令
 * 覆盖翻译、作文批改、学习进度等功能
 */

import {
  GraduationCap,
  Languages,
  FileEdit,
  Brain,
  Target,
  TrendingUp,
  BarChart2,
  Calendar,
  Clock,
  CheckCircle2,
  Award,
  BookOpen,
  Lightbulb,
  Repeat,
  Play,
  Pause,
  SkipForward,
  Volume2,
  Eye,
  PenTool,
  FileCheck,
  Clipboard,
  ArrowLeftRight,
  History,
} from 'lucide-react';
import i18next from 'i18next';
import type { Command } from '../registry/types';
import { isLearningCommandEnabled } from '../registry/capabilityRegistry';

// ============================================================================
// 事件名常量 — 命令面板 dispatch / 消费者 addEventListener 共享
// ============================================================================

export const LEARNING_EVENTS = {
  // 翻译
  OPEN_TRANSLATE: 'LEARNING_OPEN_TRANSLATE',
  TRANSLATE_SELECTION: 'LEARNING_TRANSLATE_SELECTION', // TODO: 未实现
  SWITCH_LANGUAGE: 'LEARNING_SWITCH_LANGUAGE', // TODO: 未实现
  // 作文批改
  OPEN_ESSAY_GRADING: 'LEARNING_OPEN_ESSAY_GRADING',
  GRADE_ESSAY: 'LEARNING_GRADE_ESSAY', // TODO: 未实现
  ESSAY_SUGGESTIONS: 'LEARNING_ESSAY_SUGGESTIONS', // TODO: 未实现
  // 学习进度
  SHOW_PROGRESS: 'LEARNING_SHOW_PROGRESS', // TODO: 未实现
  SET_DAILY_GOAL: 'LEARNING_SET_DAILY_GOAL', // TODO: 未实现
  SHOW_STATISTICS: 'LEARNING_SHOW_STATISTICS', // TODO: 未实现
  SHOW_CALENDAR: 'LEARNING_SHOW_CALENDAR', // TODO: 未实现
  MARK_MASTERED: 'LEARNING_MARK_MASTERED', // TODO: 未实现
  SCHEDULE_REVIEW: 'LEARNING_SCHEDULE_REVIEW', // TODO: 未实现
  // 复习模式
  START_REVIEW: 'LEARNING_START_REVIEW', // TODO: 未实现
  PAUSE_REVIEW: 'LEARNING_PAUSE_REVIEW', // TODO: 未实现
  NEXT_ITEM: 'LEARNING_NEXT_ITEM', // TODO: 未实现
  SHOW_ANSWER: 'LEARNING_SHOW_ANSWER', // TODO: 未实现
  // 阅读与朗读
  READ_ALOUD: 'LEARNING_READ_ALOUD', // TODO: 未实现
  FOCUS_MODE: 'LEARNING_FOCUS_MODE', // TODO: 未实现
  // 笔记与标注
  TAKE_NOTES: 'LEARNING_TAKE_NOTES', // TODO: 未实现
  HIGHLIGHT: 'LEARNING_HIGHLIGHT', // TODO: 未实现
  // 成就与激励
  SHOW_ACHIEVEMENTS: 'LEARNING_SHOW_ACHIEVEMENTS', // TODO: 未实现
  SHOW_STREAK: 'LEARNING_SHOW_STREAK', // TODO: 未实现
  // 导入导出
  EXPORT_REPORT: 'LEARNING_EXPORT_REPORT', // TODO: 未实现
  SHOW_HISTORY: 'LEARNING_SHOW_HISTORY', // TODO: 未实现
} as const;

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

/**
 * Learning Hub 命令
 * 使用 i18next.t() + kw() 进行运行时国际化
 */
export const learningCommands: Command[] = [
  // ==================== 翻译功能 ====================
  {
    id: 'learning.translate',
    get name() { return i18next.t('command_palette:commands.learning.translate', 'Open Translator'); },
    get description() { return i18next.t('command_palette:descriptions.learning.translate', 'Launch AI translation workbench'); },
    category: 'learning',
    shortcut: 'mod+t',
    icon: Languages,
    get keywords() { return kw('learning.translate'); },
    priority: 100,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.translate'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.OPEN_TRANSLATE));
    },
  },
  {
    id: 'learning.translate-selection',
    get name() { return i18next.t('command_palette:commands.learning.translate-selection', 'Translate Selection'); },
    get description() { return i18next.t('command_palette:descriptions.learning.translate-selection', 'Translate selected text'); },
    category: 'learning',
    icon: ArrowLeftRight,
    get keywords() { return kw('learning.translate-selection'); },
    priority: 99,
    visibleInViews: ['learning-hub', 'pdf-reader'],
    isEnabled: () => isLearningCommandEnabled('learning.translate-selection'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.TRANSLATE_SELECTION));
    },
  },
  {
    id: 'learning.switch-language-pair',
    get name() { return i18next.t('command_palette:commands.learning.switch-language-pair', 'Switch Language Pair'); },
    get description() { return i18next.t('command_palette:descriptions.learning.switch-language-pair', 'Switch source and target languages'); },
    category: 'learning',
    icon: Repeat,
    get keywords() { return kw('learning.switch-language-pair'); },
    priority: 98,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.switch-language-pair'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SWITCH_LANGUAGE));
    },
  },

  // ==================== 作文批改 ====================
  {
    id: 'learning.essay-grading',
    get name() { return i18next.t('command_palette:commands.learning.essay-grading', 'Open Essay Grading'); },
    get description() { return i18next.t('command_palette:descriptions.learning.essay-grading', 'Launch AI essay grading tool'); },
    category: 'learning',
    icon: FileEdit,
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
    icon: FileCheck,
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

  // ==================== 学习进度 ====================
  {
    id: 'learning.show-progress',
    get name() { return i18next.t('command_palette:commands.learning.show-progress', 'View Learning Progress'); },
    get description() { return i18next.t('command_palette:descriptions.learning.show-progress', 'Open learning progress panel'); },
    category: 'learning',
    icon: TrendingUp,
    get keywords() { return kw('learning.show-progress'); },
    priority: 90,
    isEnabled: () => isLearningCommandEnabled('learning.show-progress'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_PROGRESS));
    },
  },
  {
    id: 'learning.daily-goal',
    get name() { return i18next.t('command_palette:commands.learning.daily-goal', 'Set Daily Goal'); },
    get description() { return i18next.t('command_palette:descriptions.learning.daily-goal', 'Set learning goals'); },
    category: 'learning',
    icon: Target,
    get keywords() { return kw('learning.daily-goal'); },
    priority: 89,
    isEnabled: () => isLearningCommandEnabled('learning.daily-goal'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SET_DAILY_GOAL));
    },
  },
  {
    id: 'learning.statistics',
    get name() { return i18next.t('command_palette:commands.learning.statistics', 'Learning Statistics'); },
    get description() { return i18next.t('command_palette:descriptions.learning.statistics', 'View detailed learning statistics'); },
    category: 'learning',
    icon: BarChart2,
    get keywords() { return kw('learning.statistics'); },
    priority: 88,
    isEnabled: () => isLearningCommandEnabled('learning.statistics'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_STATISTICS));
    },
  },
  {
    id: 'learning.calendar',
    get name() { return i18next.t('command_palette:commands.learning.calendar', 'Learning Calendar'); },
    get description() { return i18next.t('command_palette:descriptions.learning.calendar', 'View learning calendar and records'); },
    category: 'learning',
    icon: Calendar,
    get keywords() { return kw('learning.calendar'); },
    priority: 87,
    isEnabled: () => isLearningCommandEnabled('learning.calendar'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_CALENDAR));
    },
  },

  {
    id: 'learning.mark-mastered',
    get name() { return i18next.t('command_palette:commands.learning.mark-mastered', 'Mark as Mastered'); },
    get description() { return i18next.t('command_palette:descriptions.learning.mark-mastered', 'Mark current knowledge point as mastered'); },
    category: 'learning',
    icon: CheckCircle2,
    get keywords() { return kw('learning.mark-mastered'); },
    priority: 84,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.mark-mastered'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.MARK_MASTERED));
    },
  },
  {
    id: 'learning.schedule-review',
    get name() { return i18next.t('command_palette:commands.learning.schedule-review', 'Schedule Review'); },
    get description() { return i18next.t('command_palette:descriptions.learning.schedule-review', 'Add current content to review schedule'); },
    category: 'learning',
    icon: Clock,
    get keywords() { return kw('learning.schedule-review'); },
    priority: 83,
    isEnabled: () => isLearningCommandEnabled('learning.schedule-review'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SCHEDULE_REVIEW));
    },
  },

  // ==================== 复习模式 ====================
  {
    id: 'learning.start-review',
    get name() { return i18next.t('command_palette:commands.learning.start-review', 'Start Review'); },
    get description() { return i18next.t('command_palette:descriptions.learning.start-review', 'Enter review mode'); },
    category: 'learning',
    shortcut: 'mod+shift+v',
    icon: Play,
    get keywords() { return kw('learning.start-review'); },
    priority: 80,
    isEnabled: () => isLearningCommandEnabled('learning.start-review'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.START_REVIEW));
    },
  },
  {
    id: 'learning.pause-review',
    get name() { return i18next.t('command_palette:commands.learning.pause-review', 'Pause Review'); },
    get description() { return i18next.t('command_palette:descriptions.learning.pause-review', 'Pause current review session'); },
    category: 'learning',
    icon: Pause,
    get keywords() { return kw('learning.pause-review'); },
    priority: 79,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.pause-review'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.PAUSE_REVIEW));
    },
  },
  {
    id: 'learning.next-item',
    get name() { return i18next.t('command_palette:commands.learning.next-item', 'Next Item'); },
    get description() { return i18next.t('command_palette:descriptions.learning.next-item', 'Go to next review item'); },
    category: 'learning',
    shortcut: 'space',
    icon: SkipForward,
    get keywords() { return kw('learning.next-item'); },
    priority: 78,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.next-item'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.NEXT_ITEM));
    },
  },
  {
    id: 'learning.show-answer',
    get name() { return i18next.t('command_palette:commands.learning.show-answer', 'Show Answer'); },
    get description() { return i18next.t('command_palette:descriptions.learning.show-answer', 'Show answer for current question'); },
    category: 'learning',
    icon: Eye,
    get keywords() { return kw('learning.show-answer'); },
    priority: 77,
    visibleInViews: ['learning-hub'],
    isEnabled: () => isLearningCommandEnabled('learning.show-answer'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_ANSWER));
    },
  },

  // ==================== 阅读与朗读 ====================
  {
    id: 'learning.read-aloud',
    get name() { return i18next.t('command_palette:commands.learning.read-aloud', 'Read Aloud'); },
    get description() { return i18next.t('command_palette:descriptions.learning.read-aloud', 'Use TTS to read current content'); },
    category: 'learning',
    icon: Volume2,
    get keywords() { return kw('learning.read-aloud'); },
    priority: 70,
    visibleInViews: ['learning-hub', 'pdf-reader'],
    isEnabled: () => isLearningCommandEnabled('learning.read-aloud'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.READ_ALOUD));
    },
  },
  {
    id: 'learning.focus-mode',
    get name() { return i18next.t('command_palette:commands.learning.focus-mode', 'Focus Reading Mode'); },
    get description() { return i18next.t('command_palette:descriptions.learning.focus-mode', 'Enter focus reading mode'); },
    category: 'learning',
    icon: BookOpen,
    get keywords() { return kw('learning.focus-mode'); },
    priority: 69,
    isEnabled: () => isLearningCommandEnabled('learning.focus-mode'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.FOCUS_MODE));
    },
  },

  // ==================== 笔记与标注 ====================
  {
    id: 'learning.take-notes',
    get name() { return i18next.t('command_palette:commands.learning.take-notes', 'Quick Notes'); },
    get description() { return i18next.t('command_palette:descriptions.learning.take-notes', 'Add notes to current content'); },
    category: 'learning',
    shortcut: 'mod+shift+l',
    icon: PenTool,
    get keywords() { return kw('learning.take-notes'); },
    priority: 65,
    visibleInViews: ['learning-hub', 'pdf-reader'],
    isEnabled: () => isLearningCommandEnabled('learning.take-notes'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.TAKE_NOTES));
    },
  },
  {
    id: 'learning.highlight',
    get name() { return i18next.t('command_palette:commands.learning.highlight', 'Highlight'); },
    get description() { return i18next.t('command_palette:descriptions.learning.highlight', 'Highlight selected text'); },
    category: 'learning',
    icon: PenTool,
    get keywords() { return kw('learning.highlight'); },
    priority: 64,
    visibleInViews: ['learning-hub', 'pdf-reader'],
    isEnabled: () => isLearningCommandEnabled('learning.highlight'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.HIGHLIGHT));
    },
  },

  // ==================== 成就与激励 ====================
  {
    id: 'learning.achievements',
    get name() { return i18next.t('command_palette:commands.learning.achievements', 'View Achievements'); },
    get description() { return i18next.t('command_palette:descriptions.learning.achievements', 'View learning achievements and badges'); },
    category: 'learning',
    icon: Award,
    get keywords() { return kw('learning.achievements'); },
    priority: 60,
    isEnabled: () => isLearningCommandEnabled('learning.achievements'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_ACHIEVEMENTS));
    },
  },
  {
    id: 'learning.streak',
    get name() { return i18next.t('command_palette:commands.learning.streak', 'View Learning Streak'); },
    get description() { return i18next.t('command_palette:descriptions.learning.streak', 'View consecutive learning days'); },
    category: 'learning',
    icon: TrendingUp,
    get keywords() { return kw('learning.streak'); },
    priority: 59,
    isEnabled: () => isLearningCommandEnabled('learning.streak'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_STREAK));
    },
  },

  // ==================== 导入导出 ====================
  {
    id: 'learning.export-progress',
    get name() { return i18next.t('command_palette:commands.learning.export-progress', 'Export Progress Report'); },
    get description() { return i18next.t('command_palette:descriptions.learning.export-progress', 'Export learning progress report'); },
    category: 'learning',
    icon: Clipboard,
    get keywords() { return kw('learning.export-progress'); },
    priority: 50,
    isEnabled: () => isLearningCommandEnabled('learning.export-progress'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.EXPORT_REPORT));
    },
  },
  {
    id: 'learning.history',
    get name() { return i18next.t('command_palette:commands.learning.history', 'Learning History'); },
    get description() { return i18next.t('command_palette:descriptions.learning.history', 'View learning history records'); },
    category: 'learning',
    icon: History,
    get keywords() { return kw('learning.history'); },
    priority: 49,
    isEnabled: () => isLearningCommandEnabled('learning.history'),
    execute: () => {
      window.dispatchEvent(new CustomEvent(LEARNING_EVENTS.SHOW_HISTORY));
    },
  },
];
