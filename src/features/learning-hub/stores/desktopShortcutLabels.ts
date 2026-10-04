/**
 * 桌面预设快捷方式的本地化标签
 *
 * 预设快捷方式（笔记/题目集/作文批改/翻译/思维导图 + 快捷入口）早期把创建时
 * 当前语言的翻译结果直接持久化到 `name`，切换界面语言后图标仍显示旧语言。
 * 现在预设快捷方式持久化稳定身份 `presetKey`（= learningHub 命名空间的 i18n key），
 * 展示时按当前语言实时解析；用户重命名后清除 `presetKey`，用户文本优先。
 *
 * `LEGACY_DEFAULT_NAMES` 是历史上各语言/版本写入过的默认名称（小常量表，避免把
 * 两份完整 locale JSON 拉进主包），用于持久化迁移时识别「未被用户改过名」的预设。
 */

import { useEffect, useReducer } from 'react';
import i18next from 'i18next';

export const DESKTOP_PRESET_LABEL_NS = 'learningHub';

/** 预设标签 i18n key → 英文兜底 + 历史默认名称（zh-CN / en-US / 代码兜底） */
const PRESET_LABELS = {
  'resourceType.note': {
    fallback: 'Notes',
    legacy: ['笔记', 'Notes', 'Note'],
  },
  'resourceType.exam': {
    fallback: 'Question Sets',
    legacy: ['题目集', 'Question Sets', 'Question Set'],
  },
  'resourceType.essay': {
    fallback: 'Essay Grading',
    legacy: ['作文批改', '作文', 'Essay Grading', 'Essays', 'Essay'],
  },
  'resourceType.translation': {
    fallback: 'Translations',
    legacy: ['翻译', 'Translations', 'Translation'],
  },
  'resourceType.mindmap': {
    fallback: 'Mind Maps',
    // zh-CN 曾为「知识导图」（ea02573b2 统一为「思维导图」）
    legacy: ['思维导图', '知识导图', '导图', 'Mind Maps', 'Mind Map'],
  },
  'desktop.presets.allNotes': {
    fallback: 'All Notes',
    legacy: ['全部笔记', 'All Notes'],
  },
  'desktop.presets.allExams': {
    fallback: 'All Question Sets',
    legacy: ['全部题目集', 'All Question Sets', 'All Exams'],
  },
  'desktop.presets.allEssays': {
    fallback: 'All Essays',
    legacy: ['全部作文', 'All Essays'],
  },
  'desktop.presets.allTranslations': {
    fallback: 'All Translations',
    legacy: ['全部翻译', 'All Translations'],
  },
  'desktop.presets.mindmaps': {
    fallback: 'Mind Maps',
    legacy: ['思维导图', '知识导图', 'Mind Maps'],
  },
  'desktop.presets.favorites': {
    fallback: 'Favorites',
    legacy: ['收藏', 'Favorites'],
  },
  'desktop.presets.recentAccess': {
    fallback: 'Recent',
    legacy: ['最近访问', 'Recent', 'Recent Access'],
  },
} as const satisfies Record<string, { fallback: string; legacy: readonly string[] }>;

export type DesktopPresetKey = keyof typeof PRESET_LABELS;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function isDesktopPresetKey(value: unknown): value is DesktopPresetKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRESET_LABELS, value);
}

/** 预设标签的英文兜底（i18n 资源未就绪时使用） */
export function getPresetLabelFallback(key: DesktopPresetKey): string {
  return PRESET_LABELS[key].fallback;
}

/**
 * 判断持久化的名称是否为该预设在任一语言/历史版本下的默认名称
 * （即用户未改过名）。原始 i18n key 也视为默认（i18n 未初始化时的产物）。
 */
export function isLegacyDefaultPresetName(key: DesktopPresetKey, name: string): boolean {
  if (typeof name !== 'string') return false;
  const normalized = normalizeName(name);
  if (!normalized) return false;
  if (normalized === normalizeName(key)) return true;
  return PRESET_LABELS[key].legacy.some((candidate) => normalizeName(candidate) === normalized);
}

/** 按当前语言翻译预设标签；资源未就绪时退回 `stored`（持久化名称）或英文兜底 */
export function translatePresetLabel(key: DesktopPresetKey, stored?: string): string {
  const defaultValue = stored || PRESET_LABELS[key].fallback;
  try {
    const label = i18next.t(key, { ns: DESKTOP_PRESET_LABEL_NS, defaultValue });
    return typeof label === 'string' && label ? label : defaultValue;
  } catch {
    return defaultValue;
  }
}

/** 快捷方式展示名：预设（未被改名）跟随当前语言，其余返回持久化名称 */
export function resolveShortcutName(shortcut: { name: string; presetKey?: string }): string {
  if (isDesktopPresetKey(shortcut.presetKey)) {
    return translatePresetLabel(shortcut.presetKey, shortcut.name);
  }
  return shortcut.name;
}

/**
 * 订阅 i18next 语言切换与资源包懒加载（'added'），触发重渲染。
 * 不依赖 react-i18next：预设标签解析直接走 i18next 单例。
 */
function useI18nLabelRefresh(enabled: boolean): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = () => bump();
    i18next.on('languageChanged', handler);
    const store = i18next.store;
    store?.on('added', handler);
    return () => {
      i18next.off('languageChanged', handler);
      store?.off('added', handler);
    };
  }, [enabled]);
}

/** 组件内获取快捷方式展示名（语言切换时实时更新，无需刷新） */
export function useDesktopShortcutName(shortcut: { name: string; presetKey?: string }): string {
  useI18nLabelRefresh(isDesktopPresetKey(shortcut.presetKey));
  return resolveShortcutName(shortcut);
}
