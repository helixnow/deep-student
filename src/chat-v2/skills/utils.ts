/**
 * Chat V2 - Skills 共享工具函数
 *
 * 提供技能模块的通用工具函数，避免循环依赖。
 * 此文件不应从 ./index.ts 或 ./components/* 导入。
 */

import type { SkillLocation } from './types';

/**
 * 获取位置标签
 */
export function getLocationLabel(location: SkillLocation, t: (key: string) => string): string {
  switch (location) {
    case 'global':
      return t('skills:location.global');
    case 'project':
      return t('skills:location.project');
    case 'builtin':
      return t('skills:location.builtin');
    default:
      return '';
  }
}

/**
 * 获取位置样式
 */
export function getLocationStyle(location: SkillLocation): string {
  switch (location) {
    case 'global':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    case 'project':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'builtin':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400';
  }
}

/**
 * 获取技能的本地化名称
 *
 * 优先使用 i18n 翻译（skills:builtinNames.<id>），回退到 skill.name。
 * 统一提取避免在各组件中重复定义。
 *
 * @param skillId 技能 ID
 * @param skillName 技能原始名称（回退值）
 * @param t i18n 翻译函数
 * @returns 本地化后的技能名称
 */
export function getLocalizedSkillName(
  skillId: string,
  skillName: string,
  t: (key: string, options?: { defaultValue?: string }) => string
): string {
  const translatedName = t(`skills:builtinNames.${skillId}`, { defaultValue: '' });
  return translatedName || skillName;
}

/**
 * 获取技能的本地化描述
 *
 * 优先使用 i18n 翻译（skills:builtinDescriptions.<id>），回退到 skill.description。
 */
export function getLocalizedSkillDescription(
  skillId: string,
  description: string,
  t: (key: string, options?: { defaultValue?: string }) => string
): string {
  const translatedDescription = t(`skills:builtinDescriptions.${skillId}`, { defaultValue: '' });
  return translatedDescription || description;
}
